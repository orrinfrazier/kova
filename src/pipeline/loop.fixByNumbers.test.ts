import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/github.js', () => ({
  fetchIssue: vi.fn().mockImplementation((_repoPath: string, issueNumber: number) =>
    Promise.resolve({
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: `body ${issueNumber}`,
      labels: [],
      url: `https://example.com/${issueNumber}`,
    }),
  ),
  fetchIssues: vi.fn().mockResolvedValue([]),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
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
        assess: { wave: 'assess', success: true, artifact: {}, duration: 3000, cost: 0.1, turns: 5 },
        spec: { wave: 'spec', success: true, artifact: {}, duration: 2000, cost: 0.08, turns: 3 },
        test: { wave: 'test', success: true, artifact: {}, duration: 5000, cost: 0.12, turns: 10 },
        impl: { wave: 'impl', success: true, artifact: {}, duration: 8000, cost: 0.18, turns: 15 },
        quality: { wave: 'quality', success: true, artifact: {}, duration: 1500, cost: 0.02, turns: 4 },
        review: { wave: 'review', success: true, artifact: {}, duration: 4000, cost: 0.08, turns: 6 },
        ship: { wave: 'ship', success: true, artifact: {}, duration: 500, cost: 0, turns: 0 },
      },
      status: 'completed',
    },
  })),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: vi.fn().mockResolvedValue([]),
  extractPRFromResult: vi.fn().mockReturnValue(undefined),
  formatPRContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/shutdown.js', () => ({
  shutdownRequested: vi.fn().mockReturnValue(false),
  getShutdownSignal: vi.fn().mockReturnValue(undefined),
  installSignalHandlers: vi.fn(),
  removeSignalHandlers: vi.fn(),
  resetShutdown: vi.fn(),
  exitCodeForSignal: vi.fn().mockReturnValue(0),
}));

const { fixByNumbers } = await import('./loop.js');

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
      concurrency: 1,
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

describe('fixByNumbers — core behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches each issue by number and calls fix() for each', async () => {
    const { fetchIssue } = await import('../services/github.js');
    const { fix } = await import('./fix.js');

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [3, 7, 42],
    });

    expect(fetchIssue).toHaveBeenCalledTimes(3);
    expect(fetchIssue).toHaveBeenCalledWith('/tmp/test', 3);
    expect(fetchIssue).toHaveBeenCalledWith('/tmp/test', 7);
    expect(fetchIssue).toHaveBeenCalledWith('/tmp/test', 42);
    expect(fix).toHaveBeenCalledTimes(3);
  });

  it('calls fix() issues in the order given', async () => {
    const { fix } = await import('./fix.js');
    const fixMock = vi.mocked(fix);

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [10, 5, 20],
    });

    expect(fixMock.mock.calls[0]?.[0].issue.number).toBe(10);
    expect(fixMock.mock.calls[1]?.[0].issue.number).toBe(5);
    expect(fixMock.mock.calls[2]?.[0].issue.number).toBe(20);
  });

  it('returns empty result when issueNumbers is empty', async () => {
    const { fix } = await import('./fix.js');

    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [],
    });

    expect(fix).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.budgetExceeded).toBe(false);
    expect(result.results).toEqual([]);
  });
});

describe('fixByNumbers — LoopResult aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns totalCost aggregated across all issues', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    // Each issue costs 0.58 (sum of wave costs), two issues = 1.16
    expect(result.totalCost).toBeCloseTo(1.16, 2);
  });

  it('returns totalTurns aggregated across all issues', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    // Each issue has 43 turns (5+3+10+15+4+6+0), two issues = 86
    expect(result.totalTurns).toBe(86);
  });

  it('returns totalDuration aggregated across all issues', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    // Each issue has 24000ms (3000+2000+5000+8000+1500+4000+500), two issues = 48000
    expect(result.totalDuration).toBe(48000);
  });

  it('returns startedAt timestamp', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1],
    });

    expect(result.startedAt).toBeDefined();
    expect(new Date(result.startedAt).getTime()).toBeGreaterThan(0);
  });

  it('returns correct succeeded and failed counts', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2, 3],
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
  });
});

describe('fixByNumbers — budget cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops when budget cap exceeded after completing an issue', async () => {
    // Each issue costs 0.58, budget 0.5 means first issue exceeds it
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2, 3],
      budgetUsd: 0.5,
    });

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it('processes all issues when budget is sufficient', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
      budgetUsd: 5.0,
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.budgetExceeded).toBe(false);
  });

  it('processes all issues when budgetUsd is undefined (unlimited)', async () => {
    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2, 3],
    });

    expect(result.total).toBe(3);
    expect(result.budgetExceeded).toBe(false);
  });
});

describe('fixByNumbers — shutdown check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops when shutdownRequested returns true between issues', async () => {
    const { shutdownRequested } = await import('../services/shutdown.js');
    const shutdownMock = vi.mocked(shutdownRequested);

    // Return false for first issue, true after (stopping before second)
    shutdownMock.mockReturnValueOnce(false).mockReturnValue(true);

    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2, 3],
    });

    expect(result.total).toBe(1);
  });

  it('checks shutdownRequested between each issue', async () => {
    const { shutdownRequested } = await import('../services/shutdown.js');
    const shutdownMock = vi.mocked(shutdownRequested);
    shutdownMock.mockReturnValue(false);

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2, 3],
    });

    // shutdownRequested should be called once per issue (after each fix)
    expect(shutdownMock).toHaveBeenCalledTimes(3);
  });
});

