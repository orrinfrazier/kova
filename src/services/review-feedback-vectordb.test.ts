import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodicMemoryConfig } from '../types/config.js';
import {
  classifyFeedback,
  formatReviewFeedback,
  insertReviewFeedback,
  type PoolLike,
  queryReviewFeedback,
  recordReviewFeedback,
  type VectorDBClient,
} from './vectordb.js';

/* ------------------------------------------------------------------ */
/*  Mock fetch                                                         */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMockPool(): PoolLike {
  return {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] }),
  };
}

function makeMockClient(poolOverride?: PoolLike): VectorDBClient {
  return {
    pool: poolOverride ?? makeMockPool(),
    embed: vi.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]),
  };
}

/* ------------------------------------------------------------------ */
/*  classifyFeedback                                                   */
/* ------------------------------------------------------------------ */

describe('classifyFeedback', () => {
  it('classifies "test" keyword as missing_test', () => {
    expect(classifyFeedback('You should add a test for this')).toBe('missing_test');
  });

  it('classifies "security" keyword as security_concern', () => {
    expect(classifyFeedback('This has a security vulnerability')).toBe('security_concern');
  });

  it('classifies "injection" keyword as security_concern', () => {
    expect(classifyFeedback('SQL injection risk here')).toBe('security_concern');
  });

  it('classifies "auth" keyword as security_concern', () => {
    expect(classifyFeedback('The auth check is missing')).toBe('security_concern');
  });

  it('classifies "style" keyword as style_issue', () => {
    expect(classifyFeedback('This is a style concern')).toBe('style_issue');
  });

  it('classifies "format" keyword as style_issue', () => {
    expect(classifyFeedback('The format is inconsistent')).toBe('style_issue');
  });

  it('classifies "logic" keyword as logic_error', () => {
    expect(classifyFeedback('There is a logic error in this branch')).toBe('logic_error');
  });

  it('classifies "bug" keyword as logic_error', () => {
    expect(classifyFeedback('This is a bug')).toBe('logic_error');
  });

  it('classifies "incorrect" keyword as logic_error', () => {
    expect(classifyFeedback('The result is incorrect')).toBe('logic_error');
  });

  it('classifies "wrong" keyword as logic_error', () => {
    expect(classifyFeedback('This value is wrong')).toBe('logic_error');
  });

  it('classifies "performance" keyword as performance', () => {
    expect(classifyFeedback('This has a performance issue')).toBe('performance');
  });

  it('classifies "slow" keyword as performance', () => {
    expect(classifyFeedback('This query is slow')).toBe('performance');
  });

  it('classifies "memory" keyword as performance', () => {
    expect(classifyFeedback('High memory usage detected')).toBe('performance');
  });

  it('classifies "naming" keyword as naming', () => {
    expect(classifyFeedback('The naming convention is wrong here')).toBe('naming');
  });

  it('classifies "rename" keyword as naming', () => {
    expect(classifyFeedback('You should rename this variable')).toBe('naming');
  });

  it('classifies "architecture" keyword as architecture', () => {
    expect(classifyFeedback('The architecture needs rethinking')).toBe('architecture');
  });

  it('classifies "structure" keyword as architecture', () => {
    expect(classifyFeedback('The structure is wrong')).toBe('architecture');
  });

  it('classifies "pattern" keyword as architecture', () => {
    expect(classifyFeedback('Use a different pattern here')).toBe('architecture');
  });

  it('classifies "doc" keyword as documentation', () => {
    expect(classifyFeedback('Add a doc comment here')).toBe('documentation');
  });

  it('classifies "comment" keyword as documentation', () => {
    expect(classifyFeedback('This needs a comment')).toBe('documentation');
  });

  it('classifies "readme" keyword as documentation', () => {
    expect(classifyFeedback('Update the readme')).toBe('documentation');
  });

  it('defaults to style_issue for unrecognized text', () => {
    expect(classifyFeedback('I have some general thoughts about this')).toBe('style_issue');
  });
});

/* ------------------------------------------------------------------ */
/*  recordReviewFeedback                                               */
/* ------------------------------------------------------------------ */

