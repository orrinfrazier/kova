/**
 * Tests for review-resolver service (issue #258).
 *
 * Verifies the "act on PR review comments" flow:
 *   fetch threads → classify → dispatch edits → push → reply with sha
 *
 * Non-actionable threads must be surfaced, not silently resolved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRReviewThread } from './github.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetchPRReviewState = vi.fn();
const mockReplyToReviewComment = vi.fn();
const mockCollectPRFeedback = vi.fn();
const mockClassifyFeedback = vi.fn();

vi.mock('./github.js', () => ({
  fetchPRReviewState: mockFetchPRReviewState,
  replyToReviewComment: mockReplyToReviewComment,
}));

vi.mock('./feedback-collector.js', () => ({
  collectPRFeedback: mockCollectPRFeedback,
}));

vi.mock('./memory/review-feedback-rest.js', () => ({
  classifyFeedback: mockClassifyFeedback,
}));

/* ------------------------------------------------------------------ */
/*  Import SUT after mocks are installed                               */
/* ------------------------------------------------------------------ */

const { resolvePRReviewThreads } = await import('./review-resolver.js');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeThread(overrides?: Partial<PRReviewThread>): PRReviewThread {
  return {
    threadId: 'T_abc',
    rootCommentId: 100,
    path: 'src/auth.ts',
    line: 10,
    body: 'Add a null check here before dereferencing user.id',
    author: 'alice',
    ...overrides,
  };
}

