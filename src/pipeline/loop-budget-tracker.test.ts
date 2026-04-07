import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSharedBudget } from './shared-budget.js';

const mockFix = vi.fn();
const mockFetchIssues = vi.fn();
const mockFetchOpenPRsDetailed = vi.fn();
const mockExtractPRFromResult = vi.fn();
const mockPrioritizeIssues = vi.fn();
const mockBuildRunReport = vi.fn().mockReturnValue({});
const mockPrintRunReport = vi.fn();
const mockWriteRunReport = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockFix.mockReset();
  mockFetchIssues.mockReset();
  mockFetchOpenPRsDetailed.mockReset().mockResolvedValue([]);
  mockExtractPRFromResult.mockReset();
  mockPrioritizeIssues.mockReset();
  mockBuildRunReport.mockClear();
  mockPrintRunReport.mockClear();
  mockWriteRunReport.mockClear();
});

vi.mock('../services/github.js', () => ({
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: (...args: unknown[]) => mockFetchOpenPRsDetailed(...args),
  extractPRFromResult: (...args: unknown[]) => mockExtractPRFromResult(...args),
}));

vi.mock('../services/prioritize.js', () => ({
  prioritizeIssues: (...args: unknown[]) => mockPrioritizeIssues(...args),
}));

vi.mock('../services/metrics.js', () => ({
  setCurrentCostUsd: vi.fn(),
}));

vi.mock('../services/shutdown.js', () => ({
  shutdownRequested: vi.fn().mockReturnValue(false),
}));

vi.mock('./fix.js', () => ({
  fix: (...args: unknown[]) => mockFix(...args),
}));

vi.mock('./run-report.js', () => ({
  buildRunReport: (...args: unknown[]) => mockBuildRunReport(...args),
  printRunReport: (...args: unknown[]) => mockPrintRunReport(...args),
  writeRunReport: (...args: unknown[]) => mockWriteRunReport(...args),
}));

const { fixLoop } = await import('./loop.js');

function makeIssue(n: number) {
  return { number: n, title: `Issue ${n}`, body: '', labels: [], url: '' };
}

function makeFixResult(cost: number) {
  return {
    success: true,
    prUrl: `https://github.com/o/r/pull/${cost}`,
    state: {
      issue: makeIssue(1),
      repo: 'test',
      repoPath: '/tmp/test',
      startedAt: '2026-01-01T00:00:00Z',
      completedWaves: [],
      waveResults: {
        assess: { wave: 'assess', success: true, artifact: {}, duration: 1000, cost, turns: 5 },
      },
      status: 'completed',
    },
  };
}

function makeConfig() {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const, concurrency: 1 },
    model: {
      assess: 'large' as const,
      spec: 'large' as const,
      test: 'medium' as const,
      impl: 'medium' as const,
      quality: 'small' as const,
      review: 'large' as const,
      brainstorm: 'large' as const,
    },
    isolation: 'none' as const,
  };
}

describe('fixLoop with budgetTracker', () => {
  it('reports cost to shared budget tracker after each fix', async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    mockFetchIssues.mockResolvedValue(issues);
    mockPrioritizeIssues.mockReturnValue(issues.map((i) => ({ issue: i, score: 50, blockedBy: [] })));
    mockFix.mockResolvedValueOnce(makeFixResult(2.0)).mockResolvedValueOnce(makeFixResult(3.0));

    const tracker = createSharedBudget(100);

    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test',
      config: makeConfig(),
      budgetTracker: tracker,
    });

    expect(tracker.totalSpent()).toBe(5.0);
  });

  it('stops when shared budget tracker reports exceeded', async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    mockFetchIssues.mockResolvedValue(issues);
    mockPrioritizeIssues.mockReturnValue(issues.map((i) => ({ issue: i, score: 50, blockedBy: [] })));
    mockFix.mockResolvedValue(makeFixResult(4.0));

    const tracker = createSharedBudget(5); // budget = $5, each fix costs $4

    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test',
      config: makeConfig(),
      budgetTracker: tracker,
    });

    // Should stop after first fix ($4 < $5 budget, but after fix #1,
    // tracker has $4 which is < $5, so fix #2 starts, costing $4 more → $8 > $5)
    // Actually: fix #1 costs $4 → not exceeded yet. fix #2 costs $4 → total $8 ≥ $5 → stop.
    expect(result.budgetExceeded).toBe(true);
    expect(mockFix).toHaveBeenCalledTimes(2); // 2nd fix runs, then budget check fires
  });

  it('shared tracker takes precedence over per-loop budgetUsd', async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    mockFetchIssues.mockResolvedValue(issues);
    mockPrioritizeIssues.mockReturnValue(issues.map((i) => ({ issue: i, score: 50, blockedBy: [] })));
    mockFix.mockResolvedValue(makeFixResult(3.0));

    const tracker = createSharedBudget(5); // shared limit: $5

    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test',
      config: makeConfig(),
      budgetUsd: 100, // local limit: $100 (should be ignored)
      budgetTracker: tracker,
    });

    // Shared tracker at $5 should stop, not the $100 local budget
    expect(result.budgetExceeded).toBe(true);
    expect(tracker.totalSpent()).toBe(6.0); // 2 fixes at $3 each
  });
});