describe('recordReviewFeedback', () => {
  const sampleFeedback = [
    {
      repo: 'test-repo',
      pr_number: 42,
      feedback_type: 'style_issue' as const,
      comment_text: 'Use const',
      file_path: 'src/auth.ts',
      author: 'alice',
    },
  ];

  it('sends PUT request with feedback records', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const result = await recordReviewFeedback(makeEpisodeConfig(), sampleFeedback);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('PUT');
  });

  it('returns false when disabled', async () => {
    const result = await recordReviewFeedback(makeEpisodeConfig({ enabled: false }), sampleFeedback);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false when endpoint is missing', async () => {
    const result = await recordReviewFeedback(makeEpisodeConfig({ endpoint: undefined }), sampleFeedback);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await recordReviewFeedback(makeEpisodeConfig(), sampleFeedback)).toBe(false);
  });

  it('returns false on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'fail' }, 500));
    expect(await recordReviewFeedback(makeEpisodeConfig(), sampleFeedback)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  formatReviewFeedback                                               */
/* ------------------------------------------------------------------ */

describe('formatReviewFeedback', () => {
  it('formats multiple feedback items as markdown', () => {
    const feedback = [
      {
        feedback_type: 'style_issue',
        pr_number: 42,
        comment_text: 'Use const',
        file_path: 'src/auth.ts',
      },
      {
        feedback_type: 'logic_error',
        pr_number: 99,
        comment_text: 'Off-by-one in loop',
        file_path: 'src/parser.ts',
      },
    ];
    const result = formatReviewFeedback(feedback);
    expect(result).toContain('## Past reviewer feedback');
    expect(result).toContain('[style_issue]');
    expect(result).toContain('PR #42');
    expect(result).toContain('"Use const"');
    expect(result).toContain('file: src/auth.ts');
    expect(result).toContain('[logic_error]');
    expect(result).toContain('PR #99');
    expect(result).toContain('"Off-by-one in loop"');
    expect(result).toContain('file: src/parser.ts');
  });

  it('returns empty string for empty array', () => {
    expect(formatReviewFeedback([])).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  insertReviewFeedback                                               */
/* ------------------------------------------------------------------ */

describe('insertReviewFeedback', () => {
  it('calls pool.query with correct SQL pattern and parameters', async () => {
    const pool = makeMockPool();
    const client = makeMockClient(pool);
    const feedback = {
      repo: 'test-repo',
      pr_number: 42,
      feedback_type: 'style_issue',
      comment_text: 'Use const',
      file_path: 'src/auth.ts',
      author: 'alice',
    };

    await insertReviewFeedback(client, feedback);

    expect(client.embed).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO');
    expect(sql).toContain('review_feedback');
    expect(params).toContain('test-repo');
    expect(params).toContain(42);
    expect(params).toContain('style_issue');
    expect(params).toContain('Use const');
    expect(params).toContain('src/auth.ts');
  });
});

/* ------------------------------------------------------------------ */
/*  queryReviewFeedback                                                */
/* ------------------------------------------------------------------ */

describe('queryReviewFeedback', () => {
  it('returns rows from pool query', async () => {
    const expectedRows = [
      { id: 1, repo: 'test-repo', feedback_type: 'style_issue', comment_text: 'Use const' },
      { id: 2, repo: 'test-repo', feedback_type: 'logic_error', comment_text: 'Off-by-one' },
    ];
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: expectedRows });
    const client = makeMockClient(pool);

    const rows = await queryReviewFeedback(client, 'test-repo', 'style issues in auth');
    expect(rows).toEqual(expectedRows);
    expect(client.embed).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('respects custom limit parameter', async () => {
    const pool = makeMockPool();
    const client = makeMockClient(pool);

    await queryReviewFeedback(client, 'test-repo', 'style issues', 3);

    const [_sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params).toContain(3);
  });

  it('uses default limit when not provided', async () => {
    const pool = makeMockPool();
    const client = makeMockClient(pool);

    await queryReviewFeedback(client, 'test-repo', 'style issues');

    const [_sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    // Default limit should be present (e.g. 10 or 5)
    const lastParam = params?.at(-1);
    expect(typeof lastParam).toBe('number');
    expect(lastParam).toBeGreaterThan(0);
  });
});
