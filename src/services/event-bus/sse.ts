// Server-Sent Events handler for streaming KovaEvents to external clients.
//
// GET /events                — stream every event live (no replay)
// GET /events?fixId=<id>     — replay the per-fix ring buffer, then stream live
//                              events for that fixId
//
// Implementation notes:
//   - Uses node:http only (no external deps); plugs into webhook-server.ts
//     alongside /health, /metrics, /webhook.
//   - Writes one SSE frame per event: `event: kova\ndata: <json>\n\n`.
//   - Heartbeats every 30s as `: heartbeat\n\n` so proxies don't drop idle
//     connections.
//   - Unsubscribes + clears timers when the client disconnects.

import type http from 'node:http';
import { log } from '../../utils/logger.js';
import type { EventBus } from './bus.js';
import type { KovaEvent } from './schema.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface SseRequestOptions {
  heartbeatMs?: number;
}

/**
 * Handle one SSE client request. Owns the response lifecycle — writes headers,
 * pumps events, sends heartbeats, and cleans up when the client disconnects.
 */
export function handleSseRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bus: EventBus,
  options: SseRequestOptions = {},
): void {
  // Parse `?fixId=` from the URL — node:http doesn't give us URLSearchParams
  // without a base, so build one against a synthetic host.
  const parsed = new URL(req.url ?? '/events', 'http://localhost');
  const fixIdFilter = parsed.searchParams.get('fixId') ?? undefined;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disable nginx-style buffering so frames flush immediately
    'x-accel-buffering': 'no',
  });
  // Send an initial comment so the connection establishes promptly
  res.write(': connected\n\n');

  const writeEvent = (event: KovaEvent): void => {
    try {
      // SSE frame: optional event name + data + blank line
      res.write(`event: kova\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`[event-bus.sse] write failed: ${msg}`);
    }
  };

  let unsubscribe: () => void;
  if (fixIdFilter) {
    // Per-fix subscribe replays the ring buffer synchronously before returning,
    // then forwards live events for that fix.
    unsubscribe = bus.subscribeForFix(fixIdFilter, writeEvent);
  } else {
    unsubscribe = bus.subscribe(writeEvent);
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      // Connection likely dead; the close handler will clean up.
    }
  }, heartbeatMs);
  // Don't keep the Node process alive solely for the heartbeat timer.
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}
