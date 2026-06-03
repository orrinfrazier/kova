// Tests for the `kova daemon` CLI subcommand wiring + the action helpers.
//
// Pattern follows src/cli/serve.test.ts — CLI registration is verified by
// source inspection (matches how Commander wiring is already tested), while
// the action helpers (which the user-facing commands delegate to) are
// covered by integration tests against a real daemon process.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonServer, type DaemonServer } from '../services/daemon.js';
import { runDaemonStatus, runDaemonStop } from './daemon.js';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova daemon command wiring', () => {
  it('CLI registers a daemon command', () => {
    const src = getCliSource();
    expect(src).toContain(".command('daemon");
  });

  it('CLI registers daemon start / status / stop / run subcommands', () => {
    const src = getCliSource();
    // The three user-visible verbs and the hidden run-as-foreground subcommand.
    for (const verb of ['start', 'status', 'stop', 'run']) {
      expect(src).toContain(`daemon-${verb}`);
    }
  });

  it('CLI imports the daemon action helpers', () => {
    const src = getCliSource();
    // CLI uses a dynamic import for code-splitting — both shapes accepted.
    const staticImport = /from ['"]\.\/daemon(?:\.js)?['"]/.test(src);
    const dynamicImport = /import\(['"]\.\/daemon(?:\.js)?['"]\)/.test(src);
    expect(staticImport || dynamicImport).toBe(true);
  });
});

describe('runDaemonStatus', () => {
  let homeDir: string;
  let socketPath: string;
  let daemon: DaemonServer | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-daemon-cli-'));
    socketPath = join(homeDir, 'daemon.sock');
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns "not running" when no daemon is up', async () => {
    const result = await runDaemonStatus(socketPath);
    expect(result.running).toBe(false);
  });

  it('returns running:true + pid + queued when a daemon is up', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {},
    });
    await daemon.start();
    const result = await runDaemonStatus(socketPath);
    expect(result.running).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(result.queued).toBe(0);
  });
});

describe('runDaemonStop', () => {
  let homeDir: string;
  let socketPath: string;
  let daemon: DaemonServer | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-daemon-cli-stop-'));
    socketPath = join(homeDir, 'daemon.sock');
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = undefined;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns ok:false when no daemon is running', async () => {
    const result = await runDaemonStop(socketPath);
    expect(result.ok).toBe(false);
  });

  it('drains and shuts down a running daemon', async () => {
    daemon = createDaemonServer({
      socketPath,
      homeDir,
      handler: async () => {},
    });
    await daemon.start();
    const result = await runDaemonStop(socketPath);
    expect(result.ok).toBe(true);
    // Subsequent status should be "not running".
    const status = await runDaemonStatus(socketPath);
    expect(status.running).toBe(false);
    daemon = undefined;
  });
});
