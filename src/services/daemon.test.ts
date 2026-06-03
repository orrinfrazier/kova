// Daemon server — tests.
//
// Uses real unix-domain sockets in a tmpdir per repo TDD convention (no
// mocking of network or fs). Each test starts/stops its own daemon to keep
// state isolated.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonServer, type DaemonServer } from './daemon.js';
import { loadSnapshot, saveSnapshot } from './daemon-snapshot.js';
import type { FixRequest } from './fix-queue.js';

interface RpcResult {
  ok: boolean;
  [key: string]: unknown;
}

/** Send one newline-delimited JSON command to the daemon and read one reply. */
function rpc(socketPath: string, payload: object): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const newline = buf.indexOf('\n');
      if (newline >= 0) {
        const line = buf.slice(0, newline);
        try {
          resolve(JSON.parse(line) as RpcResult);
        } catch (err) {
          reject(err);
        }
        client.end();
      }
    });
    client.on('error', reject);
  });
}

describe('daemon server', () => {
  let homeDir: string;
  let socketPath: string;
  let daemon: DaemonServer | undefined;
  let processed: FixRequest[];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-daemon-'));
    socketPath = join(homeDir, 'daemon.sock');
    processed = [];
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('exposes a listening unix socket after start()', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    expect(existsSync(socketPath)).toBe(true);
  });

  it('responds to a status command with queued + running + pid', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    const reply = await rpc(socketPath, { cmd: 'status' });
    expect(reply.ok).toBe(true);
    expect(reply.queued).toBe(0);
    expect(typeof reply.pid).toBe('number');
  });

  it('enqueues submitted requests and runs them via the handler', async () => {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
        resolveDone();
      },
    });
    await daemon.start();
    const reply = await rpc(socketPath, {
      cmd: 'submit',
      request: { issueNumber: 7, repoPath: '/p', repoName: 'r' },
    });
    expect(reply.ok).toBe(true);
    await done;
    expect(processed).toEqual([{ issueNumber: 7, repoPath: '/p', repoName: 'r' }]);
  });

  it('rejects an unknown command with ok:false', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    const reply = await rpc(socketPath, { cmd: 'totally-not-real' });
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe('string');
  });

  it('removes the socket file on stop()', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    expect(existsSync(socketPath)).toBe(true);
    await daemon.stop();
    daemon = undefined;
    expect(existsSync(socketPath)).toBe(false);
  });

  it('persists a snapshot after each submission', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {
        // Block forever so the request stays in-flight long enough to snapshot.
        await new Promise(() => {});
      },
    });
    await daemon.start();
    await rpc(socketPath, {
      cmd: 'submit',
      request: { issueNumber: 1, repoPath: '/p', repoName: 'r' },
    });
    // Give the daemon a tick to save.
    await new Promise((r) => setTimeout(r, 50));
    const snap = await loadSnapshot(homeDir);
    expect(snap).not.toBeNull();
    const all = [...(snap?.pending ?? []), ...(snap?.inFlight ?? [])];
    expect(all).toContainEqual({ issueNumber: 1, repoPath: '/p', repoName: 'r' });
  });

  it('reloads work from a prior snapshot on start()', async () => {
    // Pre-seed a snapshot file.
    await saveSnapshot(homeDir, {
      version: 1,
      savedAt: '2026-06-03T00:00:00Z',
      pending: [
        { issueNumber: 101, repoPath: '/p', repoName: 'r' },
        { issueNumber: 102, repoPath: '/p', repoName: 'r' },
      ],
      inFlight: [{ issueNumber: 100, repoPath: '/p', repoName: 'r' }],
    });

    const seen: FixRequest[] = [];
    let resolveAll: () => void = () => {};
    const allDone = new Promise<void>((r) => {
      resolveAll = r;
    });
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        seen.push(req);
        if (seen.length === 3) resolveAll();
      },
    });
    await daemon.start();
    await allDone;
    // Issue numbers from snapshot were all replayed (order: inFlight first, then pending).
    expect(seen.map((s) => s.issueNumber).sort()).toEqual([100, 101, 102]);
  });

  it('rejects start() when another daemon already owns the socket', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {},
    });
    await daemon.start();
    const second = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {},
    });
    await expect(second.start()).rejects.toThrow();
  });
});
