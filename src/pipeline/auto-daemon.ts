// Daemon rerouting layer for the auto/loop/epic pipelines (issue #291).
//
// When a `kova daemon` is running on the conventional socket path, auto/loop
// submit each FixRequest to the daemon instead of executing inline; the
// daemon then owns the run for as long as the user wants (it outlives the
// terminal that submitted the work). When no daemon is present, the caller
// continues with its existing inline behavior — backward compat guaranteed.
//
// Opt-outs (any one disables the reroute):
//   - `KOVA_USE_DAEMON=0` environment variable
//   - `forceInline: true` option (set by `--no-daemon` CLI flag)
//   - No daemon listening on the socket

import { defaultSocketPath, isDaemonRunning, submitToDaemon } from '../services/daemon-client.js';
import type { FixRequest } from '../services/fix-queue.js';
import { log } from '../utils/logger.js';

export interface MaybeSubmitOptions {
  /** Socket path of the daemon (default: ~/.kova/daemon.sock). */
  socketPath?: string;
  /** Requests to submit, in order. */
  requests: FixRequest[];
  /** When true, skip the daemon entirely (passthrough to inline). */
  forceInline?: boolean | undefined;
}

export interface MaybeSubmitResult {
  /** True when the daemon was used; the caller should NOT also run inline. */
  used: boolean;
  /** Number of requests submitted to the daemon (only meaningful when used:true). */
  submitted?: number;
}

/**
 * Probe for a running daemon and, if present, submit every request. The
 * caller's existing inline path is the natural fallback — this function
 * simply returns {used:false} when the reroute should not happen.
 */
export async function maybeSubmitToDaemon(options: MaybeSubmitOptions): Promise<MaybeSubmitResult> {
  const { requests, forceInline } = options;
  const socketPath = options.socketPath ?? defaultSocketPath();

  if (forceInline === true) return { used: false };
  if (process.env.KOVA_USE_DAEMON === '0') return { used: false };
  if (requests.length === 0) return { used: false };

  if (!(await isDaemonRunning(socketPath))) return { used: false };

  let submitted = 0;
  for (const req of requests) {
    try {
      await submitToDaemon(socketPath, req);
      submitted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[auto] daemon submit failed for #${req.issueNumber}: ${msg}`);
      // Hard fail-stop: if any submission fails partway through, treat the
      // run as inline so the caller doesn't double-execute the successes.
      // The submitted-so-far runs continue inside the daemon — the operator
      // can `kova ls` to see them.
      return { used: false };
    }
  }

  log.info(`[auto] Submitted ${submitted} request(s) to daemon at ${socketPath}`);
  return { used: true, submitted };
}
