/**
 * Tests for the babysit pipeline (issue #258).
 *
 * runBabysit iterates open kova PRs, calls resolvePRReviewThreads per PR,
 * and aggregates results. PR filtering by --pr works.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig } from '../types/config.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetchKovaPRsWithStatus = vi.fn();
const mockResolvePRReviewThreads = vi.fn();

vi.mock('../vcs/github.js', () => ({
  fetchKovaPRsWithStatus: mockFetchKovaPRsWithStatus,
}));

vi.mock('./review-resolver.js', () => ({
  resolvePRReviewThreads: mockResolvePRReviewThreads,
  DEFAULT_NON_ACTIONABLE_TYPES: ['architectural_concern', 'design_preference', 'discussion'],
}));

/* ------------------------------------------------------------------ */
/*  Import SUT after mocks are installed                               */
/* ------------------------------------------------------------------ */

const { runBabysit } = await import('./babysit.js');

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
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
  runtime: 'pi' as const,
} satisfies RepoConfig;

function makePR(n: number) {
  return {
    number: n,
    title: `PR ${n}`,
    branch: `kova/fix-${n}`,
    url: `https://github.com/org/repo/pull/${n}`,
    ciStatus: 'success' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePRReviewThreads.mockResolvedValue({
    threadsResolved: [],
    nonActionable: [],
    errors: [],
  });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('runBabysit', () => {
  it('iterates every kova PR and aggregates per-PR results', async () => {
    mockFetchKovaPRsWithStatus.mockResolvedValueOnce([makePR(1), makePR(2)]);
    mockResolvePRReviewThreads
      .mockResolvedValueOnce({
        threadsResolved: [{ threadId: 'a', rootCommentId: 1, sha: 's1', path: 'x', line: 1 }],
        nonActionable: [],
        errors: [],
      })
      .mockResolvedValueOnce({
        threadsResolved: [],
        nonActionable: [
          { threadId: 'b', rootCommentId: 2, reason: 'architectural_concern', body: '', path: undefined },
        ],
        errors: [],
      });

    const result = await runBabysit({
      repoPath: '/repo',
      repoName: 'org/repo',
      config: baseConfig,
      dispatchEdits: vi.fn(),
    });

    expect(mockResolvePRReviewThreads).toHaveBeenCalledTimes(2);
    expect(result.prsProcessed).toBe(2);
    expect(result.totalResolved).toBe(1);
    expect(result.totalNonActionable).toBe(1);
    expect(result.totalErrors).toBe(0);
    expect(result.perPR).toHaveLength(2);
  });

  it('filters to a single PR when prNumber is supplied', async () => {
    mockFetchKovaPRsWithStatus.mockResolvedValueOnce([makePR(1), makePR(2), makePR(3)]);
    mockResolvePRReviewThreads.mockResolvedValue({
      threadsResolved: [],
      nonActionable: [],
      errors: [],
    });

    const result = await runBabysit({
      repoPath: '/repo',
      repoName: 'org/repo',
      config: baseConfig,
      dispatchEdits: vi.fn(),
      prNumber: 2,
    });

    expect(mockResolvePRReviewThreads).toHaveBeenCalledTimes(1);
    expect(mockResolvePRReviewThreads).toHaveBeenCalledWith(
      expect.objectContaining({ pr: expect.objectContaining({ number: 2 }) }),
    );
    expect(result.prsProcessed).toBe(1);
  });

  it('reports zero PRs processed when no kova PRs are open', async () => {
    mockFetchKovaPRsWithStatus.mockResolvedValueOnce([]);

    const result = await runBabysit({
      repoPath: '/repo',
      repoName: 'org/repo',
      config: baseConfig,
      dispatchEdits: vi.fn(),
    });

    expect(mockResolvePRReviewThreads).not.toHaveBeenCalled();
    expect(result.prsProcessed).toBe(0);
  });

  it('reports failure when --pr targets a number not in kova PR list', async () => {
    mockFetchKovaPRsWithStatus.mockResolvedValueOnce([makePR(1)]);

    const result = await runBabysit({
      repoPath: '/repo',
      repoName: 'org/repo',
      config: baseConfig,
      dispatchEdits: vi.fn(),
      prNumber: 99,
    });

    expect(mockResolvePRReviewThreads).not.toHaveBeenCalled();
    expect(result.prsProcessed).toBe(0);
    expect(result.errors).toContainEqual(expect.objectContaining({ prNumber: 99 }));
  });

  it('continues processing remaining PRs when one resolver call throws', async () => {
    mockFetchKovaPRsWithStatus.mockResolvedValueOnce([makePR(1), makePR(2)]);
    mockResolvePRReviewThreads
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ threadsResolved: [], nonActionable: [], errors: [] });

    const result = await runBabysit({
      repoPath: '/repo',
      repoName: 'org/repo',
      config: baseConfig,
      dispatchEdits: vi.fn(),
    });

    expect(mockResolvePRReviewThreads).toHaveBeenCalledTimes(2);
    expect(result.prsProcessed).toBe(2);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});
