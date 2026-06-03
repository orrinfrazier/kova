// Tiny RPC helper shared between cli/daemon.ts action helpers and the daemon
// integration tests. Identical wire protocol to services/daemon-client.ts's
// internal helper, exposed here so the CLI status command can read the full
// reply (not just the ok bit).

import { createConnection } from 'node:net';

export interface RpcReply {
  ok: boolean;
  [k: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 1000;

export function rpc(socketPath: string, payload: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RpcReply> {
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

    const succeed = (result: RpcReply): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* noop */
      }
      resolve(result);
    };

    const timer = setTimeout(() => fail(new Error('rpc timeout')), timeoutMs);

    client.on('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const newline = buf.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, newline);
        try {
          succeed(JSON.parse(line) as RpcReply);
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
