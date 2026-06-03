// `kova attach <run-id>` — SSE client that snapshots + live-tails a fix run.
//
// Borrowed from tmux: attach-session.c looks up the session, then subscribes
// to its event stream. Same shape here — we look the run up in the
// RunRegistry, resolve the `fixId`, then open an HTTP GET against the
// running kova webhook-server's `/events?fixId=<fixId>` endpoint. The server
// (services/event-bus/sse.ts) replays the per-fix ring buffer synchronously
// before streaming live events, so a fresh attach sees recent state and
// then continues live.
//
// Lifecycle:
//   - Closing the client (SIGINT / AbortController) just closes the HTTP
//     connection. The server's req.on('close') in sse.ts unsubscribes us
//     and keeps the run, the daemon, and the bus untouched. This is the
//     "detach" semantic from the issue spec — no separate command needed.
//   - The SSE frame parser is exposed (parseSseFrames) so it's unit-testable
//     without spinning up a server. The integration test does both.
//   - The renderer (formatEventLine) is one line per event so the output is
//     greppable + tmux-friendly. JSON mode is selected by passing
//     `onEvent` directly; the CLI wrapper handles the --json flag.

import http from 'node:http';
import type { KovaEvent } from '../services/event-bus/schema.js';
import { getRun } from '../services/run-registry.js';

export interface AttachOptions {
  /** Run id to look up in the RunRegistry. */
  runId: string;
  /** Repo path containing the .kova/runs/ directory. */
  repoPath: string;
  /** Host of the running kova daemon (default 127.0.0.1). */
  host?: string;
  /** Port of the running kova daemon. */
  port: number;
  /** Called for each parsed event. */
  onEvent: (event: KovaEvent) => void;
  /** Optional AbortSignal — abort() closes the connection cleanly. */
  signal?: AbortSignal;
}

export interface SseParseResult {
  events: Array<Record<string, unknown>>;
  remainder: string;
}

/**
 * Parse a string buffer of SSE wire bytes into structured event objects.
 * Returns any unconsumed tail in `remainder` so chunked streams can resume
 * parsing without losing partial frames.
 *
 * Recognizes:
 *   - `event: <name>\ndata: <json>\n\n`  → emits the parsed JSON
 *   - `: comment\n\n`                    → ignored (heartbeats, connect notes)
 * Malformed `data:` payloads are skipped, not raised — a noisy server must
 * not crash the client.
 */
export function parseSseFrames(buffer: string): SseParseResult {
  const events: Array<Record<string, unknown>> = [];
  // SSE frames are separated by a blank line (`\n\n`). Anything before the
  // last `\n\n` is a complete frame; anything after is the remainder.
  let cursor = 0;
  while (cursor < buffer.length) {
    const sep = buffer.indexOf('\n\n', cursor);
    if (sep === -1) break;
    const frame = buffer.slice(cursor, sep);
    cursor = sep + 2;
    // Heartbeats and connect notes start with ':'
    if (frame.startsWith(':')) continue;
    // Find the data: line
    const dataMatch = frame.match(/(?:^|\n)data:\s?(.*)$/);
    if (!dataMatch?.[1]) continue;
    try {
      events.push(JSON.parse(dataMatch[1]) as Record<string, unknown>);
    } catch {
      // Drop malformed frames silently — a misbehaving publisher must not
      // crash the client. Use --json mode for diagnostic visibility.
    }
  }
  return { events, remainder: buffer.slice(cursor) };
}

/**
 * Render one KovaEvent as a single human-friendly line. Verbose payload is
 * compressed; consumers wanting full fidelity should pass `--json` to the CLI
 * (which bypasses this formatter and writes raw event JSON).
 */
export function formatEventLine(event: KovaEvent): string {
  const ts = event.timestamp.slice(11, 19); // HH:MM:SS
  const seq = String(event.seq).padStart(4, ' ');
  const base = `${ts} #${seq} ${event.type}`;
  switch (event.type) {
    case 'fix-started':
      return `${base}  issue=#${event.issueNumber ?? '?'}  fix=${event.fixId}`;
    case 'wave-enter':
      return `${base}  wave=${event.wave}`;
    case 'wave-output': {
      const cost = event.costDelta != null ? `  $${event.costDelta.toFixed(4)}` : '';
      const text = event.text ? `  ${event.text}` : '';
      return `${base}  wave=${event.wave}  turn=${event.turn}${cost}${text}`;
    }
    case 'cost':
      return `${base}  wave=${event.wave}  $${event.costUsd.toFixed(4)}`;
    case 'steered':
      return `${base}  wave=${event.wave}  tier=${event.tier}  ratio=${event.usageRatio.toFixed(2)}`;
    case 'aborted':
      return `${base}  wave=${event.wave}  reason=${event.reason}`;
    case 'fix-done':
      return `${base}  outcome=${event.outcome}  $${event.totalCostUsd.toFixed(4)}${event.prNumber != null ? `  pr=#${event.prNumber}` : ''}`;
    default: {
      // Exhaustiveness — TypeScript proves we've covered every variant; if a
      // new event type is added without updating this switch the type checker
      // catches it. At runtime, fall back to a JSON-y representation.
      const exhaustive: never = event;
      return `${ts} ${(exhaustive as { type: string }).type ?? 'unknown'}`;
    }
  }
}

/**
 * Open an SSE connection to the kova daemon and stream events for `runId`.
 * Resolves when the server closes the stream or when `signal` is aborted.
 * Rejects when the run is missing from the registry or the HTTP connection
 * fails to establish.
 */
export function attach(options: AttachOptions): Promise<void> {
  const { runId, repoPath, host = '127.0.0.1', port, onEvent, signal } = options;
  return new Promise((resolve, reject) => {
    void getRun(repoPath, runId).then((run) => {
      if (!run) {
        reject(new Error(`run not found: ${runId}`));
        return;
      }
      if (signal?.aborted) {
        resolve();
        return;
      }
      const req = http.request(
        {
          host,
          port,
          method: 'GET',
          path: `/events?fixId=${encodeURIComponent(run.fixId)}`,
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            // Drain to free the socket, then reject.
            res.resume();
            reject(new Error(`SSE handshake failed: HTTP ${res.statusCode ?? '?'}`));
            return;
          }
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            const { events, remainder } = parseSseFrames(buffer);
            buffer = remainder;
            for (const e of events) {
              // The server is the trust boundary — events are already
              // Zod-validated on publish. Cast through unknown to KovaEvent.
              onEvent(e as unknown as KovaEvent);
            }
          });
          res.on('end', () => resolve());
          res.on('error', (err) => reject(err));
        },
      );
      req.on('error', (err) => {
        // Abort() on the underlying socket surfaces as ECONNRESET — treat
        // that as a clean detach, not an error.
        if (signal?.aborted) {
          resolve();
          return;
        }
        reject(err);
      });
      if (signal) {
        const onAbort = (): void => {
          // destroy() with no error triggers a clean close; the response
          // 'end' handler resolves the promise.
          req.destroy();
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      req.end();
    }, reject);
  });
}