function makePR() {
  return {
    number: 42,
    title: 'Fix something',
    branch: 'kova/fix-42',
    url: 'https://github.com/org/repo/pull/42',
    ciStatus: 'success' as const,
  };
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                   */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // Default behavior: classify everything as actionable
  mockClassifyFeedback.mockReturnValue('logic_error');
  mockCollectPRFeedback.mockResolvedValue({ feedbackCount: 0, patternsDetected: [] });
  mockReplyToReviewComment.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('resolvePRReviewThreads', () => {
  it('returns empty result when no blocking threads', async () => {
    mockFetchPRReviewState.mockResolvedValueOnce({ decision: 'APPROVED', blockingThreads: [] });

    const dispatchEdits = vi.fn();

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
    });

    expect(result.threadsResolved).toEqual([]);
    expect(result.nonActionable).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(dispatchEdits).not.toHaveBeenCalled();
    expect(mockReplyToReviewComment).not.toHaveBeenCalled();
  });

  it('dispatches an edit pass for each actionable thread', async () => {
    const t1 = makeThread({ threadId: 'T_1', rootCommentId: 101, body: 'Add null check' });
    const t2 = makeThread({ threadId: 'T_2', rootCommentId: 102, body: 'Rename foo to bar' });
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [t1, t2],
    });

    const dispatchEdits = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, sha: 'sha1' })
      .mockResolvedValueOnce({ changed: true, sha: 'sha2' });

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
    });

    expect(dispatchEdits).toHaveBeenCalledTimes(2);
    expect(dispatchEdits).toHaveBeenNthCalledWith(1, expect.objectContaining({ thread: t1, repoPath: '/repo' }));
    expect(dispatchEdits).toHaveBeenNthCalledWith(2, expect.objectContaining({ thread: t2, repoPath: '/repo' }));
    expect(result.threadsResolved).toHaveLength(2);
    expect(result.threadsResolved[0]).toEqual(expect.objectContaining({ threadId: 'T_1', sha: 'sha1' }));
    expect(result.threadsResolved[1]).toEqual(expect.objectContaining({ threadId: 'T_2', sha: 'sha2' }));
  });

  it('replies "Fixed in <sha>" to each resolved thread', async () => {
    const t1 = makeThread({ threadId: 'T_1', rootCommentId: 101 });
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [t1],
    });
    const dispatchEdits = vi.fn().mockResolvedValueOnce({ changed: true, sha: 'abc1234' });

    await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
    });

    expect(mockReplyToReviewComment).toHaveBeenCalledWith(
      '/repo',
      'org/repo',
      42,
      101,
      expect.stringMatching(/Fixed in abc1234/),
    );
  });

  it('surfaces non-actionable comments without replying or dispatching edits', async () => {
    const architectural = makeThread({
      threadId: 'T_arch',
      rootCommentId: 200,
      body: 'I think the whole architecture is wrong, we should redesign.',
    });
    const actionable = makeThread({
      threadId: 'T_act',
      rootCommentId: 201,
      body: 'Add a null check at line 10.',
    });
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [architectural, actionable],
    });
    // Classifier marks first as non-actionable, second as actionable
    mockClassifyFeedback.mockReturnValueOnce('architectural_concern').mockReturnValueOnce('logic_error');

    const dispatchEdits = vi.fn().mockResolvedValueOnce({ changed: true, sha: 'sha-act' });

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
      nonActionableTypes: ['architectural_concern'],
    });

    // Only the actionable thread should be dispatched
    expect(dispatchEdits).toHaveBeenCalledTimes(1);
    expect(dispatchEdits).toHaveBeenCalledWith(expect.objectContaining({ thread: actionable }));

    // No reply for non-actionable thread
    expect(mockReplyToReviewComment).toHaveBeenCalledTimes(1);
    expect(mockReplyToReviewComment).toHaveBeenCalledWith(
      '/repo',
      'org/repo',
      42,
      201,
      expect.stringMatching(/Fixed in sha-act/),
    );

    expect(result.nonActionable).toHaveLength(1);
    expect(result.nonActionable[0]).toEqual(
      expect.objectContaining({ threadId: 'T_arch', reason: 'architectural_concern' }),
    );
    expect(result.threadsResolved).toHaveLength(1);
  });

  it('still calls collectPRFeedback for episodic recording', async () => {
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [makeThread()],
    });
    const dispatchEdits = vi.fn().mockResolvedValueOnce({ changed: true, sha: 's' });

    await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
      episodesConfig: {
        enabled: true,
        endpoint: 'http://localhost:8100/query',
        max_episodes: 3,
        cross_repo: true,
        same_repo_weight: 1.5,
        language_filter: true,
      },
    });

    expect(mockCollectPRFeedback).toHaveBeenCalledTimes(1);
    expect(mockCollectPRFeedback).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/repo', prNumber: 42 }));
  });

  it('respects maxIterations — does not loop forever if threads remain', async () => {
    // Two threads on first fetch, same two on a hypothetical refetch (resolver never refetches)
    const threads = [makeThread({ threadId: 'T_a', rootCommentId: 1 })];
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: threads,
    });
    const dispatchEdits = vi.fn().mockResolvedValueOnce({ changed: false, sha: undefined });

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
      maxIterations: 2,
    });

    // dispatch was called at most twice (per maxIterations) when no changes resulted
    expect(dispatchEdits.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('records an error and does NOT reply when dispatchEdits throws', async () => {
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [makeThread({ threadId: 'T_x', rootCommentId: 7 })],
    });
    const dispatchEdits = vi.fn().mockRejectedValueOnce(new Error('boom'));

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
    });

    expect(result.threadsResolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({ threadId: 'T_x', message: expect.stringContaining('boom') }),
    );
    expect(mockReplyToReviewComment).not.toHaveBeenCalled();
  });

  it('does NOT reply when dispatchEdits reports no change (changed=false)', async () => {
    mockFetchPRReviewState.mockResolvedValueOnce({
      decision: 'CHANGES_REQUESTED',
      blockingThreads: [makeThread({ threadId: 'T_nochg', rootCommentId: 50 })],
    });
    const dispatchEdits = vi.fn().mockResolvedValueOnce({ changed: false, sha: undefined });

    const result = await resolvePRReviewThreads({
      repoPath: '/repo',
      repoName: 'org/repo',
      pr: makePR(),
      dispatchEdits,
    });

    expect(mockReplyToReviewComment).not.toHaveBeenCalled();
    expect(result.threadsResolved).toEqual([]);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});
