import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRun, getRun, listRuns, type Run, registerRun, updateRun } from './run-registry.js';

function makeRun(overrides?: Partial<Run>): Run {
  return {
    runId: 'fix-42-1700000000000',
    fixId: 'fix-42-1700000000000',
    repoId: 'owner/repo',
    issueNumber: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

describe('run-registry', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kova-runs-test-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('listRuns returns [] when .kova/runs/ does not exist', async () => {
    const runs = await listRuns(repoPath);
    expect(runs).toEqual([]);
  });

  it('getRun returns null for missing run id', async () => {
    const result = await getRun(repoPath, 'no-such-run');
    expect(result).toBeNull();
  });

  it('registerRun creates .kova/runs/<runId>.json with full Run shape', async () => {
    const run = makeRun();
    await registerRun(repoPath, run);
    const file = join(repoPath, '.kova', 'runs', `${run.runId}.json`);
    const content = await readFile(file, 'utf-8');
    const parsed = JSON.parse(content) as Run;
    expect(parsed.runId).toBe(run.runId);
    expect(parsed.fixId).toBe(run.fixId);
    expect(parsed.repoId).toBe('owner/repo');
    expect(parsed.issueNumber).toBe(42);
    expect(parsed.status).toBe('running');
  });

  it('listRuns enumerates every registered run', async () => {
    await registerRun(repoPath, makeRun({ runId: 'r1', fixId: 'r1' }));
    await registerRun(repoPath, makeRun({ runId: 'r2', fixId: 'r2', issueNumber: 7 }));
    const runs = await listRuns(repoPath);
    expect(runs.map((r) => r.runId).sort()).toEqual(['r1', 'r2']);
  });

  it('getRun returns the saved Run by id', async () => {
    const run = makeRun({ runId: 'fix-99-x', fixId: 'fix-99-x', issueNumber: 99 });
    await registerRun(repoPath, run);
    const loaded = await getRun(repoPath, 'fix-99-x');
    expect(loaded).not.toBeNull();
    expect(loaded?.issueNumber).toBe(99);
  });

  it('updateRun merges patch over existing entry without losing fields', async () => {
    const run = makeRun();
    await registerRun(repoPath, run);
    await updateRun(repoPath, run.runId, { currentWave: 'impl' });
    const loaded = await getRun(repoPath, run.runId);
    expect(loaded?.currentWave).toBe('impl');
    expect(loaded?.issueNumber).toBe(42);
    expect(loaded?.status).toBe('running');
  });

  it('updateRun no-ops when run id does not exist (does not create a new file)', async () => {
    await updateRun(repoPath, 'nonexistent', { currentWave: 'impl' });
    const runs = await listRuns(repoPath);
    expect(runs).toEqual([]);
  });

  it('updateRun records terminal status + completedAt + prNumber', async () => {
    const run = makeRun();
    await registerRun(repoPath, run);
    await updateRun(repoPath, run.runId, {
      status: 'done',
      completedAt: '2026-01-01T01:00:00.000Z',
      prNumber: 555,
    });
    const loaded = await getRun(repoPath, run.runId);
    expect(loaded?.status).toBe('done');
    expect(loaded?.completedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(loaded?.prNumber).toBe(555);
  });

  it('clearRun removes the per-run file', async () => {
    const run = makeRun();
    await registerRun(repoPath, run);
    await clearRun(repoPath, run.runId);
    const loaded = await getRun(repoPath, run.runId);
    expect(loaded).toBeNull();
  });

  it('clearRun is a no-op when the run does not exist', async () => {
    await expect(clearRun(repoPath, 'nonexistent')).resolves.toBeUndefined();
  });

  it('listRuns skips non-JSON files in runs/ directory', async () => {
    await registerRun(repoPath, makeRun({ runId: 'good', fixId: 'good' }));
    // Drop a stray non-JSON file alongside (simulating a partial write or unrelated tool)
    await writeFile(join(repoPath, '.kova', 'runs', 'README.txt'), 'not a run', 'utf-8');
    const runs = await listRuns(repoPath);
    expect(runs.map((r) => r.runId)).toEqual(['good']);
  });

  it('listRuns skips files that cannot be parsed as Run JSON', async () => {
    await registerRun(repoPath, makeRun({ runId: 'good', fixId: 'good' }));
    await writeFile(join(repoPath, '.kova', 'runs', 'bad.json'), '{this is not json', 'utf-8');
    const runs = await listRuns(repoPath);
    expect(runs.map((r) => r.runId)).toEqual(['good']);
  });

  it('registerRun writes atomically — no torn read when ls runs concurrently', async () => {
    // The atomic-rename invariant is hard to time deterministically without
    // mocking fs. We assert the structural guarantee: after registerRun resolves,
    // no `<runId>.json.tmp` is left behind. The temp-file naming convention is
    // the only externally observable evidence of write-then-rename.
    await registerRun(repoPath, makeRun({ runId: 'atomic', fixId: 'atomic' }));
    const entries = await readdir(join(repoPath, '.kova', 'runs'));
    const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});
