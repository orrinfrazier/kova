// Tests for cron-scheduler — orchestrates jobs with injectable clock + runner (issue #303).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSchedules, runSchedulerTick, type SchedulerJobRunner } from './cron-scheduler.js';
import { loadScheduleState } from './cron-state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kova-cron-sched-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NIGHTLY = '0 2 * * *';
const HOURLY = '0 * * * *';

describe('listSchedules', () => {
  it('returns one entry per (repo, job) with last_run from state', async () => {
    const config = {
      repos: {
        alpha: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir },
        beta: { schedule: { weekly_audit: '0 0 * * 1' }, statePath: dir },
      },
    };
    const rows = await listSchedules(config);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.repoName === 'alpha' && r.jobName === 'backlog_sweep')?.cronExpr).toBe(NIGHTLY);
    expect(rows.find((r) => r.repoName === 'beta')?.lastRun).toBeUndefined();
  });

  it('includes last_run when persisted', async () => {
    const { recordRun } = await import('./cron-state.js');
    await recordRun(dir, 'alpha:backlog_sweep', '2026-05-31T02:00:00.000Z');
    const config = {
      repos: {
        alpha: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir },
      },
    };
    const rows = await listSchedules(config);
    expect(rows[0]?.lastRun).toBe('2026-05-31T02:00:00.000Z');
  });

  it('returns an empty array when no repos have a schedule', async () => {
    const rows = await listSchedules({ repos: { alpha: { statePath: dir } } });
    expect(rows).toEqual([]);
  });
});

describe('runSchedulerTick', () => {
  it('fires due jobs and records last_run', async () => {
    const runner: SchedulerJobRunner = vi.fn(async () => ({ success: true }));
    const config = {
      repos: { alpha: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir } },
    };
    const now = new Date('2026-06-01T02:00:30.000Z');
    const fired = await runSchedulerTick(config, runner, { now });
    expect(fired).toEqual([{ repoName: 'alpha', jobName: 'backlog_sweep' }]);
    expect(runner).toHaveBeenCalledOnce();
    const state = await loadScheduleState(dir);
    expect(state['alpha:backlog_sweep']?.last_run_iso).toBe(now.toISOString());
  });

  it('does not fire jobs that already ran for the current slot', async () => {
    const { recordRun } = await import('./cron-state.js');
    await recordRun(dir, 'alpha:backlog_sweep', '2026-06-01T02:00:00.000Z');
    const runner: SchedulerJobRunner = vi.fn(async () => ({ success: true }));
    const config = {
      repos: { alpha: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir } },
    };
    const fired = await runSchedulerTick(config, runner, { now: new Date('2026-06-01T03:00:00.000Z') });
    expect(fired).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('one failing job does not prevent other jobs from firing', async () => {
    const runner: SchedulerJobRunner = vi.fn(async ({ repoName }) => {
      if (repoName === 'alpha') throw new Error('boom');
      return { success: true };
    });
    const config = {
      repos: {
        alpha: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir },
        beta: { schedule: { backlog_sweep: NIGHTLY }, statePath: dir },
      },
    };
    const now = new Date('2026-06-01T02:00:30.000Z');
    const fired = await runSchedulerTick(config, runner, { now });
    expect(fired.map((f) => f.repoName).sort()).toEqual(['alpha', 'beta']);
    expect(runner).toHaveBeenCalledTimes(2);
    // Both runs are recorded — including the failed one (so we don't retry-storm next tick).
    const state = await loadScheduleState(dir);
    expect(state['alpha:backlog_sweep']?.last_run_iso).toBe(now.toISOString());
    expect(state['beta:backlog_sweep']?.last_run_iso).toBe(now.toISOString());
  });

  it('skips repos without a schedule block', async () => {
    const runner: SchedulerJobRunner = vi.fn(async () => ({ success: true }));
    const config = { repos: { alpha: { statePath: dir } } };
    const fired = await runSchedulerTick(config, runner, { now: new Date('2026-06-01T02:00:30.000Z') });
    expect(fired).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('fires multiple jobs per repo', async () => {
    const runner: SchedulerJobRunner = vi.fn(async () => ({ success: true }));
    const config = {
      repos: {
        alpha: {
          schedule: { backlog_sweep: NIGHTLY, hourly_check: HOURLY },
          statePath: dir,
        },
      },
    };
    const now = new Date('2026-06-01T02:00:30.000Z');
    const fired = await runSchedulerTick(config, runner, { now });
    expect(fired.map((f) => f.jobName).sort()).toEqual(['backlog_sweep', 'hourly_check']);
  });
});
