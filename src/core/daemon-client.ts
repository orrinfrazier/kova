// Daemon client (issue #291).
//
// Thin wrapper over the unix-domain socket protocol exposed by
// services/daemon.ts. Two responsibilities:
//
//   1. isDaemonRunning(path)  — probe; tolerate a stale socket file with no
//      live listener (rare crash artifact)
//   2. submitToDaemon(path,r) — send one `submit` command and resolve with
//      the ack
//
// The "default socket path" lives here so callers don't reimplement the
// `~/.kova/daemon.sock` convention.

import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FixRequest } from '../pipeline/fix-queue.js';

const PROBE_TIMEOUT_MS = 250;

/** Default socket path: `<home>/.kova/daemon.sock`. */
export function defaultSocketPath(home: string = homedir()): string {
  return join(home, '.kova', 'daemon.sock');
}

interface RpcResult {
  ok: boolean;
  [k: string]: unknown;
}

/** Send one command, read one reply, close the connection. */
function rpc(socketPath: string, payload: object, timeoutMs = 5000): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let buf = '';
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        /* noop */
      }
      reject(err);
    };

    const succeed = (result: RpcResult): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* noop */
      }
      resolve(result);
    };

    const timer = setTimeout(() => fail(new Error('daemon rpc timeout')), timeoutMs);

    client.on('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const newline = buf.indexOf('\n');
      if (newline >= 0) {
        const line = buf.slice(0, newline);
        clearTimeout(timer);
        try {
          succeed(JSON.parse(line) as RpcResult);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

/** Probe whether a daemon is listening on the socket. Tolerates stale files. */
export async function isDaemonRunning(socketPath: string): Promise<boolean> {
  try {
    const reply = await rpc(socketPath, { cmd: 'status' }, PROBE_TIMEOUT_MS);
    return reply.ok === true;
  } catch {
    return false;
  }
}

/** Submit a FixRequest to the daemon. Resolves with the ack; rejects on connect error. */
export async function submitToDaemon(socketPath: string, request: FixRequest): Promise<RpcResult> {
  return rpc(socketPath, { cmd: 'submit', request });
}

/** Tell the daemon to drain and exit. Resolves with the ack. */
export async function shutdownDaemon(socketPath: string): Promise<RpcResult> {
  return rpc(socketPath, { cmd: 'shutdown' });
}

/**
 * Issue #294 — send a steering hint into one live fix.
 *
 * The daemon routes to its in-process LiveFixRegistry. Resolves with the
 * server reply (`{ok:true, steered:true}` on success, `{ok:false, error}`
 * for an unknown fixId or a daemon built without a registry). Rejects only
 * when the daemon socket itself is unreachable.
 */
export async function sendSteerToDaemon(socketPath: string, fixId: string, hint: string): Promise<RpcResult> {
  return rpc(socketPath, { cmd: 'steer', fixId, hint });
}

/**
 * Issue #294 — abort one live fix without affecting siblings.
 *
 * Mirrors `sendSteerToDaemon` — same daemon-side routing and error shapes.
 * Aborting a completed or unknown fix returns `{ok:false, error}` rather
 * than throwing, so callers can render a clear message.
 */
export async function sendAbortToDaemon(socketPath: string, fixId: string): Promise<RpcResult> {
  return rpc(socketPath, { cmd: 'abort', fixId });
}
