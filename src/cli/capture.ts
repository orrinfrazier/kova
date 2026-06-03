// `kova capture <fix-id>` — print the per-fix scrollback ring buffer.
//
// Issue: kova#295. Companion to `kova attach` (#293).
//
// Two run modes:
//   1. HTTP: query the daemon's `GET /capture?fixId=<id>` endpoint and print
//      each event as one JSON line. Default URL: $KOVA_CAPTURE_URL or
//      http://localhost:3000.
//   2. In-process: when given an EventBus directly (used by tests and any
//      future single-process attach flow), snapshot the bus and print.
//
// Filters compose: --wave first, --lines last (so --lines always trims the
// final visible tail).

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { EventBus } from '../telemetry/event-bus/bus.js';
import type { EventWaveName, KovaEvent } from '../telemetry/event-bus/schema.js';

const VALID_WAVES: ReadonlySet<string> = new Set<EventWaveName>([
  'assess',
  'spec',
  'test',
  'impl',
  'quality',
  'review',
  'brainstorm',
  'ship',
]);

export interface CaptureFilters {
  /**
   * Restrict to events that carry a `wave` field matching this value. Events
   * without a `wave` field (`fix-started`, `fix-done`) are KEPT as lifecycle
   * anchors so the captured window is self-describing.
   */
  wave?: string;
  /** Keep only the last N events after wave filtering. */
  lines?: number;
}

export interface CaptureOptions extends CaptureFilters {
  /** Override the HTTP daemon URL (default: $KOVA_CAPTURE_URL or http://localhost:3000). */
  url?: string;
}

/** Strict-mode-safe predicate: does this event carry a `wave` field? */
function hasWaveField(event: KovaEvent): event is Extract<KovaEvent, { wave: EventWaveName }> {
  return 'wave' in event && typeof (event as { wave?: unknown }).wave === 'string';
}

/**
 * Pure filter logic — accepts a snapshot array, returns the filtered slice.
 * Lifecycle events (`fix-started`, `fix-done`) are KEPT under --wave filter
 * because they anchor the window; dropping them would leave the captured
 * output orphaned of context.
 */
export function filterCaptureEvents(events: readonly KovaEvent[], filters: CaptureFilters): KovaEvent[] {
  let out: KovaEvent[] = events.slice();
  if (filters.wave) {
    out = out.filter((e) => !hasWaveField(e) || e.wave === filters.wave);
  }
  if (filters.lines != null && filters.lines >= 0 && out.length > filters.lines) {
    out = out.slice(out.length - filters.lines);
  }
  return out;
}

/** Format a single KovaEvent as a compact JSON line (no trailing newline). */
export function formatCaptureLine(event: KovaEvent): string {
  return JSON.stringify(event);
}

/**
 * Run capture against an in-memory snapshot — useful for tests and the
 * single-process attach flow. Writes one `<json>\n` chunk per event.
 */
export function runCaptureFromSnapshot(
  snapshot: readonly KovaEvent[],
  filters: CaptureFilters,
  write: (chunk: string) => void,
): void {
  const filtered = filterCaptureEvents(snapshot, filters);
  for (const ev of filtered) {
    write(`${formatCaptureLine(ev)}\n`);
  }
}

/** Resolve the daemon URL (env override > explicit option > default). */
export function resolveCaptureUrl(opt?: string): string {
  return opt ?? process.env.KOVA_CAPTURE_URL ?? 'http://localhost:3000';
}

/**
 * Fetch the per-fix snapshot from the daemon's HTTP endpoint. Returns the
 * parsed array. Throws on transport failure or non-200 status.
 */
export function fetchCaptureSnapshot(fixId: string, options: CaptureOptions = {}): Promise<KovaEvent[]> {
  const base = resolveCaptureUrl(options.url);
  const url = new URL('/capture', base);
  url.searchParams.set('fixId', fixId);
  if (options.wave) url.searchParams.set('wave', options.wave);
  if (options.lines != null) url.searchParams.set('lines', String(options.lines));

  if (options.wave && !VALID_WAVES.has(options.wave)) {
    return Promise.reject(
      new Error(`Invalid --wave value: "${options.wave}". Expected one of: ${[...VALID_WAVES].join(', ')}.`),
    );
  }

  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<KovaEvent[]>((resolve, reject) => {
    const req = transport.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`capture request failed: ${res.statusCode} ${body}`));
          return;
        }
        try {
          const parsed = JSON.parse(body) as unknown;
          if (!Array.isArray(parsed)) {
            reject(new Error('capture response was not a JSON array'));
            return;
          }
          resolve(parsed as KovaEvent[]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          reject(new Error(`capture response was not JSON: ${msg}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * CLI entry point. Fetches via HTTP and prints results to `write` (stdout by
 * default). Returns the number of events printed so callers can size the exit
 * behavior.
 */
export async function runCapture(
  fixId: string,
  options: CaptureOptions = {},
  write: (chunk: string) => void = process.stdout.write.bind(process.stdout),
): Promise<number> {
  if (!fixId) {
    throw new Error('fix-id is required');
  }
  const events = await fetchCaptureSnapshot(fixId, options);
  // The server already applies --wave/--lines, but we re-run the filter
  // locally for the in-process snapshot path. Filtering twice on a server-
  // filtered array is a no-op since the filter is monotone.
  const localFilter: CaptureFilters = {};
  if (options.wave) localFilter.wave = options.wave;
  if (options.lines != null) localFilter.lines = options.lines;
  const filtered = filterCaptureEvents(events, localFilter);
  for (const ev of filtered) {
    write(`${formatCaptureLine(ev)}\n`);
  }
  return filtered.length;
}

/** Direct in-process variant for tests and the future single-process attach. */
export function runCaptureFromBus(
  bus: EventBus,
  fixId: string,
  filters: CaptureFilters,
  write: (chunk: string) => void,
): number {
  const snapshot = bus.snapshot(fixId);
  const filtered = filterCaptureEvents(snapshot, filters);
  for (const ev of filtered) {
    write(`${formatCaptureLine(ev)}\n`);
  }
  return filtered.length;
}
