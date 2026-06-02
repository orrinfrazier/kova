import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodicMemoryConfig, PlaybooksConfig, VectorDBConfig } from '../types/config.js';
import {
  type CodeChunk,
  clusterEpisodes,
  createVectorDBClient,
  type EpisodeContext,
  type EpisodeForCluster,
  formatCodeChunks,
  formatEpisodes,
  formatFailedEpisodes,
  formatPlaybook,
  insertEpisode,
  type PlaybookRecord,
  queryCodeContext,
  queryCodeEmbeddings,
  queryEpisodeContext,
  queryEpisodes,
  queryPatterns,
  queryPlaybook,
  recordPlaybook,
  runMigration,
  type SynthesizeFn,
  synthesizePlaybook,
  upsertChunks,
  upsertCodeEmbeddings,
  upsertPattern,
} from './vectordb.js';

/* ================================================================== */
/*  REST endpoint client tests (queryCodeContext / formatCodeChunks)    */
/* ================================================================== */

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENDPOINT = 'http://localhost:8100/query';

const sampleChunks: CodeChunk[] = [
  {
    file: 'src/auth/token.ts',
    content: 'export function validateToken(token: string): boolean {\n  return token.length > 0;\n}',
    score: 0.92,
    startLine: 10,
    endLine: 15,
  },
  {
    file: 'src/api/login.ts',
    content: 'async function login(req: Request): Promise<Response> {\n  // handle login\n}',
    score: 0.85,
    startLine: 1,
    endLine: 5,
  },
];

function makeConfig(overrides?: Partial<VectorDBConfig>): VectorDBConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    top_k: 10,
    ...overrides,
  };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('queryCodeContext', () => {
  it('returns code chunks from vector DB endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ chunks: sampleChunks }));

    const chunks = await queryCodeContext(makeConfig(), 'fix login bug');

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.file).toBe('src/auth/token.ts');
    expect(chunks[0]?.score).toBe(0.92);
    expect(chunks[1]?.file).toBe('src/api/login.ts');
  });

  it('sends query and top_k in POST body', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ chunks: [] }));

    await queryCodeContext(makeConfig({ top_k: 5 }), 'search query');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { query: string; top_k: number };
    expect(body.query).toBe('search query');
    expect(body.top_k).toBe(5);
  });

  it('returns empty array when disabled', async () => {
    const chunks = await queryCodeContext(makeConfig({ enabled: false }), 'query');

    expect(chunks).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty array and does not throw on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const chunks = await queryCodeContext(makeConfig(), 'query');

    expect(chunks).toEqual([]);
  });

  it('returns empty array on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'fail' }, 500));

    const chunks = await queryCodeContext(makeConfig(), 'query');

    expect(chunks).toEqual([]);
  });

  it('returns empty array on malformed response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ wrong: 'shape' }));

    const chunks = await queryCodeContext(makeConfig(), 'query');

    expect(chunks).toEqual([]);
  });

  it('uses top_k from config', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ chunks: [] }));

    await queryCodeContext(makeConfig({ top_k: 3 }), 'query');

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      top_k: number;
    };
    expect(body.top_k).toBe(3);
  });
});

