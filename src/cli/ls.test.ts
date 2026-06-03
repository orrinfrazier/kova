import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Run, registerRun } from '../telemetry/run-registry.js';
import { formatLsTable, gatherLs, type LsResult } from './ls.js';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

function makeRun(overrides?: Partial<Run>): Run {
  return {
    runId: 'fix-1-t',
    fixId: 'fix-1-t',
    repoId: 'owner/repo',
    issueNumber: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

describe('kova ls command — CLI surface', () => {
  it('CLI source registers an ls command', () => {
    const src = getCliSource();
    expect(src).toContain(".command('ls')");
  });

  it('CLI source imports from ./ls.js', () => {
    const src = getCliSource();
    expect(src).toContain('./ls.js');
  });

  it('ls command supports --json output', () => {
    const src = getCliSource();
    expect(src.match(/\.command\('ls'\)[\s\S]*?\.action\(/)).toBeTruthy();
    // Match anywhere in the ls block:
    const lsBlock = src.split(".command('ls')")[1]?.split('.action(')[0] ?? '';
    expect(lsBlock).toMatch(/--json/);
  });
});

describe('gatherLs(repoPath) returns the LsResult for the repo', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kova-ls-test-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('returns an empty list when no runs are registered', async () => {
    const result: LsResult = await gatherLs(repoPath);
    expect(result.runs).toEqual([]);
  });

  it('lists every registered run', async () => {
    await registerRun(repoPath, makeRun({ runId: 'a', fixId: 'a', issueNumber: 1 }));
    await registerRun(
      repoPath,
      makeRun({ runId: 'b', fixId: 'b', issueNumber: 2, status: 'done', completedAt: '2026-01-01T01:00:00.000Z' }),
    );
    const result = await gatherLs(repoPath);
    expect(result.runs.map((r) => r.runId).sort()).toEqual(['a', 'b']);
  });

  it('newest runs come first (sorted by startedAt desc)', async () => {
    await registerRun(repoPath, makeRun({ runId: 'old', fixId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    await registerRun(repoPath, makeRun({ runId: 'new', fixId: 'new', startedAt: '2026-01-02T00:00:00.000Z' }));
    const result = await gatherLs(repoPath);
    expect(result.runs[0]?.runId).toBe('new');
    expect(result.runs[1]?.runId).toBe('old');
  });
});

describe('formatLsTable(result) renders a table', () => {
  it('renders the empty-state row when no runs are present', () => {
    const out = formatLsTable({ runs: [] });
    expect(out).toMatch(/no.+runs/i);
  });

  it('renders one row per run including the issue + status columns', () => {
    const out = formatLsTable({
      runs: [
        makeRun({ runId: 'fix-12-a', issueNumber: 12, status: 'running', currentWave: 'impl' }),
        makeRun({
          runId: 'fix-7-b',
          issueNumber: 7,
          status: 'done',
          completedAt: '2026-01-01T01:00:00.000Z',
          prNumber: 555,
        }),
      ],
    });
    expect(out).toMatch(/fix-12-a/);
    expect(out).toMatch(/fix-7-b/);
    expect(out).toMatch(/#12/);
    expect(out).toMatch(/#7/);
    expect(out).toMatch(/running/);
    expect(out).toMatch(/done/);
    expect(out).toMatch(/impl/);
  });

  it('includes Run ID, Issue, Repo, Status, Started, Wave headers', () => {
    const out = formatLsTable({
      runs: [makeRun()],
    });
    for (const h of ['Run ID', 'Issue', 'Repo', 'Status', 'Started', 'Wave']) {
      expect(out).toContain(h);
    }
  });
});
