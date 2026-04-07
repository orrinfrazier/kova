import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorDBConfig } from '../types/config.js';
import {
  type CodeChunk,
  createVectorDBClient,
  formatCodeChunks,
  insertEpisode,
  queryCodeContext,
  queryCodeEmbeddings,
  queryEpisodes,
  queryPatterns,
  runMigration,
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
  it('calls pool.query to execute the migration SQL', async () => {
    const mockPool = makeMockPool();
    const mockEmbed = makeMockEmbed();
    const client = { pool: mockPool, embed: mockEmbed };

    await runMigration(client);

    expect(mockPool.query).toHaveBeenCalledOnce();
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
