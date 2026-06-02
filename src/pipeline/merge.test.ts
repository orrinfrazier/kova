import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig } from '../types/config.js';

// Mock github service
vi.mock('../services/github.js', () => ({
  fetchKovaPRsWithStatus: vi.fn(),
  mergePR: vi.fn(),
  rebasePROnDefault: vi.fn(),
  fetchPRDependencies: vi.fn(),
  fetchPRReviewState: vi.fn(),
}));

// Mock conflict resolver
vi.mock('../services/conflict-resolver.js', () => ({
  resolveNonOverlappingConflicts: vi.fn(),
}));

// Mock worktree (detectDefaultBranch)
vi.mock('../services/worktree.js', () => ({
  detectDefaultBranch: vi.fn().mockResolvedValue('main'),
}));

// Import mocks and SUT after mock setup
const githubModule = (await import('../services/github.js')) as unknown as {
  fetchKovaPRsWithStatus: ReturnType<typeof vi.fn>;
  mergePR: ReturnType<typeof vi.fn>;
  rebasePROnDefault: ReturnType<typeof vi.fn>;
  fetchPRDependencies: ReturnType<typeof vi.fn>;
  fetchPRReviewState: ReturnType<typeof vi.fn>;
};
const { fetchKovaPRsWithStatus, mergePR, rebasePROnDefault, fetchPRDependencies, fetchPRReviewState } = githubModule;

const conflictModule = (await import('../services/conflict-resolver.js')) as unknown as {
  resolveNonOverlappingConflicts: ReturnType<typeof vi.fn>;
};
const { resolveNonOverlappingConflicts } = conflictModule;

const { runMerge } = await import('./merge.js');

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

const baseConfig = {
  path: '/repo',
  rules: {
    coverage: 80,
    auto_merge: false,
    max_issues_per_run: 10,
    ci_merge: 'require' as const,
    review_merge: 'require' as const,
    concurrency: 1,
  },
  model: {
    assess: 'large' as const,
    spec: 'large' as const,
    test: 'medium' as const,
    impl: 'medium' as const,
    quality: 'small' as const,
    review: 'large' as const,
    brainstorm: 'large' as const,
  },
  isolation: 'worktree' as const,
} satisfies RepoConfig;

