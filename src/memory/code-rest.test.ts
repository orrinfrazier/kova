import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorDBConfig } from '../types/config.js';
import { type CodeChunk, formatCodeChunks, queryCodeContext, upsertChunks } from './code-rest.js';

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENDPOINT = 'http://localhost:8100/query';
const REINDEX_ENDPOINT = 'http://localhost:8100/reindex';

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

function makeVectorConfig(overrides?: Partial<VectorDBConfig>): VectorDBConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    reindex_endpoint: REINDEX_ENDPOINT,
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
