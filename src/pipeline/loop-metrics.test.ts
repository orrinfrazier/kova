import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Metrics mock ---
const mockSetCurrentCostUsd = vi.fn();

vi.mock('../services/metrics.js', () => ({
  setCurrentCostUsd: (...args: unknown[]) => mockSetCurrentCostUsd(...args),
  recordWaveCompleted: vi.fn(),
  recordWaveDuration: vi.fn(),
  recordIssueFixed: vi.fn(),
  recordIssueFailed: vi.fn(),
  recordPRCreated: vi.fn(),
  setActiveFixes: vi.fn(),
  recordFixDuration: vi.fn(),
  recordFixCost: vi.fn(),
  serialize: vi.fn().mockReturnValue(''),
  reset: vi.fn(),
}));

// --- Other mocks ---
vi.mock('../services/github.js', () => ({
  fetchIssues: vi.fn().mockResolvedValue([
    { number: 1, title: 'Issue 1', body: 'body 1', labels: [], url: 'https://github.com/o/r/issues/1' },
    { number: 2, title: 'Issue 2', body: 'body 2', labels: [], url: 'https://github.com/o/r/issues/2' },
  ]),
  fetchIssue: vi.fn(),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/o/r/pull/1'),
  commentOnIssue: vi.fn(),
}));

vi.mock('../services/prioritize.js', () => ({
  prioritizeIssues: vi
    .fn()
    .mockImplementation((issues: unknown[]) => issues.map((issue, i) => ({ issue, score: 10 - i }))),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: vi.fn().mockResolvedValue([]),
  extractPRFromResult: vi.fn().mockReturnValue(null),
  formatPRContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/shutdown.js', () => ({
  shutdownRequested: vi.fn().mockReturnValue(false),
}));

// Mock fix to return controlled results with known costs
const mockFix = vi.fn();
vi.mock('./fix.js', () => ({
  fix: (...args: unknown[]) => mockFix(...args),
}));

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

const { fixLoop } = await import('./loop.js');

describe('fixLoop — metrics instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFix.mockImplementation(async (options: { issue: { number: number } }) => ({
      success: true,
      prUrl: `https://github.com/o/r/pull/${options.issue.number}`,
      state: {
        issue: options.issue,
        repo: 'test-repo',
        repoPath: '/tmp/test',
        startedAt: new Date().toISOString(),
        completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
        waveResults: {
          assess: { wave: 'assess', success: true, artifact: {}, duration: 100, cost: 0.05, turns: 1 },
          spec: { wave: 'spec', success: true, artifact: {}, duration: 200, cost: 0.1, turns: 2 },
          test: { wave: 'test', success: true, artifact: {}, duration: 300, cost: 0.08, turns: 1 },
          impl: { wave: 'impl', success: true, artifact: {}, duration: 400, cost: 0.12, turns: 3 },
          quality: { wave: 'quality', success: true, artifact: {}, duration: 100, cost: 0.02, turns: 1 },
          review: { wave: 'review', success: true, artifact: {}, duration: 200, cost: 0.05, turns: 1 },
          ship: { wave: 'ship', success: true, artifact: {}, duration: 0, cost: 0, turns: 0 },
        },
        status: 'completed',
      },
    }));
  });

  it('updates current_cost_usd gauge after each issue completes', async () => {
    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: {
        path: '/tmp/test',
        rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const },
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
      },
    });

    // fix was called twice (2 issues), so setCurrentCostUsd should be called twice
    expect(mockSetCurrentCostUsd).toHaveBeenCalledTimes(2);

    // First call: cost from issue 1
    const firstCost = mockSetCurrentCostUsd.mock.calls[0]?.[0] as number;
    expect(firstCost).toBeGreaterThan(0);

    // Second call: cumulative cost from issue 1 + issue 2
    const secondCost = mockSetCurrentCostUsd.mock.calls[1]?.[0] as number;
    expect(secondCost).toBeGreaterThan(firstCost);
  });
});