describe('formatCodeChunks', () => {
  it('formats chunks with file paths and code blocks', () => {
    const result = formatCodeChunks(sampleChunks);

    expect(result).toContain('## Relevant code from the codebase');
    expect(result).toContain('src/auth/token.ts');
    expect(result).toContain('src/api/login.ts');
    expect(result).toContain('validateToken');
    expect(result).toContain('async function login');
  });

  it('includes line numbers when present', () => {
    const result = formatCodeChunks(sampleChunks);

    expect(result).toContain('L10-15');
  });

  it('returns empty string for empty chunks', () => {
    const result = formatCodeChunks([]);

    expect(result).toBe('');
  });

  it('orders chunks by score descending', () => {
    const unordered: CodeChunk[] = [
      { file: 'low.ts', content: 'low', score: 0.5 },
      { file: 'high.ts', content: 'high', score: 0.95 },
      { file: 'mid.ts', content: 'mid', score: 0.7 },
    ];

    const result = formatCodeChunks(unordered);
    const highIdx = result.indexOf('high.ts');
    const midIdx = result.indexOf('mid.ts');
    const lowIdx = result.indexOf('low.ts');

    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('handles chunks without line numbers', () => {
    const chunks: CodeChunk[] = [{ file: 'src/utils.ts', content: 'const x = 1;', score: 0.8 }];

    const result = formatCodeChunks(chunks);
    expect(result).toContain('src/utils.ts');
    expect(result).not.toContain('undefined');
  });
});

/* ================================================================== */
/*  Episodic memory REST client tests                                  */
/* ================================================================== */

const sampleEpisodes: EpisodeContext[] = [
  {
    issue_number: 10,
    issue_title: 'Fix token expiry handling',
    approach: 'Added TTL check in auth middleware',
    outcome: 'success',
    learnings: 'Token refresh must happen before the API call, not after',
    score: 0.91,
  },
  {
    issue_number: 7,
    issue_title: 'Refactor session store',
    approach: 'Tried replacing in-memory store with Redis',
    outcome: 'partial',
    learnings: 'Redis worked for sessions but broke websocket state — keep ws state in-memory',
    score: 0.78,
  },
  {
    issue_number: 3,
    issue_title: 'Add rate limiting',
    approach: 'Used sliding window algorithm',
    outcome: 'failure',
    learnings: 'Sliding window was too expensive — use token bucket instead',
    score: 0.65,
  },
];

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

describe('queryEpisodeContext', () => {
  it('returns episodes from endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: sampleEpisodes }));

    const episodes = await queryEpisodeContext(makeEpisodeConfig(), 'fix token bug');

    expect(episodes).toHaveLength(3);
    expect(episodes[0]?.issue_title).toBe('Fix token expiry handling');
    expect(episodes[0]?.score).toBe(0.91);
  });

  it('sends query and max_episodes in POST body', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: [] }));

    await queryEpisodeContext(makeEpisodeConfig({ max_episodes: 2 }), 'search query');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { query: string; top_k: number };
    expect(body.query).toBe('search query');
    expect(body.top_k).toBe(2);
  });

  it('sends repo and language when cross_repo is enabled', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: [] }));

    await queryEpisodeContext(makeEpisodeConfig({ cross_repo: true, language_filter: true }), 'search query', {
      repo: 'my-repo',
      language: 'typescript',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body.repo).toBe('my-repo');
    expect(body.language).toBe('typescript');
    expect(body.cross_repo).toBe(true);
  });

  it('sends repo without cross_repo flag when cross_repo is false', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: [] }));

    await queryEpisodeContext(makeEpisodeConfig({ cross_repo: false }), 'search query', {
      repo: 'my-repo',
      language: 'typescript',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body.repo).toBe('my-repo');
    expect(body.cross_repo).toBe(false);
  });

  it('omits language when language_filter is false', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: [] }));

    await queryEpisodeContext(makeEpisodeConfig({ cross_repo: true, language_filter: false }), 'search query', {
      repo: 'my-repo',
      language: 'typescript',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body.language).toBeUndefined();
  });

  it('returns empty array when disabled', async () => {
    const episodes = await queryEpisodeContext(makeEpisodeConfig({ enabled: false }), 'query');

    expect(episodes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty array on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const episodes = await queryEpisodeContext(makeEpisodeConfig(), 'query');

    expect(episodes).toEqual([]);
  });

  it('returns empty array on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'fail' }, 500));

    const episodes = await queryEpisodeContext(makeEpisodeConfig(), 'query');

    expect(episodes).toEqual([]);
  });

  it('returns empty array on malformed response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ wrong: 'shape' }));

    const episodes = await queryEpisodeContext(makeEpisodeConfig(), 'query');

    expect(episodes).toEqual([]);
  });

  it('caps results at max_episodes', async () => {
    const base = sampleEpisodes[0] as EpisodeContext;
    const manyEpisodes = Array.from({ length: 5 }, (_, i) => ({
      ...base,
      issue_number: i + 1,
      score: 0.9 - i * 0.05,
    }));
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ episodes: manyEpisodes }));

    const episodes = await queryEpisodeContext(makeEpisodeConfig({ max_episodes: 3 }), 'query');

    expect(episodes).toHaveLength(3);
  });

  it('returns empty array when endpoint is missing', async () => {
    const episodes = await queryEpisodeContext(makeEpisodeConfig({ endpoint: undefined }), 'query');

    expect(episodes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('formatEpisodes', () => {
  it('formats episodes with issue titles and learnings', () => {
    const result = formatEpisodes(sampleEpisodes);

    expect(result).toContain('## Learnings from similar past issues');
    expect(result).toContain('#10: Fix token expiry handling');
    expect(result).toContain('Token refresh must happen before the API call');
    expect(result).toContain('#7: Refactor session store');
    expect(result).toContain('Redis worked for sessions but broke websocket state');
  });

  it('includes approach and outcome', () => {
    const result = formatEpisodes(sampleEpisodes);

    expect(result).toContain('Added TTL check in auth middleware');
    expect(result).toContain('success');
    expect(result).toContain('failure');
  });

  it('returns empty string for empty episodes', () => {
    expect(formatEpisodes([])).toBe('');
  });

  it('orders episodes by score descending', () => {
    const [ep0, ep1, ep2] = sampleEpisodes as [EpisodeContext, EpisodeContext, EpisodeContext];
    const unordered: EpisodeContext[] = [
      { ...ep2, score: 0.5 },
      { ...ep0, score: 0.95 },
      { ...ep1, score: 0.7 },
    ];

    const result = formatEpisodes(unordered);
    const highIdx = result.indexOf('#10');
    const midIdx = result.indexOf('#7');
    const lowIdx = result.indexOf('#3');

    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('shows repo attribution when episodes have repo field and currentRepo given', () => {
    const [ep0, ep1] = sampleEpisodes as [EpisodeContext, EpisodeContext];
    const episodesWithRepo: EpisodeContext[] = [
      { ...ep0, repo: 'my-repo', score: 0.9 },
      { ...ep1, repo: 'other-repo', score: 0.8 },
    ];

    const result = formatEpisodes(episodesWithRepo, 'my-repo');

    expect(result).toContain('[same-repo]');
    expect(result).toContain('[cross-repo: other-repo]');
  });

  it('omits repo attribution when currentRepo is not provided', () => {
    const [ep0] = sampleEpisodes as [EpisodeContext];
    const episodesWithRepo: EpisodeContext[] = [{ ...ep0, repo: 'my-repo', score: 0.9 }];

    const result = formatEpisodes(episodesWithRepo);

    expect(result).not.toContain('[same-repo]');
    expect(result).not.toContain('[cross-repo');
  });
});

describe('formatFailedEpisodes', () => {
  it('returns only failure episodes with avoidance framing', () => {
    const result = formatFailedEpisodes(sampleEpisodes);

    expect(result).toContain('## Past failed approaches — avoid repeating');
    expect(result).toContain('#3: Add rate limiting');
    expect(result).toContain('Avoid this decomposition');
    expect(result).toContain('Sliding window was too expensive');
  });

  it('excludes success and partial episodes', () => {
    const result = formatFailedEpisodes(sampleEpisodes);

    expect(result).not.toContain('#10: Fix token expiry handling');
    expect(result).not.toContain('#7: Refactor session store');
  });

  it('returns empty string when no failed episodes', () => {
    const successOnly: EpisodeContext[] = [
      { ...(sampleEpisodes[0] as EpisodeContext), outcome: 'success' },
      { ...(sampleEpisodes[1] as EpisodeContext), outcome: 'partial' },
    ];

    expect(formatFailedEpisodes(successOnly)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(formatFailedEpisodes([])).toBe('');
  });

  it('orders failed episodes by score descending', () => {
    const failures: EpisodeContext[] = [
      { issue_number: 1, issue_title: 'Low', approach: 'a', outcome: 'failure', learnings: 'l', score: 0.3 },
      { issue_number: 2, issue_title: 'High', approach: 'b', outcome: 'failure', learnings: 'l', score: 0.9 },
    ];

    const result = formatFailedEpisodes(failures);
    const highIdx = result.indexOf('#2');
    const lowIdx = result.indexOf('#1');

    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('includes repo attribution when currentRepo provided', () => {
    const failures: EpisodeContext[] = [{ ...(sampleEpisodes[2] as EpisodeContext), repo: 'my-repo', score: 0.8 }];

    const result = formatFailedEpisodes(failures, 'my-repo');

    expect(result).toContain('[same-repo]');
  });
});

/* ================================================================== */
/*  pgvector client tests                                              */
/* ================================================================== */

function makeMockPool(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function makeMockEmbed(): Mock<(text: string) => Promise<number[]>> {
  return vi.fn().mockResolvedValue(new Array(1536).fill(0));
}

describe('createVectorDBClient', () => {
  it('returns an object with pool and embed properties', () => {
    const mockEmbed = makeMockEmbed();
    const client = createVectorDBClient({
      connectionString: 'postgresql://localhost:5433/kova',
      embedFn: mockEmbed,
    });

    expect(client).toHaveProperty('pool');
    expect(client).toHaveProperty('embed');
  });

  it('uses the provided embedFn as the embed function', async () => {
    const mockEmbed = makeMockEmbed();
    const client = createVectorDBClient({
      connectionString: 'postgresql://localhost:5433/kova',
      embedFn: mockEmbed,
    });

    await client.embed('test text');
    expect(mockEmbed).toHaveBeenCalledWith('test text');
  });

  it('defaults to postgresql://localhost:5433/kova when no connectionString given', () => {
    const mockEmbed = makeMockEmbed();
    const client = createVectorDBClient({ embedFn: mockEmbed });

    expect(client).toHaveProperty('pool');
    expect(client).toHaveProperty('embed');
  });

  it('pool is a pg.Pool-compatible object with a query method', () => {
    const mockEmbed = makeMockEmbed();
    const client = createVectorDBClient({
      connectionString: 'postgresql://localhost:5433/kova',
      embedFn: mockEmbed,
    });

    expect(typeof client.pool.query).toBe('function');
  });
});

describe('upsertCodeEmbeddings', () => {
  it('returns 0 for empty chunks array', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const count = await upsertCodeEmbeddings(client, 'my-repo', []);

    expect(count).toBe(0);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('calls embed once for each chunk', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };
    const chunks = [
      { filePath: 'src/a.ts', text: 'export function a() {}' },
      { filePath: 'src/b.ts', text: 'export function b() {}' },
      { filePath: 'src/c.ts', text: 'export function c() {}' },
    ];

    await upsertCodeEmbeddings(client, 'my-repo', chunks);

    expect(mockEmbed).toHaveBeenCalledTimes(3);
    expect(mockEmbed).toHaveBeenCalledWith('export function a() {}');
    expect(mockEmbed).toHaveBeenCalledWith('export function b() {}');
    expect(mockEmbed).toHaveBeenCalledWith('export function c() {}');
  });

  it('calls pool.query once per chunk for upserts', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };
    const chunks = [
      { filePath: 'src/a.ts', text: 'const x = 1;' },
      { filePath: 'src/b.ts', text: 'const y = 2;' },
    ];

    await upsertCodeEmbeddings(client, 'my-repo', chunks);

    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('returns the count of upserted chunks', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };
    const chunks = [
      { filePath: 'src/a.ts', text: 'code a' },
      { filePath: 'src/b.ts', text: 'code b' },
      { filePath: 'src/c.ts', text: 'code c' },
    ];

    const count = await upsertCodeEmbeddings(client, 'my-repo', chunks);

    expect(count).toBe(3);
  });

  it('passes repo name to each pool.query call', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };
    const chunks = [{ filePath: 'src/x.ts', text: 'hello world' }];

    await upsertCodeEmbeddings(client, 'target-repo', chunks);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    const params = queryArgs[1] as unknown[];
    expect(sql).toBeDefined();
    expect(params).toContain('target-repo');
  });
});

describe('queryCodeEmbeddings', () => {
  it('calls embed with the query string', async () => {
    const fakeRows = [{ id: 1, repo: 'my-repo', file_path: 'src/a.ts', chunk_text: 'code', embedding: [] }];
    const mockPool = makeMockPool(fakeRows);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryCodeEmbeddings(client, 'my-repo', 'find auth logic');

    expect(mockEmbed).toHaveBeenCalledOnce();
    expect(mockEmbed).toHaveBeenCalledWith('find auth logic');
  });

  it('calls pool.query once for the vector similarity search', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryCodeEmbeddings(client, 'my-repo', 'some query');

    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('returns the rows from pool.query', async () => {
    const fakeRows = [
      { id: 1, repo: 'my-repo', file_path: 'src/auth.ts', chunk_text: 'auth code', updated_at: '2026-01-01' },
    ];
    const mockPool = makeMockPool(fakeRows);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryCodeEmbeddings(client, 'my-repo', 'auth logic');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ file_path: 'src/auth.ts' });
  });

  it('passes the limit parameter to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryCodeEmbeddings(client, 'my-repo', 'query', 5);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(5);
  });

  it('uses default limit of 10 when not specified', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryCodeEmbeddings(client, 'my-repo', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(10);
  });

  it('passes repo to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryCodeEmbeddings(client, 'specific-repo', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain('specific-repo');
  });
});

describe('insertEpisode', () => {
  it('calls embed with a meaningful text representation of the episode', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };
    const episode = {
      repo: 'my-repo',
      issue_number: 42,
      issue_title: 'Fix login bug',
      approach: 'Validate JWT tokens properly',
      outcome: 'success' as const,
      files_changed: ['src/auth.ts'],
    };

    await insertEpisode(client, episode);

    expect(mockEmbed).toHaveBeenCalledOnce();
    const [embeddedText] = mockEmbed.mock.calls[0] as [string];
    expect(typeof embeddedText).toBe('string');
    expect(embeddedText.length).toBeGreaterThan(0);
  });

  it('calls pool.query once to insert the episode', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await insertEpisode(client, {
      repo: 'my-repo',
      issue_number: 1,
      issue_title: 'Test issue',
      approach: 'fix approach',
      outcome: 'fail' as const,
      files_changed: [],
    });

    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('passes repo to pool.query', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await insertEpisode(client, {
      repo: 'target-repo',
      issue_number: 7,
      issue_title: 'Something',
      approach: 'approach',
      outcome: 'success' as const,
      files_changed: ['src/x.ts'],
    });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain('target-repo');
  });

  it('returns void (undefined)', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const result = await insertEpisode(client, {
      repo: 'my-repo',
      issue_number: 1,
      issue_title: 'Test',
      approach: 'approach',
      outcome: 'success' as const,
      files_changed: [],
    });

    expect(result).toBeUndefined();
  });

  it('passes language to pool.query when provided', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await insertEpisode(client, {
      repo: 'my-repo',
      issue_number: 1,
      issue_title: 'Test',
      approach: 'approach',
      outcome: 'success' as const,
      files_changed: [],
      language: 'typescript',
    });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    const params = queryArgs[1] as unknown[];
    expect(sql).toContain('language');
    expect(params).toContain('typescript');
  });

  it('passes null language when not provided', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await insertEpisode(client, {
      repo: 'my-repo',
      issue_number: 1,
      issue_title: 'Test',
      approach: 'approach',
      outcome: 'success' as const,
      files_changed: [],
    });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(null);
  });
});