function makePR(
  number: number,
  ciStatus: 'success' | 'failure' | 'pending' | 'none' = 'success',
  dependencies: number[] = [],
) {
  return {
    number,
    title: `Fix issue ${number}`,
    branch: `kova/fix-${number}`,
    url: `https://github.com/repo/pull/${number}`,
    ciStatus,
    dependencies,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mergePR.mockResolvedValue(undefined);
  rebasePROnDefault.mockResolvedValue(undefined);
  fetchPRDependencies.mockResolvedValue([]);
  fetchPRReviewState.mockResolvedValue({ decision: 'APPROVED', blockingThreads: [] });
  resolveNonOverlappingConflicts.mockResolvedValue({ resolved: true, autoResolvedFiles: [] });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('runMerge', () => {
  it('dry run mode returns merge order without calling mergePR', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2)]);
    fetchPRDependencies.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
      dryRun: true,
    });

    expect(mergePR).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.merged.length).toBe(0);
    expect(result.skipped.length + result.failed.length + result.merged.length).toBeGreaterThanOrEqual(0);
  });

  it('merges PRs in topological dependency order (dependency before dependent)', async () => {
    const pr2 = makePR(2, 'success', []);
    const pr3 = makePR(3, 'success', [2]);
    fetchKovaPRsWithStatus.mockResolvedValue([pr3, pr2]);
    fetchPRDependencies.mockImplementation((_repoPath: string, number: number) =>
      Promise.resolve(number === 3 ? [2] : []),
    );

    const mergeOrder: number[] = [];
    mergePR.mockImplementation((_repoPath: string, number: number) => {
      mergeOrder.push(number);
      return Promise.resolve();
    });

    await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    const idx2 = mergeOrder.indexOf(2);
    const idx3 = mergeOrder.indexOf(3);
    expect(idx2).not.toBe(-1);
    expect(idx3).not.toBe(-1);
    expect(idx2).toBeLessThan(idx3);
  });

  it('ci_merge require skips PR with ciStatus failure and includes it in result.failed', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1, 'failure')]);
    fetchPRDependencies.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: { ...baseConfig, rules: { ...baseConfig.rules, ci_merge: 'require' } },
    });

    expect(mergePR).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.number).toBe(1);
    expect(result.failed[0]?.reason).toMatch(/ci|CI|check|status/i);
  });

  it('ci_merge warn proceeds to merge when ciStatus is failure', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1, 'failure')]);
    fetchPRDependencies.mockResolvedValue([]);

    const warnConfig = {
      ...baseConfig,
      rules: { ...baseConfig.rules, ci_merge: 'warn' as const },
    };

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: warnConfig,
    });

    expect(mergePR).toHaveBeenCalledWith('/repo', 1);
    expect(result.merged).toContain(1);
  });

  it('calls rebasePROnDefault for each remaining unmerged PR after a merge', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2), makePR(3)]);
    fetchPRDependencies.mockResolvedValue([]);

    await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(rebasePROnDefault).toHaveBeenCalled();
  });

  it('single PR mode merges only the specified PR', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2), makePR(3)]);
    fetchPRDependencies.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
      prNumber: 2,
    });

    expect(mergePR).toHaveBeenCalledTimes(1);
    expect(mergePR).toHaveBeenCalledWith('/repo', 2);
    expect(result.merged).toEqual([2]);
  });

  it('returns empty results when no kova PRs found', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(mergePR).not.toHaveBeenCalled();
    expect(result.merged).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('falls back to ascending PR number order when topological sort encounters a cycle', async () => {
    const pr1 = makePR(1, 'success', [2]);
    const pr2 = makePR(2, 'success', [1]);
    fetchKovaPRsWithStatus.mockResolvedValue([pr1, pr2]);
    fetchPRDependencies.mockImplementation((_repoPath: string, number: number) =>
      Promise.resolve(number === 1 ? [2] : [1]),
    );

    const mergeOrder: number[] = [];
    mergePR.mockImplementation((_repoPath: string, number: number) => {
      mergeOrder.push(number);
      return Promise.resolve();
    });

    await expect(
      runMerge({
        repoPath: '/repo',
        repoName: 'my-repo',
        config: baseConfig,
      }),
    ).resolves.toBeDefined();

    expect(mergeOrder).toEqual([1, 2]);
  });

  it('ci_merge require blocks on pending status', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(5, 'pending')]);
    fetchPRDependencies.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: { ...baseConfig, rules: { ...baseConfig.rules, ci_merge: 'require' } },
    });

    expect(mergePR).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.number).toBe(5);
  });

  it('returns all PR numbers in merged array when all succeed', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(10), makePR(20), makePR(30)]);
    fetchPRDependencies.mockResolvedValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(result.merged).toHaveLength(3);
    expect(result.merged).toContain(10);
    expect(result.merged).toContain(20);
    expect(result.merged).toContain(30);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('captures merge failure in result.failed and continues with remaining PRs', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2), makePR(3)]);
    fetchPRDependencies.mockReturnValue([]);

    mergePR
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('PR has conflicts'))
      .mockResolvedValueOnce(undefined);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(result.merged).toContain(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.number).toBe(2);
    expect(result.failed[0]?.reason).toMatch(/conflict/i);
    expect(result.merged).toContain(3);
  });

  it('dry run populates result.skipped with the would-be merge order', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(3), makePR(1), makePR(2)]);
    fetchPRDependencies.mockReturnValue([]);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
      dryRun: true,
    });

    expect(result.skipped).toEqual([1, 2, 3]);
    expect(result.merged).toHaveLength(0);
    expect(result.dryRun).toBe(true);
  });

  it('falls back to resolveNonOverlappingConflicts when rebasePROnDefault fails', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2)]);
    fetchPRDependencies.mockResolvedValue([]);

    rebasePROnDefault.mockRejectedValue(new Error('merge conflict'));
    resolveNonOverlappingConflicts.mockResolvedValue({
      resolved: true,
      autoResolvedFiles: ['package-lock.json'],
    });

    await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(resolveNonOverlappingConflicts).toHaveBeenCalledWith('/repo', 'kova/fix-2', 'main');
  });

  it('does not call resolveNonOverlappingConflicts when rebasePROnDefault succeeds', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(1), makePR(2)]);
    fetchPRDependencies.mockResolvedValue([]);

    await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(resolveNonOverlappingConflicts).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  review_merge policy (issue #256)                                  */
  /* ---------------------------------------------------------------- */

  it('review_merge require blocks a PR with CHANGES_REQUESTED decision (no resolver)', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(42)]);
    fetchPRReviewState.mockResolvedValue({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [
        {
          threadId: 'T_1',
          rootCommentId: 100,
          path: 'src/foo.ts',
          line: 10,
          body: 'please rename',
          author: 'reviewer',
        },
      ],
    });

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(mergePR).not.toHaveBeenCalled();
    expect(result.merged).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.number).toBe(42);
    expect(result.failed[0]?.reason).toMatch(/review|CHANGES_REQUESTED|thread/i);
  });

  it('review_merge require runs the resolver and merges after re-check passes', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(43)]);
    // First call: blocking. Second call (post-resolver): clean.
    fetchPRReviewState
      .mockResolvedValueOnce({
        decision: 'CHANGES_REQUESTED',
        blockingThreads: [
          {
            threadId: 'T_2',
            rootCommentId: 200,
            path: 'src/bar.ts',
            line: 5,
            body: 'tighten error',
            author: 'reviewer',
          },
        ],
      })
      .mockResolvedValueOnce({ decision: 'APPROVED', blockingThreads: [] });

    const resolveReviews = vi.fn().mockResolvedValue(true);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
      resolveReviews,
    });

    expect(resolveReviews).toHaveBeenCalledTimes(1);
    expect(fetchPRReviewState).toHaveBeenCalledTimes(2);
    expect(mergePR).toHaveBeenCalledWith('/repo', 43);
    expect(result.merged).toContain(43);
    expect(result.failed).toHaveLength(0);
  });

  it('review_merge require fails when the resolver returns false', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(44)]);
    fetchPRReviewState.mockResolvedValue({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [
        {
          threadId: 'T_3',
          rootCommentId: 300,
          path: 'src/baz.ts',
          line: 1,
          body: 'rework',
          author: 'reviewer',
        },
      ],
    });

    const resolveReviews = vi.fn().mockResolvedValue(false);

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
      resolveReviews,
    });

    expect(resolveReviews).toHaveBeenCalledTimes(1);
    expect(mergePR).not.toHaveBeenCalled();
    expect(result.failed[0]?.number).toBe(44);
  });

  it('review_merge warn logs and proceeds to merge despite CHANGES_REQUESTED', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(45)]);
    fetchPRReviewState.mockResolvedValue({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [
        {
          threadId: 'T_4',
          rootCommentId: 400,
          path: 'src/qux.ts',
          line: 99,
          body: 'consider X',
          author: 'reviewer',
        },
      ],
    });

    const warnConfig = {
      ...baseConfig,
      rules: { ...baseConfig.rules, review_merge: 'warn' as const },
    };

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: warnConfig,
    });

    expect(mergePR).toHaveBeenCalledWith('/repo', 45);
    expect(result.merged).toContain(45);
  });

  it('review_merge require allows merge when only outdated/resolved threads exist (no blocking)', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(46)]);
    fetchPRReviewState.mockResolvedValue({ decision: 'APPROVED', blockingThreads: [] });

    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig,
    });

    expect(mergePR).toHaveBeenCalledWith('/repo', 46);
    expect(result.merged).toContain(46);
  });

  it('reviewOverride option supersedes config.rules.review_merge', async () => {
    fetchKovaPRsWithStatus.mockResolvedValue([makePR(47)]);
    fetchPRReviewState.mockResolvedValue({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [
        {
          threadId: 'T_5',
          rootCommentId: 500,
          path: 'src/zz.ts',
          line: 2,
          body: 'fix',
          author: 'reviewer',
        },
      ],
    });

    // Config says require, override says warn — warn should win and PR merges.
    const result = await runMerge({
      repoPath: '/repo',
      repoName: 'my-repo',
      config: baseConfig, // require
      reviewOverride: 'warn',
    });

    expect(mergePR).toHaveBeenCalledWith('/repo', 47);
    expect(result.merged).toContain(47);
  });
});
