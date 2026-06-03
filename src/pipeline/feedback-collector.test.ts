import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodicMemoryConfig } from '../types/config.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetchPRReviewComments = vi.fn();
const mockClassifyFeedback = vi.fn();
const mockRecordReviewFeedback = vi.fn();

vi.mock('../vcs/github.js', () => ({
  fetchPRReviewComments: mockFetchPRReviewComments,
}));

vi.mock('../memory/review-feedback-rest.js', () => ({
  classifyFeedback: mockClassifyFeedback,
  recordReviewFeedback: mockRecordReviewFeedback,
}));

/* ------------------------------------------------------------------ */
/*  Import SUT after mocks are installed                               */
/* ------------------------------------------------------------------ */

const { collectPRFeedback } = await import('./feedback-collector.js');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const ENDPOINT = 'http://localhost:8100/query';

function makeEpisodeConfig(overrides?: Partial<EpisodicMemoryConfig>): EpisodicMemoryConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    max_episodes: 3,
    cross_repo: true,
    same_repo_weight: 1.5,
    language_filter: true,
    ...overrides,
  };
}

interface CollectOptions {
  repoPath: string;
  repoName: string;
  prNumber: number;
  episodesConfig: EpisodicMemoryConfig;
}

function makeOptions(overrides?: Partial<CollectOptions>): CollectOptions {
  return {
    repoPath: '/tmp/test-repo',
    repoName: 'test-repo',
    prNumber: 42,
    episodesConfig: makeEpisodeConfig(),
    ...overrides,
  };
}

function makeHumanComment(author: string, body: string, path?: string) {
  return {
    author,
    body,
    path: path ?? 'src/auth.ts',
    line: 10,
    createdAt: '2026-04-05T10:00:00Z',
  };
}