describe('queryEpisodes', () => {
  it('calls embed with the query string', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'auth failures');

    expect(mockEmbed).toHaveBeenCalledOnce();
    expect(mockEmbed).toHaveBeenCalledWith('auth failures');
  });

  it('calls pool.query once for the similarity search', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'some query');

    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('returns the rows from pool.query', async () => {
    const fakeRows = [
      {
        id: 1,
        repo: 'my-repo',
        issue_number: 5,
        issue_title: 'Fix login',
        approach: 'JWT fix',
        outcome: 'success',
        files_changed: ['src/auth.ts'],
        created_at: '2026-01-01',
      },
    ];
    const mockPool = makeMockPool(fakeRows);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryEpisodes(client, 'my-repo', 'auth fix');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ issue_number: 5, outcome: 'success' });
  });

  it('passes limit to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query', 3);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(3);
  });

  it('uses default limit of 5 when not specified', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(5);
  });

  it('passes repo to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'special-repo', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain('special-repo');
  });

  it('uses cross-repo SQL when crossRepo option is true', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query', 5, { crossRepo: true });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    // Cross-repo query should NOT have WHERE repo = $1 filter
    expect(sql).not.toMatch(/WHERE\s+repo\s*=\s*\$1\s*$/m);
    // Should use same-repo weighting via CASE expression
    expect(sql).toContain('CASE');
  });

  it('filters by language when language option is provided', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query', 5, { crossRepo: true, language: 'typescript' });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    const params = queryArgs[1] as unknown[];
    expect(sql).toContain('language');
    expect(params).toContain('typescript');
  });

  it('does not filter by language when language is not provided', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query', 5, { crossRepo: true });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    expect(sql).not.toContain('language');
  });

  it('uses single-repo SQL when crossRepo option is false or omitted', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryEpisodes(client, 'my-repo', 'query', 5, { crossRepo: false });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    expect(sql).toMatch(/WHERE\s+repo\s*=\s*\$1/);
  });
});

