// Daemon server (issue #291).
//
// Borrowed from tmux: a single persistent process bound to a unix-domain
// socket owns all session state and survives every client disconnect. Closing
// the terminal that started the daemon does NOT kill the in-flight work.
//
// Wire protocol: newline-delimited JSON. Every command produces exactly one
// reply line. The server speaks three commands:
//
//   { cmd: 'submit',   request: FixRequest }   -> { ok, queued }
//   { cmd: 'status'                       }    -> { ok, queued, running, pid }
//   { cmd: 'shutdown'                     }    -> { ok }                 (drains)
//
// The snapshot file (services/daemon-snapshot.ts) is rewritten after every
// queue mutation so a fresh process can pick up where the previous one left
// off — the "Snapshot persisted + reloaded on restart" acceptance criterion.

import { unlink } from 'node:fs/promises';
import net from 'node:net';
import { log } from '../utils/logger.js';
import { type DaemonSnapshot, loadSnapshot, saveSnapshot } from './daemon-snapshot.js';
import { createFixQueue, type FixQueue, type FixRequest } from './fix-queue.js';
import type { LiveFixRegistry } from './live-fix-registry.js';

export interface DaemonServerOptions {
  /** Absolute path of the unix-domain socket the daemon listens on. */
  socketPath: string;
  /** Home directory used to resolve the snapshot file (~/.kova/daemon-snapshot.json). */
  homeDir: string;
  /** Handler invoked for each enqueued FixRequest. */
  handler: (req: FixRequest) => Promise<void>;
  /**
   * Issue #294 — optional LiveFixRegistry used to route `steer` / `abort`
   * RPC commands to live wave handles. When omitted, those commands return
   * `ok:false` with a clear error rather than crashing — preserves backward
   * compatibility with callers that don't wire send-keys steering.
   */
  liveFixRegistry?: LiveFixRegistry;
}

export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns the active socket path (matches options.socketPath). */
  address(): string;
}

interface Reply {
  ok: boolean;
  [k: string]: unknown;
}

