// Tests for cron-state — persisted last_run per job (issue #303).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScheduleState, recordRun, scheduleStateKey, scheduleStatePath } from './cron-state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kova-cron-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scheduleStateKey', () => {
  it('joins repo and job with a colon', () => {
    expect(scheduleStateKey('onexos-io/onexos', 'backlog_sweep')).toBe('onexos-io/onexos:backlog_sweep');
  });
});

describe('scheduleStatePath', () => {
  it('returns <root>/.kova/schedule-state.json', () => {
    expect(scheduleStatePath('/x/y')).toBe('/x/y/.kova/schedule-state.json');
  });
});

describe('loadScheduleState', () => {
  it('returns an empty record when the state file is missing', async () => {
    const state = await loadScheduleState(dir);
    expect(state).toEqual({});
  });

  it('reads previously persisted state', async () => {
    await writeFile(
      scheduleStatePath(dir),
      JSON.stringify({ 'r:job': { last_run_iso: '2026-01-01T00:00:00.000Z' } }),
      // mkdir handled by recordRun; for this seed we make the dir ourselves
      { flag: 'wx' },
    ).catch(async () => {
      // dir didn't exist — create + retry
      await (await import('node:fs/promises')).mkdir(join(dir, '.kova'), { recursive: true });
      await writeFile(
        scheduleStatePath(dir),
        JSON.stringify({ 'r:job': { last_run_iso: '2026-01-01T00:00:00.000Z' } }),
      );
    });
    const state = await loadScheduleState(dir);
    expect(state['r:job']?.last_run_iso).toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats corrupted JSON as empty state (resilient)', async () => {
    await (await import('node:fs/promises')).mkdir(join(dir, '.kova'), { recursive: true });
    await writeFile(scheduleStatePath(dir), '}}}not valid');
    const state = await loadScheduleState(dir);
    expect(state).toEqual({});
  });
});

describe('recordRun', () => {
  it('creates the .kova directory and writes last_run', async () => {
    await recordRun(dir, 'demo:nightly', '2026-06-01T02:00:00.000Z');
    const raw = await readFile(scheduleStatePath(dir), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, { last_run_iso: string }>;
    expect(parsed['demo:nightly']?.last_run_iso).toBe('2026-06-01T02:00:00.000Z');
  });

  it('preserves other jobs when updating one', async () => {
    await recordRun(dir, 'a:one', '2026-06-01T01:00:00.000Z');
    await recordRun(dir, 'b:two', '2026-06-01T02:00:00.000Z');
    const state = await loadScheduleState(dir);
    expect(state['a:one']?.last_run_iso).toBe('2026-06-01T01:00:00.000Z');
    expect(state['b:two']?.last_run_iso).toBe('2026-06-01T02:00:00.000Z');
  });

  it('overwrites prior last_run for the same key', async () => {
    await recordRun(dir, 'a:one', '2026-06-01T01:00:00.000Z');
    await recordRun(dir, 'a:one', '2026-06-02T01:00:00.000Z');
    const state = await loadScheduleState(dir);
    expect(state['a:one']?.last_run_iso).toBe('2026-06-02T01:00:00.000Z');
  });
});