describe('upsertPattern', () => {
  it('calls embed with a text representation of the pattern', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await upsertPattern(client, {
      repo: 'my-repo',
      pattern_description: 'Use Zod for validation at API boundaries',
      frequency: 5,
      success_rate: 0.9,
    });

    expect(mockEmbed).toHaveBeenCalledOnce();
    const [embeddedText] = mockEmbed.mock.calls[0] as [string];
    expect(typeof embeddedText).toBe('string');
    expect(embeddedText.length).toBeGreaterThan(0);
  });

  it('calls pool.query once to upsert the pattern', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await upsertPattern(client, {
      repo: 'my-repo',
      pattern_description: 'Always use strict mode',
      frequency: 10,
      success_rate: 1.0,
    });

    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('passes repo to pool.query', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await upsertPattern(client, {
      repo: 'pattern-repo',
      pattern_description: 'Use strict TS',
      frequency: 3,
      success_rate: 0.8,
    });

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain('pattern-repo');
  });

  it('returns void (undefined)', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const result = await upsertPattern(client, {
      repo: 'my-repo',
      pattern_description: 'Test pattern',
      frequency: 1,
      success_rate: 0.5,
    });

    expect(result).toBeUndefined();
  });
});

describe('queryPatterns', () => {
  it('calls embed with the query string', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryPatterns(client, 'my-repo', 'validation patterns');

    expect(mockEmbed).toHaveBeenCalledOnce();
    expect(mockEmbed).toHaveBeenCalledWith('validation patterns');
  });

  it('calls pool.query once for the similarity search', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryPatterns(client, 'my-repo', 'some query');

    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('returns the rows from pool.query', async () => {
    const fakeRows = [
      {
        id: 1,
        repo: 'my-repo',
        pattern_description: 'Use Zod',
        frequency: 7,
        success_rate: 0.95,
        updated_at: '2026-01-01',
      },
    ];
    const mockPool = makeMockPool(fakeRows);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryPatterns(client, 'my-repo', 'schema validation');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pattern_description: 'Use Zod', frequency: 7 });
  });

  it('passes limit to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryPatterns(client, 'my-repo', 'query', 4);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(4);
  });

  it('uses default limit of 5 when not specified', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryPatterns(client, 'my-repo', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain(5);
  });

  it('passes repo to pool.query', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await queryPatterns(client, 'repo-x', 'query');

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const params = queryArgs[1] as unknown[];
    expect(params).toContain('repo-x');
  });
});

