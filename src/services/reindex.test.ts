import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorDBConfig } from '../types/config.js';

/* ------------------------------------------------------------------ */
/*  Mock fetch + zx                                                    */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

const mock$ = Object.assign(vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }), {
  // Template literal tag support
  __isMockTag: true,
});

vi.mock('zx', () => ({
  $: new Proxy(mock$, {
    apply: (_target, _thisArg, args) => mock$(...args),
    get: (target, prop) => {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '';
      return Reflect.get(target, prop);
    },
  }),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mock$.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Import after mocks                                                 */
/* ------------------------------------------------------------------ */

const { reindexFiles, collectChangedFilesFromPRs, collectChangedFiles } = await import('./reindex.js');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const REINDEX_ENDPOINT = 'http://localhost:8100/reindex';

function makeConfig(overrides?: Partial<VectorDBConfig>): VectorDBConfig {
  return {
    enabled: true,
    endpoint: 'http://localhost:8100/query',
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

/* ------------------------------------------------------------------ */
/*  reindexFiles                                                       */
/* ------------------------------------------------------------------ */

describe('reindexFiles', () => {
  it('POSTs file list to reindex endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ indexed: 3, api_calls: 3 }));

    const result = await reindexFiles(makeConfig(), '/tmp/repo', ['src/a.ts', 'src/b.ts', 'src/c.ts']);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REINDEX_ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { repo_path: string; files: string[] };
    expect(body.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(body.repo_path).toBe('/tmp/repo');
    expect(result.success).toBe(true);
    expect(result.filesSubmitted).toBe(3);
  });

  it('returns api_calls from response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ indexed: 2, api_calls: 5 }));

    const result = await reindexFiles(makeConfig(), '/tmp/repo', ['a.ts', 'b.ts']);
    expect(result.apiCalls).toBe(5);
  });

  it('returns success=false on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'fail' }, 500));

    const result = await reindexFiles(makeConfig(), '/tmp/repo', ['a.ts']);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns success=false on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await reindexFiles(makeConfig(), '/tmp/repo', ['a.ts']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('skips when vectordb is disabled', async () => {
    const result = await reindexFiles(makeConfig({ enabled: false }), '/tmp/repo', ['a.ts']);
    expect(result.success).toBe(true);
    expect(result.filesSubmitted).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when no reindex_endpoint configured', async () => {
    const result = await reindexFiles(makeConfig({ reindex_endpoint: undefined }), '/tmp/repo', ['a.ts']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('reindex_endpoint');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when file list is empty', async () => {
    const result = await reindexFiles(makeConfig(), '/tmp/repo', []);
    expect(result.success).toBe(true);
    expect(result.filesSubmitted).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('tracks duration', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ indexed: 1, api_calls: 1 }));

    const result = await reindexFiles(makeConfig(), '/tmp/repo', ['a.ts']);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/*  collectChangedFilesFromPRs                                         */
/* ------------------------------------------------------------------ */

describe('collectChangedFilesFromPRs', () => {
  it('collects unique files from multiple PRs', async () => {
    mock$.mockResolvedValueOnce({ stdout: 'src/a.ts\nsrc/b.ts\n', exitCode: 0 });
    mock$.mockResolvedValueOnce({ stdout: 'src/b.ts\nsrc/c.ts\n', exitCode: 0 });

    const files = await collectChangedFilesFromPRs('/tmp/repo', [
      'https://github.com/owner/repo/pull/1',
      'https://github.com/owner/repo/pull/2',
    ]);

    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('returns empty array for empty PR list', async () => {
    const files = await collectChangedFilesFromPRs('/tmp/repo', []);
    expect(files).toEqual([]);
    expect(mock$).not.toHaveBeenCalled();
  });

  it('skips PRs that fail to query', async () => {
    mock$.mockResolvedValueOnce({ stdout: 'src/a.ts\n', exitCode: 0 });
    mock$.mockRejectedValueOnce(new Error('gh failed'));

    const files = await collectChangedFilesFromPRs('/tmp/repo', [
      'https://github.com/owner/repo/pull/1',
      'https://github.com/owner/repo/pull/2',
    ]);

    expect(files).toEqual(['src/a.ts']);
  });
});

/* ------------------------------------------------------------------ */
/*  collectChangedFiles                                                */
/* ------------------------------------------------------------------ */

describe('collectChangedFiles', () => {
  it('returns files from git diff against base branch', async () => {
    mock$.mockResolvedValueOnce({ stdout: 'src/a.ts\nsrc/b.ts\n', exitCode: 0 });

    const files = await collectChangedFiles('/tmp/repo', 'main');
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('defaults to main when no base specified', async () => {
    mock$.mockResolvedValueOnce({ stdout: 'src/a.ts\n', exitCode: 0 });

    const files = await collectChangedFiles('/tmp/repo');
    expect(files).toEqual(['src/a.ts']);
  });

  it('returns empty array when no changes', async () => {
    mock$.mockResolvedValueOnce({ stdout: '', exitCode: 0 });

    const files = await collectChangedFiles('/tmp/repo');
    expect(files).toEqual([]);
  });
});
