import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KovaConfig, RepoConfig } from '../types/index.js';

const mockFixLoop = vi.fn();
const mockFetchIssues = vi.fn();
const mockCollectChangedFilesFromPRs = vi.fn();
const mockReindexFiles = vi.fn();

beforeEach(() => {
  mockFixLoop.mockReset();
  mockFetchIssues.mockReset();
  mockCollectChangedFilesFromPRs.mockReset();
  mockReindexFiles.mockReset();
});

vi.mock('../services/github.js', () => ({
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
}));

vi.mock('./loop.js', () => ({
  fixLoop: (...args: unknown[]) => mockFixLoop(...args),
}));

vi.mock('../services/reindex.js', () => ({
  collectChangedFilesFromPRs: (...args: unknown[]) => mockCollectChangedFilesFromPRs(...args),
  reindexFiles: (...args: unknown[]) => mockReindexFiles(...args),
}));

const { runAuto, runAutoMultiRepo } = await import('./auto.js');

function makeAutoConfig(overrides?: Partial<RepoConfig['auto']>): RepoConfig['auto'] {
  return {
    source: 'open_issues' as const,
    max_per_run: 10,
    ...overrides,
  };
}

function makeRepoConfig(
  overrides?: Partial<Omit<RepoConfig, 'auto'>> & { auto?: Partial<RepoConfig['auto']> },
): RepoConfig {
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
    ...overrides,
    auto: makeAutoConfig(overrides?.auto),
  };
}

function makeLoopResult(overrides?: { failed?: number; succeeded?: number }) {
  return {
    total: 2,
    succeeded: overrides?.succeeded ?? 2,
    failed: overrides?.failed ?? 0,
    skipped: 0,
    totalCost: 1.0,
    totalTurns: 50,
    totalDuration: 30000,
    budgetExceeded: false,
    startedAt: '2026-01-01T00:00:00Z',
    results: [],
  };
}

function makeLoopResultWithPRs(fixes: Array<{ success: boolean; prUrl?: string }>) {
  const succeeded = fixes.filter((f) => f.success).length;
  const failed = fixes.filter((f) => !f.success).length;
  return {
    total: fixes.length,
    succeeded,
    failed,
    skipped: 0,
    totalCost: 1.0,
    totalTurns: 50,
    totalDuration: 30000,
    budgetExceeded: false,
    startedAt: '2026-01-01T00:00:00Z',
    results: fixes.map((f, i) => ({
      issue: { number: i + 1, title: `Issue ${i + 1}`, body: '', labels: [], url: '' },
      result: {
        success: f.success,
        prUrl: f.prUrl,
        state: {
          issue: { number: i + 1, title: `Issue ${i + 1}`, body: '', labels: [], url: '' },
          repo: 'test-repo',
          repoPath: '/tmp/test',
          startedAt: '2026-01-01T00:00:00Z',
          completedWaves: [],
          waveResults: {},
          status: f.success ? 'completed' : 'failed',
        },
      },
    })),
  };
}

describe('runAuto', () => {
  it('calls fixLoop with config defaults when no CLI overrides', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeRepoConfig({ auto: { filter: 'auto-fix', max_per_run: 5 } });

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config,
      filter: 'auto-fix',
      maxIssues: 5,
    });
    expect(result.exitCode).toBe(0);
  });

  it('CLI --filter overrides config auto.filter', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeRepoConfig({ auto: { filter: 'auto-fix' } });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config, filter: 'bug' });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: 'bug' }));
  });

  it('CLI --max overrides config auto.max_per_run', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeRepoConfig({ auto: { max_per_run: 20 } });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config, max: 3 });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ maxIssues: 3 }));
  });

  it('returns exitCode 0 when all succeed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 3, failed: 0 }));
    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeRepoConfig() });
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 1 when any failed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 1, failed: 1 }));
    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeRepoConfig() });
    expect(result.exitCode).toBe(1);
  });

  it('uses labeled source filter from config', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeRepoConfig({ auto: { source: 'labeled', filter: 'kova' } });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: 'kova' }));
  });

  it('works when config has no auto section', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config: RepoConfig = {
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
    };

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: undefined, maxIssues: 10 }));
    expect(result.exitCode).toBe(0);
  });

  it('returns loopResult for downstream consumption', async () => {
    const loopResult = makeLoopResult({ succeeded: 2, failed: 1 });
    mockFixLoop.mockResolvedValue(loopResult);

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeRepoConfig() });

    expect(result.loopResult).toEqual(loopResult);
  });

  it('triggers reindex when vectordb is enabled and fixes succeed', async () => {
    const loopResult = makeLoopResultWithPRs([
      { success: true, prUrl: 'https://github.com/o/r/pull/1' },
      { success: false },
      { success: true, prUrl: 'https://github.com/o/r/pull/3' },
    ]);
    mockFixLoop.mockResolvedValue(loopResult);
    mockCollectChangedFilesFromPRs.mockResolvedValue(['src/a.ts', 'src/b.ts']);
    mockReindexFiles.mockResolvedValue({ success: true, filesSubmitted: 2, apiCalls: 2, duration: 100 });

    const config = makeRepoConfig({
      vectordb: {
        enabled: true,
        endpoint: 'http://localhost:8100/query',
        reindex_endpoint: 'http://localhost:8100/reindex',
        top_k: 10,
      },
    });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockCollectChangedFilesFromPRs).toHaveBeenCalledWith('/tmp/test', [
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/3',
    ]);
    expect(mockReindexFiles).toHaveBeenCalledWith(config.vectordb, '/tmp/test', ['src/a.ts', 'src/b.ts']);
  });

  it('skips reindex when vectordb is not enabled', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 1 }));

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeRepoConfig() });

    expect(mockCollectChangedFilesFromPRs).not.toHaveBeenCalled();
    expect(mockReindexFiles).not.toHaveBeenCalled();
  });

  it('skips reindex when no fixes succeeded', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 0, failed: 2 }));

    const config = makeRepoConfig({
      vectordb: {
        enabled: true,
        endpoint: 'http://localhost:8100/query',
        reindex_endpoint: 'http://localhost:8100/reindex',
        top_k: 10,
      },
    });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockCollectChangedFilesFromPRs).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  runAutoMultiRepo                                                   */