describe('runMigration', () => {
  it('calls pool.query for each migration file', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await runMigration(client);

    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('passes a non-empty SQL string to pool.query', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await runMigration(client);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    expect(typeof sql).toBe('string');
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  it('migration SQL contains CREATE EXTENSION for vector', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await runMigration(client);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    expect(sql).toMatch(/CREATE\s+EXTENSION/i);
  });

  it('migration SQL contains CREATE TABLE for code_embeddings', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await runMigration(client);

    const queryArgs = mockPool.query.mock.calls[0] as unknown[];
    const sql = queryArgs[0] as string;
    expect(sql).toMatch(/code_embeddings/i);
  });

  it('reads the migration file from the migrations directory', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await expect(runMigration(client)).resolves.toBeUndefined();
  });

  it('returns void (undefined)', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const result = await runMigration(client);

    expect(result).toBeUndefined();
  });
});

describe('VectorDBClient interface contract', () => {
  it('createVectorDBClient returns a client where embed is the injected function', async () => {
    const mockEmbed = makeMockEmbed();
    const client = createVectorDBClient({
      connectionString: 'postgresql://localhost:5433/kova',
      embedFn: mockEmbed,
    });

    const vec = await client.embed('hello');
    expect(vec).toHaveLength(1536);
    expect(mockEmbed).toHaveBeenCalledWith('hello');
  });

  it('all functions accept the client as first argument (no module-level state)', async () => {
    const embed1 = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));
    const embed2 = vi.fn().mockResolvedValue(new Array(1536).fill(0.2));

    const pool1 = makeMockPool([]);
    const pool2 = makeMockPool([]);

    const client1 = { pool: pool1, embed: embed1 };
    const client2 = { pool: pool2, embed: embed2 };

    await queryCodeEmbeddings(client1, 'repo-1', 'query');
    await queryCodeEmbeddings(client2, 'repo-2', 'query');

    expect(embed1).toHaveBeenCalledOnce();
    expect(embed2).toHaveBeenCalledOnce();
    expect(pool1.query).toHaveBeenCalledOnce();
    expect(pool2.query).toHaveBeenCalledOnce();
  });
});

