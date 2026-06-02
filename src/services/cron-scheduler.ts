// Scheduler orchestrator (issue #303).
//
// `runSchedulerTick` is the unit of work — for every (repo, job) it checks
// `shouldRun` and dispatches the job runner. Errors from any single job are
// caught and logged; the scheduler never crashes on a downstream failure.
//
// `runSchedulerForever` poll-loops until aborted (Ctrl-C or `signalStop`).
// `listSchedules` is read-only — used by `kova schedule list`.
//
// The runtime config shape (`SchedulerConfig`) is deliberately decoupled from
// the on-disk `KovaConfig` so unit tests can drive the scheduler without
// loading repos.yaml: `runSchedulerForever` adapts the loaded config into
// this shape via `buildSchedulerConfig`.

import type { KovaConfig, ScheduleConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import { shouldRun } from './cron-evaluator.js';
import { loadScheduleState, recordRun, scheduleStateKey } from './cron-state.js';

/** Per-repo entry consumed by the scheduler runtime. */
export interface SchedulerRepoConfig {
  /** Cron jobs configured for this repo. */
  schedule?: ScheduleConfig | undefined;
  /** Root directory for the persisted state file (defaults to `~/.kova`). */
  statePath: string;
  /** Optional path forwarded to the job runner. */
  repoPath?: string | undefined;
}

export interface SchedulerConfig {
  repos: Record<string, SchedulerRepoConfig>;
}

export interface SchedulerJobInvocation {
  repoName: string;
  jobName: string;
  cronExpr: string;
  /** Snapshot of repo config — runner can do anything with it. */
  repo: SchedulerRepoConfig;
  /** The Date the scheduler considered "now" when firing the job. */
  firedAt: Date;
}

export type SchedulerJobRunner = (invocation: SchedulerJobInvocation) => Promise<{ success: boolean }>;

export interface ScheduleRow {
  repoName: string;
  jobName: string;
  cronExpr: string;
  /** Last persisted run time, or undefined when never fired. */
  lastRun?: string | undefined;
}

/** Enumerate every (repo, job) pair across the config and include last_run. */
export async function listSchedules(config: SchedulerConfig): Promise<ScheduleRow[]> {
  const rows: ScheduleRow[] = [];
  // Group repos by state path so we only load each state file once.
  const stateByPath = new Map<string, Awaited<ReturnType<typeof loadScheduleState>>>();
  for (const repo of Object.values(config.repos)) {
    if (!stateByPath.has(repo.statePath)) {
      stateByPath.set(repo.statePath, await loadScheduleState(repo.statePath));
    }
  }
  for (const [repoName, repo] of Object.entries(config.repos)) {
    if (!repo.schedule) continue;
    const state = stateByPath.get(repo.statePath) ?? {};
    for (const [jobName, cronExpr] of Object.entries(repo.schedule)) {
      const key = scheduleStateKey(repoName, jobName);
      const row: ScheduleRow = { repoName, jobName, cronExpr };
      const lastRun = state[key]?.last_run_iso;
      if (lastRun !== undefined) row.lastRun = lastRun;
      rows.push(row);
    }
  }
  return rows;
}

interface TickOptions {
  /** Override "now" — used by tests. Defaults to `new Date()`. */
  now?: Date;
}

/** Single scheduler tick — runs every due job exactly once and records last_run. */
export async function runSchedulerTick(
  config: SchedulerConfig,
  runner: SchedulerJobRunner,
  options: TickOptions = {},
): Promise<Array<{ repoName: string; jobName: string }>> {
  const now = options.now ?? new Date();
  const fired: Array<{ repoName: string; jobName: string }> = [];

  for (const [repoName, repo] of Object.entries(config.repos)) {
    if (!repo.schedule) continue;
    const state = await loadScheduleState(repo.statePath);
    for (const [jobName, cronExpr] of Object.entries(repo.schedule)) {
      const key = scheduleStateKey(repoName, jobName);
      const lastRun = state[key]?.last_run_iso;
      let due: boolean;
      try {
        due = shouldRun(cronExpr, lastRun, now);
      } catch (err) {
        // Misconfigured cron — log once, skip, do NOT crash the scheduler.
        log.error(
          `[scheduler] invalid cron "${cronExpr}" for ${repoName}:${jobName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!due) continue;
      fired.push({ repoName, jobName });
      // Record FIRST — so a runner crash doesn't cause a retry storm next tick.
      try {
        await recordRun(repo.statePath, key, now.toISOString());
      } catch (err) {
        log.error(
          `[scheduler] failed to persist last_run for ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const result = await runner({ repoName, jobName, cronExpr, repo, firedAt: now });
        if (!result.success) {
          log.warn(`[scheduler] job ${repoName}:${jobName} reported failure`);
        }
      } catch (err) {
        log.error(`[scheduler] job ${repoName}:${jobName} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return fired;
}

export interface ForeverOptions {
  /** Tick interval in milliseconds (default 30s). */
  intervalMs?: number;
  /** Abort signal — when fired, the loop exits at the next tick boundary. */
  signal?: AbortSignal;
}

/**
 * Long-running scheduler entry point. Polls `runSchedulerTick` at `intervalMs`
 * until the abort signal fires. Used by `kova schedule start`.
 */
export async function runSchedulerForever(
  config: SchedulerConfig,
  runner: SchedulerJobRunner,
  options: ForeverOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 30_000;
  const signal = options.signal;
  log.info(`[scheduler] starting — tick=${intervalMs}ms, repos=${Object.keys(config.repos).length}`);
  while (true) {
    if (signal?.aborted) {
      log.info('[scheduler] stop requested — exiting');
      return;
    }
    await runSchedulerTick(config, runner);
    if (signal?.aborted) return;
    await sleep(intervalMs, signal);
  }
}

/** Abortable sleep — resolves on abort or timeout. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Adapt a loaded `KovaConfig` into the runtime `SchedulerConfig` shape. The
 * state path defaults to `~/.kova` so a single state file tracks every repo's
 * schedule; callers can override per-repo.
 */
export function buildSchedulerConfig(kovaConfig: KovaConfig, defaultStatePath: string): SchedulerConfig {
  const repos: Record<string, SchedulerRepoConfig> = {};
  for (const [name, repo] of Object.entries(kovaConfig.repos)) {
    const entry: SchedulerRepoConfig = { statePath: defaultStatePath };
    if (repo.schedule !== undefined) entry.schedule = repo.schedule;
    if (repo.path !== undefined) entry.repoPath = repo.path;
    repos[name] = entry;
  }
  return { repos };
}