/**
 * Type guards over the parsed JSON request — we accept `unknown` at the
 * socket boundary and refine before dispatching.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFixRequest(v: unknown): v is FixRequest {
  if (!isRecord(v)) return false;
  return typeof v.issueNumber === 'number' && typeof v.repoPath === 'string' && typeof v.repoName === 'string';
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const { socketPath, homeDir, handler, liveFixRegistry } = options;
  let server: net.Server | undefined;
  let queue: FixQueue | undefined;
  // Track in-flight requests for snapshotting. Same FixRequest reference is
  // pulled from `pending` and put here before the handler runs.
  const inFlight = new Set<FixRequest>();
  // Backing array we use to "peek" pending entries for the snapshot —
  // FixQueue doesn't expose its internal list, so we shadow it here.
  const pendingShadow: FixRequest[] = [];

  // Track every in-flight snapshot write so stop() can await all of them
  // before letting the caller tear down the snapshot directory.
  const pendingPersists = new Set<Promise<void>>();

  async function persistSnapshot(): Promise<void> {
    const snap: DaemonSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      pending: [...pendingShadow],
      inFlight: [...inFlight],
    };
    const p = (async (): Promise<void> => {
      try {
        await saveSnapshot(homeDir, snap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[daemon] snapshot write failed: ${msg}`);
      }
    })();
    pendingPersists.add(p);
    p.finally(() => pendingPersists.delete(p));
    await p;
  }

  function dispatchHandler(req: FixRequest): Promise<void> {
    inFlight.add(req);
    void persistSnapshot();
    return handler(req).finally(() => {
      inFlight.delete(req);
      void persistSnapshot();
    });
  }

  function enqueue(req: FixRequest): number {
    pendingShadow.push(req);
    void persistSnapshot();
    // Wrap the handler so we shift pendingShadow as the queue does.
    queue?.enqueue(req);
    return pendingShadow.length + inFlight.size;
  }

  function handleConnection(socket: net.Socket): void {
    let buf = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let reply: Reply;
        try {
          const parsed = JSON.parse(line) as unknown;
          reply = handleCommand(parsed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          reply = { ok: false, error: `parse error: ${msg}` };
        }
        socket.write(`${JSON.stringify(reply)}\n`);
        // If this was a shutdown command, drain after replying.
        if (reply.ok === true && isRecord(reply) && (reply as Record<string, unknown>).cmd === 'shutdown') {
          socket.end();
        }
        nl = buf.indexOf('\n');
      }
    });
    socket.on('error', () => {
      /* client disconnected — non-fatal */
    });
  }

  function handleCommand(parsed: unknown): Reply {
    if (!isRecord(parsed) || typeof parsed.cmd !== 'string') {
      return { ok: false, error: 'invalid command shape' };
    }
    switch (parsed.cmd) {
      case 'submit': {
        if (!isFixRequest(parsed.request)) {
          return { ok: false, error: 'invalid request shape' };
        }
        const queued = enqueue(parsed.request);
        return { ok: true, queued };
      }
      case 'status': {
        return {
          ok: true,
          queued: pendingShadow.length + inFlight.size,
          running: queue?.isRunning() === true,
          pid: process.pid,
        };
      }
      case 'shutdown': {
        // Defer the actual stop until after we've replied; the connection
        // listener will see the cmd:'shutdown' marker on the reply object.
        setImmediate(() => {
          void stopInternal();
        });
        return { ok: true, cmd: 'shutdown' };
      }
      // Issue #294: send-keys-style steering — route `steer` and `abort` to
      // the optional LiveFixRegistry. Both commands return ok:false with a
      // clear error when no registry is wired or the fixId is not running,
      // so the CLI surfaces actionable feedback without ambiguity.
      case 'steer': {
        if (!liveFixRegistry) {
          return { ok: false, error: 'steer not supported: daemon has no live-fix registry wired' };
        }
        if (typeof parsed.fixId !== 'string' || typeof parsed.hint !== 'string') {
          return { ok: false, error: 'steer requires { fixId: string, hint: string }' };
        }
        try {
          liveFixRegistry.steer(parsed.fixId, parsed.hint);
          return { ok: true, steered: true, fixId: parsed.fixId };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg };
        }
      }
      case 'abort': {
        if (!liveFixRegistry) {
          return { ok: false, error: 'abort not supported: daemon has no live-fix registry wired' };
        }
        if (typeof parsed.fixId !== 'string') {
          return { ok: false, error: 'abort requires { fixId: string }' };
        }
        try {
          liveFixRegistry.abort(parsed.fixId);
          return { ok: true, aborted: true, fixId: parsed.fixId };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg };
        }
      }
      default:
        return { ok: false, error: `unknown command: ${parsed.cmd}` };
    }
  }

  let stopping = false;
  async function stopInternal(): Promise<void> {
    if (stopping) return;
    stopping = true;
    queue?.shutdown();
    // Close the socket server immediately so new clients can't connect.
    // We do NOT wait for in-flight handlers — they may legitimately run for
    // hours (the entire point of the daemon is to outlive any single client).
    // Operators that want a hard kill should send SIGTERM via the pidfile.
    if (server) {
      await new Promise<void>((resolve) => {
        const s = server;
        if (!s) {
          resolve();
          return;
        }
        // closeAllConnections() (Node 18.2+) yanks in-flight connections so
        // close() resolves without waiting on them. The type isn't surfaced
        // by the `net.Server` declaration in older @types/node — guard via
        // an `unknown` cast and a runtime check.
        const maybeCloser = (s as unknown as { closeAllConnections?: () => void }).closeAllConnections;
        if (typeof maybeCloser === 'function') {
          try {
            maybeCloser.call(s);
          } catch {
            /* noop */
          }
        }
        s.close(() => resolve());
      });
    }
    // Drain every in-flight snapshot write before letting callers tear down
    // the directory — protects tests that rm the parent right after stop().
    // We snapshot the set because additional persists could enqueue under
    // us if a handler is still resolving as we stop.
    while (pendingPersists.size > 0) {
      const snapshot = Array.from(pendingPersists);
      await Promise.allSettled(snapshot);
    }
    await unlink(socketPath).catch(() => undefined);
  }

  return {
    address(): string {
      return socketPath;
    },

    async start(): Promise<void> {
      // Build the queue with a wrapper handler that maintains pendingShadow.
      queue = createFixQueue(async (req) => {
        // Shift from pendingShadow when the queue picks up a request.
        const idx = pendingShadow.indexOf(req);
        if (idx >= 0) pendingShadow.splice(idx, 1);
        await dispatchHandler(req);
      });

      // Replay any prior snapshot — in-flight requests get re-enqueued first
      // (they were closest to completing) followed by the pending tail.
      const prior = await loadSnapshot(homeDir);
      if (prior) {
        for (const r of prior.inFlight) enqueue(r);
        for (const r of prior.pending) enqueue(r);
        log.info(`[daemon] replayed snapshot: ${prior.inFlight.length + prior.pending.length} entries`);
      }

      server = net.createServer(handleConnection);

      await new Promise<void>((resolve, reject) => {
        if (!server) {
          reject(new Error('server not initialized'));
          return;
        }
        server.once('error', reject);
        server.listen(socketPath, () => {
          server?.off('error', reject);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      await stopInternal();
    },
  };
}