describe('edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upsertCodeEmbeddings with single chunk calls embed and query once each', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const count = await upsertCodeEmbeddings(client, 'repo', [{ filePath: 'a.ts', text: 'code' }]);

    expect(count).toBe(1);
    expect(mockEmbed).toHaveBeenCalledOnce();
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('queryCodeEmbeddings returns empty array when no rows found', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryCodeEmbeddings(client, 'repo', 'no matches');

    expect(results).toEqual([]);
  });

  it('queryEpisodes returns empty array when no rows found', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryEpisodes(client, 'repo', 'no matches');

    expect(results).toEqual([]);
  });

  it('queryPatterns returns empty array when no rows found', async () => {
    const mockPool = makeMockPool([]);
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    const results = await queryPatterns(client, 'repo', 'no matches');

    expect(results).toEqual([]);
  });
});

/* ================================================================== */
/*  upsertChunks — wired-up REST sink                                  */
/* ================================================================== */

const REINDEX_ENDPOINT = 'http://localhost:8100/reindex';

function makeVectorConfig(overrides?: Partial<VectorDBConfig>): VectorDBConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    reindex_endpoint: REINDEX_ENDPOINT,
    top_k: 10,
    ...overrides,
  };
}

describe('upsertChunks', () => {
  const sampleFileChunks = [
    { text: 'line1\nline2', startLine: 1, endLine: 2 },
    { text: 'line3\nline4', startLine: 3, endLine: 4 },
  ];

  it('POSTs chunks to reindex_endpoint when config is enabled', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ indexed: 1, api_calls: 2 }));

    await upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks, makeVectorConfig());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REINDEX_ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      repo_path: string;
      file_path: string;
      chunks: Array<{ text: string; startLine: number; endLine: number }>;
    };
    expect(body.repo_path).toBe('/tmp/repo');
    expect(body.file_path).toBe('src/a.ts');
    expect(body.chunks).toEqual(sampleFileChunks);
  });

  it('is a no-op when config is undefined (backwards compat — graceful degradation)', async () => {
    await upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is a no-op when config.enabled=false', async () => {
    await upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks, makeVectorConfig({ enabled: false }));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is a no-op when reindex_endpoint is not configured', async () => {
    await upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks, makeVectorConfig({ reindex_endpoint: undefined }));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips fetch when chunks array is empty', async () => {
    await upsertChunks('/tmp/repo', 'src/a.ts', [], makeVectorConfig());

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not throw when endpoint returns non-200 (graceful degradation)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'oops' }, 500));

    await expect(upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks, makeVectorConfig())).resolves.toBeUndefined();
  });

  it('does not throw on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(upsertChunks('/tmp/repo', 'src/a.ts', sampleFileChunks, makeVectorConfig())).resolves.toBeUndefined();
  });
});

/* ================================================================== */
/*  Playbook synthesis tests (#299)                                    */
/* ================================================================== */

const PLAYBOOK_ENDPOINT = 'http://localhost:8100/playbooks';

function makePlaybooksConfig(overrides?: Partial<PlaybooksConfig>): PlaybooksConfig {
  return {
    enabled: true,
    endpoint: PLAYBOOK_ENDPOINT,
    min_episodes: 3,
    ...overrides,
  };
}