function makeBotComment(author: string, body: string) {
  return {
    author,
    body,
    path: undefined,
    line: undefined,
    createdAt: '2026-04-05T10:01:00Z',
  };
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                   */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  collectPRFeedback                                                  */
/* ------------------------------------------------------------------ */

describe('collectPRFeedback', () => {
  it('returns feedbackCount and patternsDetected when comments exist', async () => {
    const comments = [
      makeHumanComment('alice', 'This has a security vulnerability', 'src/auth.ts'),
      makeHumanComment('bob', 'Add a test for edge case', 'src/parser.ts'),
    ];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('security_concern');
    mockClassifyFeedback.mockReturnValueOnce('missing_test');
    mockRecordReviewFeedback.mockResolvedValueOnce(true);

    const result = await collectPRFeedback(makeOptions());

    expect(result.feedbackCount).toBe(2);
    expect(result.patternsDetected).toContain('security_concern');
    expect(result.patternsDetected).toContain('missing_test');
  });

  it('returns { feedbackCount: 0, patternsDetected: [] } when no comments', async () => {
    mockFetchPRReviewComments.mockResolvedValueOnce([]);

    const result = await collectPRFeedback(makeOptions());

    expect(result).toEqual({ feedbackCount: 0, patternsDetected: [] });
    expect(mockClassifyFeedback).not.toHaveBeenCalled();
    expect(mockRecordReviewFeedback).not.toHaveBeenCalled();
  });

  it('calls classifyFeedback for each comment', async () => {
    const comments = [
      makeHumanComment('alice', 'This is a bug'),
      makeHumanComment('bob', 'Add more tests'),
      makeHumanComment('charlie', 'Style issue here'),
    ];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('logic_error');
    mockClassifyFeedback.mockReturnValueOnce('missing_test');
    mockClassifyFeedback.mockReturnValueOnce('style_issue');
    mockRecordReviewFeedback.mockResolvedValueOnce(true);

    await collectPRFeedback(makeOptions());

    expect(mockClassifyFeedback).toHaveBeenCalledTimes(3);
    expect(mockClassifyFeedback).toHaveBeenCalledWith('This is a bug');
    expect(mockClassifyFeedback).toHaveBeenCalledWith('Add more tests');
    expect(mockClassifyFeedback).toHaveBeenCalledWith('Style issue here');
  });

  it('calls recordReviewFeedback with classified feedback records', async () => {
    const comments = [makeHumanComment('alice', 'Security vulnerability in auth', 'src/auth.ts')];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('security_concern');
    mockRecordReviewFeedback.mockResolvedValueOnce(true);

    const options = makeOptions();
    await collectPRFeedback(options);

    expect(mockRecordReviewFeedback).toHaveBeenCalledOnce();
    const [config, records] = mockRecordReviewFeedback.mock.calls[0] as [EpisodicMemoryConfig, unknown[]];
    expect(config).toEqual(options.episodesConfig);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        repo: 'test-repo',
        pr_number: 42,
        feedback_type: 'security_concern',
        comment_text: 'Security vulnerability in auth',
        file_path: 'src/auth.ts',
        author: 'alice',
      }),
    );
  });

  it('returns { feedbackCount: 0, patternsDetected: [] } on error (graceful degradation)', async () => {
    mockFetchPRReviewComments.mockRejectedValueOnce(new Error('GitHub API failure'));

    const result = await collectPRFeedback(makeOptions());

    expect(result).toEqual({ feedbackCount: 0, patternsDetected: [] });
  });

  it('returns { feedbackCount: 0, patternsDetected: [] } when classifyFeedback throws', async () => {
    const comments = [makeHumanComment('alice', 'Something weird')];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockImplementationOnce(() => {
      throw new Error('Classification failed');
    });

    const result = await collectPRFeedback(makeOptions());

    expect(result).toEqual({ feedbackCount: 0, patternsDetected: [] });
  });

  it('returns { feedbackCount: 0, patternsDetected: [] } when recordReviewFeedback throws', async () => {
    const comments = [makeHumanComment('alice', 'Fix the bug')];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('logic_error');
    mockRecordReviewFeedback.mockRejectedValueOnce(new Error('DB write failed'));

    const result = await collectPRFeedback(makeOptions());

    expect(result).toEqual({ feedbackCount: 0, patternsDetected: [] });
  });

  it('filters out bot comments before classifying (only human comments)', async () => {
    const comments = [
      makeHumanComment('alice', 'Needs error handling'),
      makeBotComment('kova', 'Auto-generated comment: pipeline started.'),
      makeBotComment('github-actions', 'Coverage report: 85%'),
      makeHumanComment('bob', 'The naming is bad here'),
    ];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('logic_error');
    mockClassifyFeedback.mockReturnValueOnce('naming');
    mockRecordReviewFeedback.mockResolvedValueOnce(true);

    const result = await collectPRFeedback(makeOptions());

    // Only 2 human comments should be classified, not 4
    expect(mockClassifyFeedback).toHaveBeenCalledTimes(2);
    expect(mockClassifyFeedback).toHaveBeenCalledWith('Needs error handling');
    expect(mockClassifyFeedback).toHaveBeenCalledWith('The naming is bad here');
    expect(result.feedbackCount).toBe(2);
  });

  it('deduplicates patterns in patternsDetected', async () => {
    const comments = [makeHumanComment('alice', 'This is a bug'), makeHumanComment('bob', 'Another bug here')];
    mockFetchPRReviewComments.mockResolvedValueOnce(comments);
    mockClassifyFeedback.mockReturnValueOnce('logic_error');
    mockClassifyFeedback.mockReturnValueOnce('logic_error');
    mockRecordReviewFeedback.mockResolvedValueOnce(true);

    const result = await collectPRFeedback(makeOptions());

    expect(result.feedbackCount).toBe(2);
    // Patterns should be deduplicated
    expect(result.patternsDetected).toEqual(['logic_error']);
  });

  it('passes repoPath and prNumber to fetchPRReviewComments', async () => {
    mockFetchPRReviewComments.mockResolvedValueOnce([]);

    await collectPRFeedback(makeOptions({ repoPath: '/custom/path', prNumber: 99 }));

    expect(mockFetchPRReviewComments).toHaveBeenCalledWith('/custom/path', 99);
  });
});
