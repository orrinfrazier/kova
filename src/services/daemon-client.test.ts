// Daemon client — tests.
//
// Verifies the "submit if daemon present, otherwise no-op" semantics that
// auto/loop/epic rely on (issue #291: "Reroute auto/loop/epic to submit to
// the daemon when present; inline fallback").

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonServer, type DaemonServer } from './daemon.js';
import {
  defaultSocketPath,
  isDaemonRunning,
  sendAbortToDaemon,
  sendSteerToDaemon,
  submitToDaemon,
} from './daemon-client.js';
import { createLiveFixRegistry } from './live-fix-registry.js';

describe('daemon-client', () => {
  let homeDir: string;
  let socketPath: string;
  let daemon: DaemonServer | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-daemon-client-'));
    socketPath = join(homeDir, 'daemon.sock');
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('defaultSocketPath', () => {
    it('returns ~/.kova/daemon.sock', () => {
      const p = defaultSocketPath('/home/u');
      expect(p).toBe('/home/u/.kova/daemon.sock');
    });
  });

  describe('isDaemonRunning', () => {
    it('returns false when the socket does not exist', async () => {
      const result = await isDaemonRunning(socketPath);
      expect(result).toBe(false);
    });

    it('returns true when a daemon is listening on the socket', async () => {
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {},
      });
      await daemon.start();
      const result = await isDaemonRunning(socketPath);
      expect(result).toBe(true);
    });

    it('returns false for a stale socket file with no listener', async () => {
      // Create a regular file at the socket path — not a live listener.
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(homeDir, { recursive: true });
      await writeFile(socketPath, '');
      const result = await isDaemonRunning(socketPath);
      expect(result).toBe(false);
    });
  });

  describe('submitToDaemon', () => {
    it('resolves with the daemon ack on success', async () => {
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {
          // No-op — we just want the ack.
        },
      });
      await daemon.start();
      const reply = await submitToDaemon(socketPath, {
        issueNumber: 42,
        repoPath: '/p',
        repoName: 'r',
      });
      expect(reply.ok).toBe(true);
    });

    it('rejects when the daemon is not running', async () => {
      await expect(
        submitToDaemon(socketPath, {
          issueNumber: 1,
          repoPath: '/p',
          repoName: 'r',
        }),
      ).rejects.toThrow();
    });
  });

  // Issue #294: send-keys-style steering — `sendSteerToDaemon` and
  // `sendAbortToDaemon` round-trip the new `steer` / `abort` RPC commands.
  describe('sendSteerToDaemon (issue #294)', () => {
    it('resolves with ok:true and steered:true when fixId is live', async () => {
      const reg = createLiveFixRegistry();
      const calls: string[] = [];
      reg.register('fix-abc', { steer: (h) => calls.push(h), abort: () => {} });
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {},
        liveFixRegistry: reg,
      });
      await daemon.start();
      const reply = await sendSteerToDaemon(socketPath, 'fix-abc', 'focus on the spec');
      expect(reply.ok).toBe(true);
      expect(reply.steered).toBe(true);
      expect(calls).toEqual(['focus on the spec']);
    });

    it('resolves with ok:false when fixId is not running', async () => {
      const reg = createLiveFixRegistry();
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {},
        liveFixRegistry: reg,
      });
      await daemon.start();
      const reply = await sendSteerToDaemon(socketPath, 'missing', 'hi');
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/not running/i);
    });

    it('rejects when the daemon is not running', async () => {
      await expect(sendSteerToDaemon(socketPath, 'x', 'y')).rejects.toThrow();
    });
  });

  describe('sendAbortToDaemon (issue #294)', () => {
    it('resolves with ok:true and aborted:true when fixId is live', async () => {
      const reg = createLiveFixRegistry();
      let aborted = 0;
      reg.register('fix-abc', {
        steer: () => {},
        abort: () => {
          aborted++;
        },
      });
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {},
        liveFixRegistry: reg,
      });
      await daemon.start();
      const reply = await sendAbortToDaemon(socketPath, 'fix-abc');
      expect(reply.ok).toBe(true);
      expect(reply.aborted).toBe(true);
      expect(aborted).toBe(1);
    });

    it('resolves with ok:false when fixId is not running', async () => {
      const reg = createLiveFixRegistry();
      daemon = createDaemonServer({
        socketPath,
        homeDir,
        handler: async () => {},
        liveFixRegistry: reg,
      });
      await daemon.start();
      const reply = await sendAbortToDaemon(socketPath, 'missing');
      expect(reply.ok).toBe(false);
    });

    it('rejects when the daemon is not running', async () => {
      await expect(sendAbortToDaemon(socketPath, 'x')).rejects.toThrow();
    });
  });
});