const clusterEpisodeFixtures: EpisodeForCluster[] = [
  {
    issue_number: 101,
    issue_title: 'Fix auth token expiry',
    labels: ['bug', 'auth'],
    language: 'typescript',
    files_changed: ['src/auth/middleware.ts', 'src/auth/token.ts'],
    approach: 'Added TTL check before API call',
    outcome: 'success',
    learnings: 'Refresh before call, not after',
  },
  {
    issue_number: 102,
    issue_title: 'Auth refresh race condition',
    labels: ['bug', 'auth'],
    language: 'typescript',
    files_changed: ['src/auth/middleware.ts', 'src/auth/refresh.ts'],
    approach: 'Mutex around refresh path',
    outcome: 'success',
    learnings: 'Use a singleflight mutex',
  },
  {
    issue_number: 103,
    issue_title: 'Auth header parsing bug',
    labels: ['bug', 'auth'],
    language: 'typescript',
    files_changed: ['src/auth/middleware.ts'],
    approach: 'Trim whitespace before split',
    outcome: 'success',
    learnings: 'Headers may have leading whitespace',
  },
  {
    issue_number: 200,
    issue_title: 'Rate limiter slow',
    labels: ['performance'],
    language: 'rust',
    files_changed: ['src/rate.rs'],
    approach: 'Switched to token bucket',
    outcome: 'success',
    learnings: 'Token bucket is cheaper',
  },
];

describe('clusterEpisodes', () => {
  it('groups episodes that share a label, language, and at least one file', () => {
    const clusters = clusterEpisodes(clusterEpisodeFixtures, 2);

    expect(clusters.length).toBe(1);
    const issueNums = (clusters[0] ?? []).map((e) => e.issue_number).sort();
    expect(issueNums).toEqual([101, 102, 103]);
  });

  it('rejects clusters smaller than minSize', () => {
    const clusters = clusterEpisodes(clusterEpisodeFixtures, 5);
    expect(clusters).toEqual([]);
  });

  it('requires language equality across the cluster', () => {
    const mixed: EpisodeForCluster[] = [
      { ...(clusterEpisodeFixtures[0] as EpisodeForCluster), language: 'typescript' },
      { ...(clusterEpisodeFixtures[1] as EpisodeForCluster), language: 'rust' },
    ];
    const clusters = clusterEpisodes(mixed, 2);
    expect(clusters).toEqual([]);
  });

  it('requires at least one shared file in the cluster', () => {
    const noOverlap: EpisodeForCluster[] = [
      { ...(clusterEpisodeFixtures[0] as EpisodeForCluster), files_changed: ['src/a.ts'] },
      { ...(clusterEpisodeFixtures[1] as EpisodeForCluster), files_changed: ['src/b.ts'] },
    ];
    const clusters = clusterEpisodes(noOverlap, 2);
    expect(clusters).toEqual([]);
  });

  it('ignores failure-outcome episodes (only successes are clusterable)', () => {
    const withFailure: EpisodeForCluster[] = [
      ...clusterEpisodeFixtures.slice(0, 3),
      { ...(clusterEpisodeFixtures[0] as EpisodeForCluster), issue_number: 999, outcome: 'failure' },
    ];
    const clusters = clusterEpisodes(withFailure, 2);
    const allSuccess = clusters.every((c) => c.every((e) => e.outcome === 'success'));
    expect(allSuccess).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(clusterEpisodes([], 3)).toEqual([]);
  });

  it('returns empty array for minSize less than 2', () => {
    expect(clusterEpisodes(clusterEpisodeFixtures, 1)).toEqual([]);
    expect(clusterEpisodes(clusterEpisodeFixtures, 0)).toEqual([]);
  });
});

describe('synthesizePlaybook', () => {
  const stubSynth: SynthesizeFn = async () => ({
    trigger_description: 'Bugs in src/auth/middleware.ts on typescript repos',
    steps: ['Check token expiry', 'Mutex the refresh', 'Trim whitespace'],
    gotchas: ['Refresh-before-call ordering matters'],
    files_to_touch: ['src/auth/middleware.ts'],
  });

  it('returns a PlaybookRecord assembled from synthesizeFn output and cluster metadata', async () => {
    const cluster = clusterEpisodeFixtures.slice(0, 3);
    const pb = await synthesizePlaybook(cluster, stubSynth);

    expect(pb).not.toBeNull();
    expect(pb?.trigger.labels).toContain('auth');
    expect(pb?.trigger.language).toBe('typescript');
    expect(pb?.trigger.file_globs).toContain('src/auth/middleware.ts');
    expect(pb?.steps).toEqual(['Check token expiry', 'Mutex the refresh', 'Trim whitespace']);
    expect(pb?.gotchas).toEqual(['Refresh-before-call ordering matters']);
    expect(pb?.files_to_touch).toEqual(['src/auth/middleware.ts']);
    expect(pb?.episode_refs.sort()).toEqual([101, 102, 103]);
    expect(pb?.synthesized_from_count).toBe(3);
    expect(typeof pb?.created_at).toBe('string');
  });

  it('returns null when fewer than 2 episodes given (no pattern to distill)', async () => {
    const pb = await synthesizePlaybook([clusterEpisodeFixtures[0] as EpisodeForCluster], stubSynth);
    expect(pb).toBeNull();
  });

  it('returns null and logs a warning when synthesizeFn throws (never blocks fix)', async () => {
    const failing: SynthesizeFn = async () => {
      throw new Error('LLM down');
    };
    const pb = await synthesizePlaybook(clusterEpisodeFixtures.slice(0, 3), failing);
    expect(pb).toBeNull();
  });

  it('returns null when synthesizeFn returns malformed output (no steps array)', async () => {
    const bad: SynthesizeFn = async () =>
      ({ trigger_description: 'x', steps: 'not-an-array', gotchas: [], files_to_touch: [] }) as unknown as Awaited<
        ReturnType<SynthesizeFn>
      >;
    const pb = await synthesizePlaybook(clusterEpisodeFixtures.slice(0, 3), bad);
    expect(pb).toBeNull();
  });

  it('returns null for empty episode input', async () => {
    const pb = await synthesizePlaybook([], stubSynth);
    expect(pb).toBeNull();
  });
});

