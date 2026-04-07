import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KovaConfig, RepoConfig } from '../types/index.js';

const mockFixLoop = vi.fn();
const mockCollectChangedFilesFromPRs = vi.fn();
const mockReindexFiles = vi.fn();

beforeEach(() => {
  mockFixLoop.mockReset();
  mockCollectChangedFilesFromPRs.mockReset();
  mockReindexFiles.mockReset();
});

vi.mock('../services/github.js', () => ({
  fetchIssues: vi.fn(),
}));

vi.mock('./loop.js', () => ({
  fixLoop: (...args: unknown[]) => mockFixLoop(...args),
}));

vi.mock('../services/reindex.js', () => ({
  collectChangedFilesFromPRs: (...args: unknown[]) => mockCollectChangedFilesFromPRs(...args),
  reindexFiles: (...args: unknown[]) => mockReindexFiles(...args),
}));

const { runAutoMultiRepoParallel } = await import('./auto.js');

function makeRepoConfig(
  overrides?: Partial<Omit<RepoConfig, 'auto'>> & { auto?: Partial<RepoConfig['auto']> },
): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const, concurrency: 1 },
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
    ...overrides,
    auto: {
      source: 'open_issues' as const,
      max_per_run: 10,
      ...overrides?.auto,
    },
  };
}

function makeKovaConfig(
  repos: Record<string, Partial<Omit<RepoConfig, 'auto'>> & { auto?: Partial<RepoConfig['auto']> }>,
): KovaConfig {
  const result: KovaConfig = { repos: {} };
  for (const [name, overrides] of Object.entries(repos)) {
    result.repos[name] = makeRepoConfig({ path: `/tmp/${name}`, ...overrides });
  }
  return result;
}

function makeLoopResult(overrides?: { failed?: number; succeeded?: number; totalCost?: number }) {
  return {
    total: 2,
    succeeded: overrides?.succeeded ?? 2,
    failed: overrides?.failed ?? 0,
    skipped: 0,
    totalCost: overrides?.totalCost ?? 1.0,
    totalTurns: 50,
    totalDuration: 30000,
    budgetExceeded: false,
    startedAt: '2026-01-01T00:00:00Z',
    results: [],
  };
}

describe('runAutoMultiRepoParallel', () => {
  it('runs all repos concurrently', async () => {
    // Use a tracking array to prove concurrent execution
    const executionOrder: string[] = [];

    mockFixLoop.mockImplementation(async (opts: { repoName: string }) => {
      executionOrder.push(`start:${opts.repoName}`);
      // Simulate async work — all should start before any finishes
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push(`end:${opts.repoName}`);
      return makeLoopResult();
    });

    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
      'repo-c': { path: '/tmp/repo-c' },
    });

    await runAutoMultiRepoParallel({ config });

    // All starts should come before all ends (concurrent)
    expect(executionOrder.filter((e) => e.startsWith('start:'))).toHaveLength(3);
    expect(executionOrder.filter((e) => e.startsWith('end:'))).toHaveLength(3);

    // The first 3 entries should all be starts (proves concurrent launch)
    const starts = executionOrder.slice(0, 3);
    expect(starts.every((e) => e.startsWith('start:'))).toBe(true);
  });

  it('each repo gets its own sequential fix queue', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    await runAutoMultiRepoParallel({ config });

    expect(mockFixLoop).toHaveBeenCalledTimes(2);
    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/tmp/repo-a', repoName: 'repo-a' }));
    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/tmp/repo-b', repoName: 'repo-b' }));
  });

  it('shares a budget tracker across all repos', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ totalCost: 5.0 }));
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepoParallel({
      config,
      budgetUsd: 10,
    });

    // Both repos ran — fixLoop receives the shared budget tracker
    expect(mockFixLoop).toHaveBeenCalledTimes(2);
    for (const call of mockFixLoop.mock.calls) {
      expect(call[0]).toHaveProperty('budgetTracker');
    }

    // Aggregated cost should reflect both repos
    const totalCost = result.repoResults.reduce((sum, r) => sum + r.loopResult.totalCost, 0);
    expect(totalCost).toBe(10.0);
  });

  it('aggregates results across repos', async () => {
    mockFixLoop
      .mockResolvedValueOnce(makeLoopResult({ succeeded: 3, failed: 0, totalCost: 2.0 }))
      .mockResolvedValueOnce(makeLoopResult({ succeeded: 1, failed: 1, totalCost: 3.0 }));

    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepoParallel({ config });

    expect(result.repoResults).toHaveLength(2);
    expect(result.exitCode).toBe(1); // any failure → exit 1
    expect(result.aggregated.totalCost).toBe(5.0);
    expect(result.aggregated.succeeded).toBe(4);
    expect(result.aggregated.failed).toBe(1);
  });

  it('returns exitCode 0 when all repos succeed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 2, failed: 0 }));
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepoParallel({ config });
    expect(result.exitCode).toBe(0);
  });

  it('passes filter and force through to all repos', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    await runAutoMultiRepoParallel({ config, filter: 'bug', force: true });

    for (const call of mockFixLoop.mock.calls) {
      expect(call[0]).toMatchObject({ filter: 'bug', force: true });
    }
  });

  it('passes max through to all repos', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    await runAutoMultiRepoParallel({ config, max: 5 });

    for (const call of mockFixLoop.mock.calls) {
      expect(call[0]).toMatchObject({ maxIssues: 5 });
    }
  });

  it('handles single repo gracefully', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'only-repo': { path: '/tmp/only-repo' },
    });

    const result = await runAutoMultiRepoParallel({ config });

    expect(mockFixLoop).toHaveBeenCalledTimes(1);
    expect(result.repoResults).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });

  it('continues other repos when one fails', async () => {
    mockFixLoop
      .mockRejectedValueOnce(new Error('repo-a exploded'))
      .mockResolvedValueOnce(makeLoopResult({ succeeded: 2, failed: 0 }));

    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepoParallel({ config });

    expect(result.exitCode).toBe(1);
    expect(result.repoResults).toHaveLength(2);
    // repo-a should have an error result
    const repoA = result.repoResults.find((r) => r.repoName === 'repo-a');
    expect(repoA?.error).toBeDefined();
    // repo-b should succeed
    const repoB = result.repoResults.find((r) => r.repoName === 'repo-b');
    expect(repoB?.loopResult.succeeded).toBe(2);
  });
});
