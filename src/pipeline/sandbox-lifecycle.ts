// Sandbox lifecycle helpers — extracted from fix.ts (issue #435).
//
// The docker / daytona / etc. start + stop + stats collection lives here so
// fix.ts can stay focused on flow control. Behavior is bit-for-bit preserved:
// the docker path uses the legacy `killContainer` + `getContainerStats`
// helpers directly; non-docker backends route through the SandboxBackend
// abstraction (issue #301).

import { getSandboxBackend, type SandboxBackend } from '../sandbox/backend.js';
import type { SandboxContext } from '../sandbox/dispatch.js';
import {
  buildSandboxImage,
  DEFAULT_SANDBOX_LIMITS,
  getContainerStats,
  killContainer,
  parseTimeout,
  startSandboxContainer,
} from '../sandbox/sandbox.js';
import type { FixState, Issue, RepoConfig } from '../types/index.js';

/** Per-run sandbox state owned by the orchestrator and updated by `startSandbox`. */
export interface SandboxLifecycleState {
  containerId: string | undefined;
  containerName: string | undefined;
  context: SandboxContext | undefined;
  backend: SandboxBackend | undefined;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  startTime: number;
}

export function initSandboxLifecycle(): SandboxLifecycleState {
  return {
    containerId: undefined,
    containerName: undefined,
    context: undefined,
    backend: undefined,
    timeoutHandle: undefined,
    timedOut: false,
    startTime: Date.now(),
  };
}

export interface StartSandboxInput {
  issue: Issue;
  repoName: string;
  workDir: string;
  config: RepoConfig;
  logger: { warn: (msg: string) => void };
}

/** Discriminated result of `startSandbox` — either the running state or an early-exit error. */
export type StartSandboxResult =
  | { status: 'ready'; state: SandboxLifecycleState }
  | { status: 'failed'; error: string };

/**
 * Start the configured sandbox backend (docker by default, daytona/etc. via
 * the SandboxBackend abstraction). The docker path preserves its legacy
 * semantics (image build + timeout kill) bit-for-bit; non-docker backends
 * delegate to `SandboxBackend.start()` and report credential errors during
 * start rather than mid-wave.
 *
 * Returns `{ status: 'ready', state }` on success — the caller updates its
 * lifecycle slot and proceeds. Returns `{ status: 'failed', error }` when
 * the docker image build fails; the caller emits the corresponding metrics
 * and returns failure to its caller.
 */
export async function startSandbox(input: StartSandboxInput): Promise<StartSandboxResult> {
  const { issue, repoName, workDir, config, logger } = input;
  const state = initSandboxLifecycle();

  const backendName = config.sandbox?.backend ?? 'docker';
  state.backend = getSandboxBackend(backendName);

  if (backendName === 'docker') {
    const buildResult = await buildSandboxImage({ repoName, config: config.sandbox });
    if (!buildResult.success) {
      return { status: 'failed', error: buildResult.error ?? 'Docker image build failed' };
    }
    const sandbox = await startSandboxContainer({
      repoName,
      issueNumber: issue.number,
      repoPath: workDir,
      config: config.sandbox,
    });
    state.containerId = sandbox.containerId;
    state.containerName = sandbox.containerName;
    state.context = { containerName: sandbox.containerName, repoPath: workDir };

    // Timeout kill — bit-for-bit identical to the prior inline behavior.
    const timeoutStr = config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout;
    const timeoutMs = parseTimeout(timeoutStr);
    state.timeoutHandle = setTimeout(async () => {
      state.timedOut = true;
      logger.warn(`[sandbox] Timeout (${timeoutStr}) exceeded — killing container ${state.containerName}`);
      if (state.containerId) await killContainer(state.containerId);
    }, timeoutMs);
  } else {
    const handle = await state.backend.start({
      repoName,
      issueNumber: issue.number,
      repoPath: workDir,
      config: config.sandbox,
    });
    state.containerId = handle.containerId;
    state.containerName = handle.containerName;
    state.context = { containerName: handle.containerName, repoPath: workDir, backend: state.backend };
    logger.warn(`[sandbox] Backend '${backendName}' started: ${handle.containerName} (dispatch via backend.execWave)`);
  }

  return { status: 'ready', state };
}

export interface SandboxCleanupInput {
  containerId: string;
  containerName: string | undefined;
  backend: SandboxBackend | undefined;
  /** Wall-clock start of the sandbox session (Date.now()). */
  startTime: number;
  /** Per-run timeout handle to clear if set. */
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  /** Whether the timeout fired and the container was killed. */
  timedOut: boolean;
  config: RepoConfig;
  state: FixState;
  logger: { warn: (msg: string) => void };
}

/**
 * Collect resource usage stats, write them onto FixState.sandboxResourceUsage,
 * then stop the backend. Best-effort — every failure path is caught so it
 * never escapes back into the finally block.
 */
export async function cleanupSandbox(input: SandboxCleanupInput): Promise<void> {
  const { containerId, containerName, backend, startTime, timeoutHandle, timedOut, config, state, logger } = input;
  if (timeoutHandle) clearTimeout(timeoutHandle);

  const stats = backend
    ? await backend.getStats().catch(() => ({ memoryMB: 0, cpuPercent: 0 }))
    : await getContainerStats(containerId).catch(() => ({ memoryMB: 0, cpuPercent: 0 }));
  const wallTimeMs = Date.now() - startTime;
  const cpuCount = config.sandbox?.cpus ?? DEFAULT_SANDBOX_LIMITS.cpus;

  state.sandboxResourceUsage = {
    peakMemoryMB: stats.memoryMB,
    cpuSeconds: (stats.cpuPercent / 100) * cpuCount * (wallTimeMs / 1000),
    wallTimeMs,
    containerName: containerName ?? 'unknown',
    limitsApplied: {
      cpus: cpuCount,
      memory: config.sandbox?.memory ?? DEFAULT_SANDBOX_LIMITS.memory,
      timeout: config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout,
    },
  };

  if (timedOut) {
    logger.warn('[sandbox] Container was killed due to timeout');
  }

  const backendName = config.sandbox?.backend ?? 'docker';
  if (backendName === 'docker') {
    // Preserve the legacy direct call so DockerBackend extraction is observationally identical.
    await killContainer(containerId).catch(() => {});
  } else if (backend) {
    await backend.stop().catch(() => {});
  }
}
