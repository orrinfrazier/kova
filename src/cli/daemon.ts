// `kova daemon` CLI action helpers (issue #291).
//
// `daemon start`  — spawn the current kova binary as `daemon run`, detached,
//                   with stdio:'ignore'. Parent exits immediately (the
//                   acceptance criterion: "starts detached on a socket,
//                   returns immediately").
// `daemon run`    — hidden; foreground process that owns the DaemonServer.
//                   This is what `daemon start` execs.
// `daemon status` — connect to the socket, print pid/queued/running.
// `daemon stop`   — send shutdown command, optionally SIGTERM via pidfile.
//
// The pidfile (~/.kova/daemon.pid) lets `daemon stop` force-kill if a
// drain hangs longer than the SIGTERM grace window.

import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { defaultSocketPath, isDaemonRunning, shutdownDaemon } from '../services/daemon-client.js';
import { log } from '../utils/logger.js';

/** Default pidfile path: `<home>/.kova/daemon.pid`. */
export function defaultPidPath(home: string = homedir()): string {
  return join(home, '.kova', 'daemon.pid');
}

/** Write the current process PID to the pidfile, creating parent dirs as needed. */
export async function writePidFile(pidPath: string, pid: number = process.pid): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(pid));
}

/** Remove the pidfile if it exists. */
export async function removePidFile(pidPath: string): Promise<void> {
  await unlink(pidPath).catch(() => undefined);
}

/** Read the PID from the pidfile, or null if missing/malformed. */
export async function readPidFile(pidPath: string): Promise<number | null> {
  try {
    const raw = await readFile(pidPath, 'utf-8');
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export interface DaemonStartOptions {
  /** Override the socket path (default ~/.kova/daemon.sock). */
  socketPath?: string | undefined;
  /** Override the pid path (default ~/.kova/daemon.pid). */
  pidPath?: string | undefined;
  /** Override the binary that gets spawned (default: process.execPath + process.argv[1]). */
  bin?: string | undefined;
}

export interface DaemonStartResult {
  ok: boolean;
  pid?: number;
  socketPath: string;
  reason?: string;
}

/**
 * Spawn the daemon as a detached child running `<bin> daemon run`. Parent
 * exits immediately so the user's terminal is freed (acceptance criterion).
 *
 * Returns synchronously after the spawn — does NOT wait for the daemon to
 * begin listening. Use `runDaemonStatus()` to confirm liveness.
 */
export async function runDaemonStart(options: DaemonStartOptions = {}): Promise<DaemonStartResult> {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const pidPath = options.pidPath ?? defaultPidPath();

  if (await isDaemonRunning(socketPath)) {
    return { ok: false, socketPath, reason: 'daemon already running' };
  }

  // Build the command. When the kova binary is invoked via `node ./dist/cli/index.js`
  // we forward execPath + argv[1]; when invoked as a global bin (`kova`), argv[1]
  // is the resolved script — same shape works either way.
  const execPath = options.bin ?? process.execPath;
  const argv = options.bin ? ['daemon', 'run'] : [process.argv[1] ?? '', 'daemon', 'run'];

  const child = spawn(execPath, argv, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      KOVA_DAEMON_SOCKET: socketPath,
      KOVA_DAEMON_PIDFILE: pidPath,
    },
  });

  // Detach the parent's handle so this process can exit independently of the
  // child. Without unref() the parent stays alive until the daemon does.
  child.unref();

  // The child writes its own pidfile inside `runDaemonRun` once it's ready —
  // but we also stamp the pid here as an early best-effort marker so
  // `daemon stop` has a fallback before the child finishes booting.
  if (typeof child.pid === 'number') {
    await writePidFile(pidPath, child.pid);
  }

  return { ok: true, ...(typeof child.pid === 'number' ? { pid: child.pid } : {}), socketPath };
}

export interface DaemonStatusResult {
  running: boolean;
  pid?: number;
  queued?: number;
  socketPath: string;
}

/** Query the daemon's status command. Returns running:false if the probe fails. */
export async function runDaemonStatus(socketPath: string = defaultSocketPath()): Promise<DaemonStatusResult> {
  if (!(await isDaemonRunning(socketPath))) {
    return { running: false, socketPath };
  }
  // isDaemonRunning already calls status — replay it to get the fields.
  const { rpc } = await import('./daemon-rpc.js');
  try {
    const reply = await rpc(socketPath, { cmd: 'status' });
    return {
      running: reply.ok === true,
      ...(typeof reply.pid === 'number' ? { pid: reply.pid } : {}),
      ...(typeof reply.queued === 'number' ? { queued: reply.queued } : {}),
      socketPath,
    };
  } catch {
    return { running: false, socketPath };
  }
}

export interface DaemonStopResult {
  ok: boolean;
  reason?: string;
}

/** Send the shutdown command. Returns ok:false if no daemon was running. */
export async function runDaemonStop(socketPath: string = defaultSocketPath()): Promise<DaemonStopResult> {
  if (!(await isDaemonRunning(socketPath))) {
    return { ok: false, reason: 'daemon not running' };
  }
  try {
    await shutdownDaemon(socketPath);
    // Give the daemon a brief window to drain + close the socket.
    for (let i = 0; i < 20; i++) {
      if (!(await isDaemonRunning(socketPath))) {
        return { ok: true };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ok: true, reason: 'shutdown initiated but socket still responsive' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `kova daemon run` — foreground process that owns the DaemonServer. This
 * is what `daemon start` spawns. Stays alive until shutdown command is
 * received or the process gets a SIGTERM.
 *
 * The handler is intentionally a placeholder log call — full pipeline
 * integration is a follow-up; the daemon plumbing + lifecycle landed first.
 */
export async function runDaemonRun(): Promise<void> {
  const { createDaemonServer } = await import('../services/daemon.js');
  // Issue #294: share the same process-singleton LiveFixRegistry between the
  // daemon's RPC handler (which routes `kova send` / `kova kill` into live
  // waves) and the fix-pipeline call sites (which register handles per wave).
  const { defaultLiveFixRegistry } = await import('../services/live-fix-registry.js');
  const socketPath = process.env.KOVA_DAEMON_SOCKET ?? defaultSocketPath();
  const pidPath = process.env.KOVA_DAEMON_PIDFILE ?? defaultPidPath();
  const homeDir = homedir();

  const daemon = createDaemonServer({
    socketPath,
    homeDir,
    handler: async (req) => {
      // MVP handler: log the request. Full pipeline dispatch is a follow-up
      // (the daemon plumbing + lifecycle are landing first; the pipeline
      // bridge will land alongside the auto/loop/epic rerouting work).
      log.info(`[daemon] processing request: #${req.issueNumber} @ ${req.repoName}`);
    },
    liveFixRegistry: defaultLiveFixRegistry,
  });

  await writePidFile(pidPath);

  const onSignal = async (): Promise<void> => {
    log.info('[daemon] received shutdown signal, draining...');
    await daemon.stop();
    await removePidFile(pidPath);
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void onSignal();
  });
  process.on('SIGINT', () => {
    void onSignal();
  });

  await daemon.start();
  log.info(`[daemon] listening on ${socketPath} (pid=${process.pid})`);

  // Block forever — the daemon's stop() resolves when shutdown completes,
  // but we want this process to be the one driving the lifecycle.
  await new Promise<void>(() => {
    /* run until SIGTERM/SIGINT or shutdown cmd */
  });
}
