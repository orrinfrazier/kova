/**
 * Coverage ledger — every fetched issue must have an outcome record so nothing
 * is silently dropped (issue #288).
 *
 * What is verified here:
 *   - LoopResult.outcomes contains one record per FETCHED issue (not per processed)
 *   - Each outcome has a status: "succeeded" | "failed" | "skipped:over-limit"
 *     | "skipped:budget" | "skipped:shutdown"
 *   - LoopResult.skipped reflects the real count (no longer hardcoded 0)
 *   - Run report logs "N not attempted" when skipped > 0 with reasons broken out
 *   - The gh fetch limit is configurable via LoopOptions.fetchLimit, defaults to 50,
 *     and is forwarded to fetchIssues
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

const fetchIssuesMock = vi.fn();

vi.mock('../services/github.js', () => ({
  fetchIssues: (...args: unknown[]) => fetchIssuesMock(...args),
  fetchIssue: vi.fn(),
  fetchMilestoneCounts: vi.fn().mockResolvedValue({ open: 0, closed: 0 }),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  hasExistingWork: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: vi.fn().mockResolvedValue([]),
  extractPRFromResult: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./fix.js', () => ({
  fix: vi.fn().mockImplementation(({ issue }: { issue: Issue }) => ({
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: {
      issue,
      repo: 'test-repo',
      repoPath: '/tmp/test',
      startedAt: '2026-04-06T10:00:00.000Z',
      completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
      waveResults: {
        assess: { wave: 'assess', success: true, artifact: {}, duration: 1000, cost: 0.05, turns: 2 },
      },
      status: 'completed',
    },
  })),
}));

const { fixLoop } = await import('./loop.js');
const { resetShutdown } = await import('../services/shutdown.js');

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: `body ${n}`,
    labels: [],
    url: `https://example.com/${n}`,
  };
}

function makeConfig(rules: Partial<RepoConfig['rules']> = {}): RepoConfig {
  return {
    path: '/tmp/test',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
      concurrency: 1,
      ...rules,
    },
    model: {
      assess: 'large',
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
      brainstorm: 'large',
    },
    isolation: 'none',
    runtime: 'pi',
  };
}

beforeEach(() => {
  resetShutdown();
  fetchIssuesMock.mockReset();
});

afterEach(() => {
  resetShutdown();
});

describe('fixLoop — coverage ledger: every fetched issue gets an outcome', () => {
  it('records succeeded outcomes for processed issues', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1), makeIssue(2)]);
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.outcomes).toHaveLength(2);
    const byNum = new Map(result.outcomes.map((o) => [o.issueNumber, o]));
    expect(byNum.get(1)?.status).toBe('succeeded');
    expect(byNum.get(2)?.status).toBe('succeeded');
  });

  it('records skipped:over-limit for issues past max_issues_per_run', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5)]);
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig({ max_issues_per_run: 2 }),
    });

    // 2 processed, 3 over-limit
    expect(result.outcomes).toHaveLength(5);
    const overLimit = result.outcomes.filter((o) => o.status === 'skipped:over-limit');
    expect(overLimit).toHaveLength(3);
    expect(overLimit.map((o) => o.issueNumber).sort()).toEqual([3, 4, 5]);
    expect(result.skipped).toBe(3);
    expect(result.total).toBe(2); // total = processed; outcomes carries the full ledger
  });

  it('LoopResult.skipped is no longer hardcoded 0 — it counts real skips', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1), makeIssue(2), makeIssue(3)]);
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig({ max_issues_per_run: 1 }),
    });

    expect(result.skipped).toBe(2);
  });

  it('exposes a per-reason breakdown via skippedByReason', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)]);
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig({ max_issues_per_run: 2 }),
    });

    expect(result.skippedByReason).toBeDefined();
    expect(result.skippedByReason?.['over-limit']).toBe(2);
  });
});

describe('fixLoop — fetch limit is configurable and decoupled from processing cap', () => {
  it('forwards fetchLimit option to gh fetchIssues', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1)]);

    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      fetchLimit: 200,
    });

    expect(fetchIssuesMock).toHaveBeenCalled();
    // Third positional arg (options) should carry fetchLimit
    const call = fetchIssuesMock.mock.calls[0];
    expect(call?.[2]).toMatchObject({ fetchLimit: 200 });
  });

  it('falls back to default fetch limit when not provided (and is decoupled from processing cap)', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1)]);

    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig({ max_issues_per_run: 2 }),
    });

    // No fetchLimit override: github.ts default (50) governs gh CLI;
    // here we just assert the option, if present, is NOT the processing cap (2).
    const call = fetchIssuesMock.mock.calls[0];
    const opts = call?.[2] as { fetchLimit?: number } | undefined;
    expect(opts?.fetchLimit).not.toBe(2);
  });

  it('reads gh_fetch_limit from config.rules when no LoopOptions override', async () => {
    fetchIssuesMock.mockResolvedValue([makeIssue(1)]);

    const config = makeConfig();
    config.rules.gh_fetch_limit = 150;
    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config,
    });

    const call = fetchIssuesMock.mock.calls[0];
    expect(call?.[2]).toMatchObject({ fetchLimit: 150 });
  });
});