/* ------------------------------------------------------------------ */

describe('runAutoMultiRepo', () => {
  function makeKovaConfig(
    repos: Record<string, Partial<Omit<RepoConfig, 'auto'>> & { auto?: Partial<RepoConfig['auto']> }>,
  ): KovaConfig {
    const result: KovaConfig = { repos: {} };
    for (const [name, overrides] of Object.entries(repos)) {
      result.repos[name] = makeRepoConfig({ path: `/tmp/${name}`, ...overrides });
    }
    return result;
  }

  it('iterates repos in config order', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
      'repo-c': { path: '/tmp/repo-c' },
    });

    await runAutoMultiRepo({ config });

    expect(mockFixLoop).toHaveBeenCalledTimes(3);
    expect(mockFixLoop).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ repoPath: '/tmp/repo-a', repoName: 'repo-a' }),
    );
    expect(mockFixLoop).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ repoPath: '/tmp/repo-b', repoName: 'repo-b' }),
    );
    expect(mockFixLoop).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ repoPath: '/tmp/repo-c', repoName: 'repo-c' }),
    );
  });

  it('passes per-repo config to each fixLoop call', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a', auto: { source: 'labeled', filter: 'kova', max_per_run: 5 } },
      'repo-b': { path: '/tmp/repo-b', auto: { source: 'open_issues', max_per_run: 20 } },
    });

    await runAutoMultiRepo({ config });

    expect(mockFixLoop).toHaveBeenNthCalledWith(1, expect.objectContaining({ filter: 'kova', maxIssues: 5 }));
    expect(mockFixLoop).toHaveBeenNthCalledWith(2, expect.objectContaining({ filter: undefined, maxIssues: 20 }));
  });

  it('CLI --filter overrides per-repo filter for all repos', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a', auto: { filter: 'per-repo-filter' } },
      'repo-b': { path: '/tmp/repo-b' },
    });

    await runAutoMultiRepo({ config, filter: 'override-filter' });

    expect(mockFixLoop).toHaveBeenNthCalledWith(1, expect.objectContaining({ filter: 'override-filter' }));
    expect(mockFixLoop).toHaveBeenNthCalledWith(2, expect.objectContaining({ filter: 'override-filter' }));
  });

  it('aggregates results across repos', async () => {
    mockFixLoop
      .mockResolvedValueOnce(makeLoopResult({ succeeded: 2, failed: 0 }))
      .mockResolvedValueOnce(makeLoopResult({ succeeded: 1, failed: 1 }));

    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepo({ config });

    expect(result.exitCode).toBe(1); // any failure → exit 1
    expect(result.repoResults).toHaveLength(2);
    expect(result.repoResults[0]?.repoName).toBe('repo-a');
    expect(result.repoResults[0]?.loopResult.succeeded).toBe(2);
    expect(result.repoResults[1]?.repoName).toBe('repo-b');
    expect(result.repoResults[1]?.loopResult.failed).toBe(1);
  });

  it('returns exitCode 0 when all repos succeed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 2, failed: 0 }));
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    const result = await runAutoMultiRepo({ config });
    expect(result.exitCode).toBe(0);
  });

  it('passes force option through to all repos', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeKovaConfig({
      'repo-a': { path: '/tmp/repo-a' },
      'repo-b': { path: '/tmp/repo-b' },
    });

    await runAutoMultiRepo({ config, force: true });

    expect(mockFixLoop).toHaveBeenNthCalledWith(1, expect.objectContaining({ force: true }));
    expect(mockFixLoop).toHaveBeenNthCalledWith(2, expect.objectContaining({ force: true }));
  });
});
