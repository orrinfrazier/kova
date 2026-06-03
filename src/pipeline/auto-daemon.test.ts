// Tests for the daemon-rerouting layer that `runAuto` checks before
// falling through to inline execution (issue #291). The probe is exposed as
// a small standalone helper so this test can exercise the routing decision
// without spinning up the full STIR pipeline.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonServer, type DaemonServer } from '../core/daemon.js';
import { maybeSubmitToDaemon } from './auto-daemon.js';
import type { FixRequest } from './fix-queue.js';

describe('maybeSubmitToDaemon', () => {
  let homeDir: string;
  let socketPath: string;
  let daemon: DaemonServer | undefined;
  let processed: FixRequest[];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-auto-daemon-'));
    socketPath = join(homeDir, 'daemon.sock');
    processed = [];
    delete process.env.KOVA_USE_DAEMON;
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.KOVA_USE_DAEMON;
  });

  it('returns {used: false} when the socket does not exist (inline fallback)', async () => {
    const result = await maybeSubmitToDaemon({
      socketPath,
      requests: [{ issueNumber: 1, repoPath: '/p', repoName: 'r' }],
    });
    expect(result.used).toBe(false);
  });

  it('submits every request and returns {used: true, submitted: N} when a daemon is up', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    const result = await maybeSubmitToDaemon({
      socketPath,
      requests: [
        { issueNumber: 1, repoPath: '/p', repoName: 'r' },
        { issueNumber: 2, repoPath: '/p', repoName: 'r' },
        { issueNumber: 3, repoPath: '/p', repoName: 'r' },
      ],
    });
    expect(result.used).toBe(true);
    expect(result.submitted).toBe(3);
  });

  it('respects KOVA_USE_DAEMON=0 — falls back to inline even when daemon is running', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    process.env.KOVA_USE_DAEMON = '0';
    const result = await maybeSubmitToDaemon({
      socketPath,
      requests: [{ issueNumber: 1, repoPath: '/p', repoName: 'r' }],
    });
    expect(result.used).toBe(false);
  });

  it('respects forceInline option', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async (req) => {
        processed.push(req);
      },
    });
    await daemon.start();
    const result = await maybeSubmitToDaemon({
      socketPath,
      requests: [{ issueNumber: 1, repoPath: '/p', repoName: 'r' }],
      forceInline: true,
    });
    expect(result.used).toBe(false);
  });

  it('returns {used: false} when an empty request list is passed', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {},
    });
    await daemon.start();
    const result = await maybeSubmitToDaemon({
      socketPath,
      requests: [],
    });
    expect(result.used).toBe(false);
  });
});