describe('formatPlaybook', () => {
  const samplePlaybook: PlaybookRecord = {
    trigger: {
      labels: ['bug', 'auth'],
      language: 'typescript',
      file_globs: ['src/auth/middleware.ts'],
    },
    steps: ['Check expiry first', 'Add mutex'],
    gotchas: ['Order of refresh vs call matters'],
    files_to_touch: ['src/auth/middleware.ts'],
    episode_refs: [101, 102, 103],
    synthesized_from_count: 3,
    created_at: '2026-06-01T00:00:00.000Z',
  };

  it('produces a markdown section with header and steps', () => {
    const out = formatPlaybook(samplePlaybook);
    expect(out).toContain('## Playbook');
    expect(out).toContain('Check expiry first');
    expect(out).toContain('Add mutex');
  });

  it('includes trigger metadata', () => {
    const out = formatPlaybook(samplePlaybook);
    expect(out).toContain('bug');
    expect(out).toContain('auth');
    expect(out).toContain('typescript');
  });

  it('includes gotchas and files-to-touch sections', () => {
    const out = formatPlaybook(samplePlaybook);
    expect(out).toContain('Gotchas');
    expect(out).toContain('Order of refresh vs call matters');
    expect(out).toContain('Files to touch');
    expect(out).toContain('src/auth/middleware.ts');
  });

  it('returns empty string for null', () => {
    expect(formatPlaybook(null)).toBe('');
  });
});

describe('queryPlaybook', () => {
  it('returns playbook from endpoint', async () => {
    const pb: PlaybookRecord = {
      trigger: { labels: ['bug'], language: 'typescript', file_globs: ['src/a.ts'] },
      steps: ['s'],
      gotchas: [],
      files_to_touch: ['src/a.ts'],
      episode_refs: [1, 2, 3],
      synthesized_from_count: 3,
      created_at: '2026-06-01T00:00:00.000Z',
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ playbook: pb }));

    const result = await queryPlaybook(makePlaybooksConfig(), 'auth token bug', {
      repo: 'my-repo',
      language: 'typescript',
    });

    expect(result).toEqual(pb);
  });

  it('returns null when disabled', async () => {
    const result = await queryPlaybook(makePlaybooksConfig({ enabled: false }), 'q');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when endpoint missing', async () => {
    const result = await queryPlaybook(makePlaybooksConfig({ endpoint: undefined }), 'q');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null on non-200 response (graceful degradation)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'oops' }, 500));
    const result = await queryPlaybook(makePlaybooksConfig(), 'q');
    expect(result).toBeNull();
  });

  it('returns null on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await queryPlaybook(makePlaybooksConfig(), 'q');
    expect(result).toBeNull();
  });

  it('returns null on malformed response missing playbook field', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ wrong: 'shape' }));
    const result = await queryPlaybook(makePlaybooksConfig(), 'q');
    expect(result).toBeNull();
  });
});

describe('recordPlaybook', () => {
  const pb: PlaybookRecord = {
    trigger: { labels: ['bug'], language: 'typescript', file_globs: ['src/a.ts'] },
    steps: ['s'],
    gotchas: [],
    files_to_touch: ['src/a.ts'],
    episode_refs: [1, 2, 3],
    synthesized_from_count: 3,
    created_at: '2026-06-01T00:00:00.000Z',
  };

  it('returns false when disabled', async () => {
    const ok = await recordPlaybook(makePlaybooksConfig({ enabled: false }), pb);
    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false when endpoint missing', async () => {
    const ok = await recordPlaybook(makePlaybooksConfig({ endpoint: undefined }), pb);
    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true on 200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const ok = await recordPlaybook(makePlaybooksConfig(), pb);
    expect(ok).toBe(true);
  });

  it('returns false on non-200 response (graceful degradation)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'oops' }, 500));
    const ok = await recordPlaybook(makePlaybooksConfig(), pb);
    expect(ok).toBe(false);
  });

  it('returns false on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ok = await recordPlaybook(makePlaybooksConfig(), pb);
    expect(ok).toBe(false);
  });
});