describe('fixByNumbers — PR context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads open PRs for conflict awareness', async () => {
    const { fetchOpenPRsDetailed } = await import('../services/pr-context.js');

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1],
    });

    expect(fetchOpenPRsDetailed).toHaveBeenCalledWith('/tmp/test');
  });

  it('passes loaded open PRs to fix() calls', async () => {
    const { fetchOpenPRsDetailed } = await import('../services/pr-context.js');
    const { fix } = await import('./fix.js');

    const openPRs = [
      {
        number: 99,
        title: 'Existing PR',
        branch: 'fix/something',
        files: ['src/index.ts'],
      },
    ];
    vi.mocked(fetchOpenPRsDetailed).mockResolvedValue(openPRs);

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1],
    });

    expect(vi.mocked(fix)).toHaveBeenCalledWith(expect.objectContaining({ pendingPRs: openPRs }));
  });

  it('accumulates new PRs from successful fixes and passes them to subsequent calls', async () => {
    const { extractPRFromResult } = await import('../services/pr-context.js');
    const { fix } = await import('./fix.js');
    const fixMock = vi.mocked(fix);

    const newPR = {
      number: 10,
      title: 'New PR for issue 1',
      branch: 'fix/issue-1',
      files: ['src/fix.ts'],
    };
    vi.mocked(extractPRFromResult).mockReturnValue(newPR);

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    // First call: no accumulated PRs yet (only initial open PRs, which are empty)
    expect(fixMock.mock.calls[0]?.[0].pendingPRs).not.toContainEqual(newPR);

    // Second call: should include the PR created from fixing issue 1
    expect(fixMock.mock.calls[1]?.[0].pendingPRs).toContainEqual(newPR);
  });
});

describe('fixByNumbers — run report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes run report at end', async () => {
    const { writeRunReport } = await import('./run-report.js');

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    expect(writeRunReport).toHaveBeenCalledOnce();
    expect(writeRunReport).toHaveBeenCalledWith('/tmp/test', expect.anything());
  });

  it('builds and prints run report at end', async () => {
    const { buildRunReport, printRunReport } = await import('./run-report.js');

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1],
    });

    expect(buildRunReport).toHaveBeenCalledOnce();
    expect(printRunReport).toHaveBeenCalledOnce();
  });
});

describe('fixByNumbers — failed fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts failed fixes and continues to next issue', async () => {
    const { fix } = await import('./fix.js');
    const fixMock = vi.mocked(fix);

    // First issue fails, second succeeds
    fixMock
      .mockImplementationOnce(async ({ issue }: { issue: Issue }) => ({
        success: false,
        error: 'Wave failed',
        state: {
          issue,
          repo: 'test-repo',
          repoPath: '/tmp/test',
          startedAt: '2026-04-06T10:00:00.000Z',
          completedWaves: ['assess'],
          waveResults: {
            assess: { wave: 'assess', success: false, artifact: {}, duration: 1000, cost: 0.05, turns: 2 },
          },
          status: 'failed',
        },
      }))
      .mockImplementationOnce(async ({ issue }: { issue: Issue }) => ({
        success: true,
        prUrl: `https://github.com/test/repo/pull/${issue.number}`,
        state: {
          issue,
          repo: 'test-repo',
          repoPath: '/tmp/test',
          startedAt: '2026-04-06T10:00:00.000Z',
          completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
          waveResults: {
            assess: { wave: 'assess', success: true, artifact: {}, duration: 3000, cost: 0.1, turns: 5 },
            spec: { wave: 'spec', success: true, artifact: {}, duration: 2000, cost: 0.08, turns: 3 },
            test: { wave: 'test', success: true, artifact: {}, duration: 5000, cost: 0.12, turns: 10 },
            impl: { wave: 'impl', success: true, artifact: {}, duration: 8000, cost: 0.18, turns: 15 },
            quality: { wave: 'quality', success: true, artifact: {}, duration: 1500, cost: 0.02, turns: 4 },
            review: { wave: 'review', success: true, artifact: {}, duration: 4000, cost: 0.08, turns: 6 },
            ship: { wave: 'ship', success: true, artifact: {}, duration: 500, cost: 0, turns: 0 },
          },
          status: 'completed',
        },
      }));

    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(fixMock).toHaveBeenCalledTimes(2);
  });

  it('includes failed results in results array', async () => {
    const { fix } = await import('./fix.js');
    vi.mocked(fix).mockImplementationOnce(async ({ issue }: { issue: Issue }) => ({
      success: false,
      error: 'Something went wrong',
      state: {
        issue,
        repo: 'test-repo',
        repoPath: '/tmp/test',
        startedAt: '2026-04-06T10:00:00.000Z',
        completedWaves: [],
        waveResults: {},
        status: 'failed',
      },
    }));

    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.result.success).toBe(false);
  });
});

describe('fixByNumbers — fetchIssue error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues to next issue when fetchIssue throws (e.g., issue deleted)', async () => {
    const { fetchIssue } = await import('../services/github.js');
    const { fix } = await import('./fix.js');
    const fetchMock = vi.mocked(fetchIssue);

    // First issue fetch fails, second succeeds
    fetchMock.mockRejectedValueOnce(new Error('issue not found')).mockResolvedValueOnce({
      number: 2,
      title: 'Issue 2',
      body: 'body 2',
      labels: [],
      url: 'https://example.com/2',
    });

    const result = await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      issueNumbers: [1, 2],
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.total).toBe(2);
    expect(vi.mocked(fix)).toHaveBeenCalledTimes(1);
  });
});
