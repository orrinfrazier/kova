import { describe, expect, it } from 'vitest';
import type { LoopResult } from './loop.js';
import { buildMultiRepoRunReport, printMultiRepoRunReport } from './run-report.js';

function makeLoopResult(overrides?: {
  succeeded?: number;
  failed?: number;
  totalCost?: number;
  totalTurns?: number;
  totalDuration?: number;
}): LoopResult {
  return {
    total: (overrides?.succeeded ?? 2) + (overrides?.failed ?? 0),
    succeeded: overrides?.succeeded ?? 2,
    failed: overrides?.failed ?? 0,
    skipped: 0,
    totalCost: overrides?.totalCost ?? 1.0,
    totalTurns: overrides?.totalTurns ?? 50,
    totalDuration: overrides?.totalDuration ?? 30000,
    budgetExceeded: false,
    startedAt: '2026-01-01T00:00:00Z',
    results: [],
  };
}

describe('buildMultiRepoRunReport', () => {
  it('aggregates totals across repos', () => {
    const repoResults = [
      {
        repoName: 'repo-a',
        loopResult: makeLoopResult({ succeeded: 3, failed: 1, totalCost: 2.5, totalTurns: 40, totalDuration: 20000 }),
      },
      {
        repoName: 'repo-b',
        loopResult: makeLoopResult({ succeeded: 2, failed: 0, totalCost: 1.5, totalTurns: 30, totalDuration: 15000 }),
      },
    ];

    const report = buildMultiRepoRunReport(repoResults);

    expect(report.totalSucceeded).toBe(5);
    expect(report.totalFailed).toBe(1);
    expect(report.totalCost).toBeCloseTo(4.0);
    expect(report.totalTurns).toBe(70);
    expect(report.totalDuration).toBe(35000);
    expect(report.repos).toHaveLength(2);
  });

  it('includes per-repo breakdown', () => {
    const repoResults = [
      { repoName: 'alpha', loopResult: makeLoopResult({ succeeded: 1, failed: 2, totalCost: 3.0 }) },
      { repoName: 'beta', loopResult: makeLoopResult({ succeeded: 5, failed: 0, totalCost: 7.0 }) },
    ];

    const report = buildMultiRepoRunReport(repoResults);

    expect(report.repos[0]?.name).toBe('alpha');
    expect(report.repos[0]?.succeeded).toBe(1);
    expect(report.repos[0]?.failed).toBe(2);
    expect(report.repos[0]?.cost).toBeCloseTo(3.0);

    expect(report.repos[1]?.name).toBe('beta');
    expect(report.repos[1]?.succeeded).toBe(5);
    expect(report.repos[1]?.cost).toBeCloseTo(7.0);
  });

  it('handles empty repo results', () => {
    const report = buildMultiRepoRunReport([]);

    expect(report.totalSucceeded).toBe(0);
    expect(report.totalFailed).toBe(0);
    expect(report.totalCost).toBe(0);
    expect(report.repos).toHaveLength(0);
  });

  it('marks budgetExceeded when any repo exceeded', () => {
    const repoResults = [
      { repoName: 'repo-a', loopResult: { ...makeLoopResult(), budgetExceeded: true } },
      { repoName: 'repo-b', loopResult: makeLoopResult() },
    ];

    const report = buildMultiRepoRunReport(repoResults);
    expect(report.budgetExceeded).toBe(true);
  });
});

describe('printMultiRepoRunReport', () => {
  it('does not throw', () => {
    const repoResults = [
      { repoName: 'repo-a', loopResult: makeLoopResult({ succeeded: 2, failed: 1, totalCost: 1.5 }) },
      { repoName: 'repo-b', loopResult: makeLoopResult({ succeeded: 3, failed: 0, totalCost: 2.5 }) },
    ];

    const report = buildMultiRepoRunReport(repoResults);
    expect(() => printMultiRepoRunReport(report)).not.toThrow();
  });
});
