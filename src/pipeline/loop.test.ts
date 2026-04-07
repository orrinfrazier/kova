import { describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/github.js', () => ({
  fetchIssues: vi.fn().mockResolvedValue([
    { number: 1, title: 'Issue 1', body: 'body 1', labels: [], url: 'https://example.com/1' },
    { number: 2, title: 'Issue 2', body: 'body 2', labels: [], url: 'https://example.com/2' },
  ]),
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

const { fixLoop } = await import('./loop.js');

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
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
  };
}

describe('fixLoop — cumulative cost tracking', () => {
  it('returns totalCost across all issues', async () => {
    const result = await fixLoop({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.totalCost).toBeCloseTo(1.16, 2);
  });
  it('returns totalTurns across all issues', async () => {
    const result = await fixLoop({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.totalTurns).toBe(86);
  });
  it('returns totalDuration across all issues', async () => {
    const result = await fixLoop({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.totalDuration).toBe(48000);
  });
  it('returns startedAt timestamp', async () => {
    const result = await fixLoop({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.startedAt).toBeDefined();
    expect(new Date(result.startedAt).getTime()).toBeGreaterThan(0);
  });
  it('prints cumulative cost summary', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    await fixLoop({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('$1.16');
    expect(output).toContain('86');
    consoleSpy.mockRestore();
  });
});

describe('fixLoop — budget cap', () => {
  it('stops after current issue when cumulative cost exceeds budgetUsd', async () => {
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      budgetUsd: 0.5,
    });
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it('processes all issues when budget is sufficient', async () => {
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      budgetUsd: 5.0,
    });
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.budgetExceeded).toBe(false);
  });

  it('processes all issues when budgetUsd is undefined (unlimited)', async () => {
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
    });
    expect(result.total).toBe(2);
    expect(result.budgetExceeded).toBe(false);
  });

  it('reads budget from config rules.budget_usd when no CLI override', async () => {
    const config = makeConfig();
    config.rules.budget_usd = 0.5;
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config,
    });
    expect(result.total).toBe(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it('CLI budgetUsd overrides config rules.budget_usd', async () => {
    const config = makeConfig();
    config.rules.budget_usd = 0.5;
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config,
      budgetUsd: 5.0,
    });
    expect(result.total).toBe(2);
    expect(result.budgetExceeded).toBe(false);
  });

  it('logs budget exceeded message when stopped', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
      budgetUsd: 0.5,
    });
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toMatch(/budget/i);
    consoleSpy.mockRestore();
  });
});
