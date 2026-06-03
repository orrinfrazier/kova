import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoIntelConfig } from '../types/config.js';
import {
  formatRepoContext,
  formatRepoSearch,
  formatRepoStandards,
  queryRepoContext,
  queryRepoSearch,
  queryRepoStandards,
} from './repo-intel.js';

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

const ENDPOINT = 'http://localhost:9999/repo-intel';

function enabledConfig(overrides?: Partial<RepoIntelConfig>): RepoIntelConfig {
  return {
    enabled: true,
    endpoint: ENDPOINT,
    limit: 5,
    ...overrides,
  } as RepoIntelConfig;
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ------------------------------------------------------------------ */
/*  queryRepoContext                                                    */
/* ------------------------------------------------------------------ */

describe('queryRepoContext', () => {
  it('returns context when endpoint responds successfully', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ result: '## Architecture\nMonorepo with auth and api modules.' }),
    );

    const result = await queryRepoContext(enabledConfig(), 'owner/repo', 'fix login bug');

    expect(result).toBe('## Architecture\nMonorepo with auth and api modules.');
    expect(mockFetch).toHaveBeenCalledOnce();

    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toBe(ENDPOINT);
    const body = JSON.parse(call?.[1]?.body as string) as Record<string, unknown>;
    expect(body.tool).toBe('repo_context');
    expect(body.params).toEqual({ repo: 'owner/repo', query: 'fix login bug', limit: 5 });
  });

  it('returns empty string when disabled', async () => {
    const result = await queryRepoContext({ enabled: false, limit: 5 } as RepoIntelConfig, 'owner/repo', 'query');
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty string when endpoint is missing', async () => {
    const result = await queryRepoContext({ enabled: true, limit: 5 } as RepoIntelConfig, 'owner/repo', 'query');
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty string on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 500));

    const result = await queryRepoContext(enabledConfig(), 'owner/repo', 'query');
    expect(result).toBe('');
  });

  it('returns empty string on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await queryRepoContext(enabledConfig(), 'owner/repo', 'query');
    expect(result).toBe('');
  });

  it('returns empty string when response has no result field', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ other: 'data' }));

    const result = await queryRepoContext(enabledConfig(), 'owner/repo', 'query');
    expect(result).toBe('');
  });

  it('passes configured limit', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: 'context' }));

    await queryRepoContext(enabledConfig({ limit: 10 } as Partial<RepoIntelConfig>), 'owner/repo', 'q');

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    const params = body.params as Record<string, unknown>;
    expect(params.limit).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/*  queryRepoSearch                                                    */
/* ------------------------------------------------------------------ */

describe('queryRepoSearch', () => {
  it('returns search results when endpoint responds', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: '### src/auth/token.ts\nfunction validateToken() {}' }));

    const result = await queryRepoSearch(enabledConfig(), 'owner/repo', 'token validation');

    expect(result).toContain('validateToken');
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.tool).toBe('repo_search');
    expect(body.params).toEqual({ repo: 'owner/repo', query: 'token validation', limit: 5 });
  });

  it('returns empty string when disabled', async () => {
    const result = await queryRepoSearch({ enabled: false, limit: 5 } as RepoIntelConfig, 'owner/repo', 'query');
    expect(result).toBe('');
  });

  it('returns empty string on error', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 503));

    const result = await queryRepoSearch(enabledConfig(), 'owner/repo', 'query');
    expect(result).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  queryRepoStandards                                                 */
/* ------------------------------------------------------------------ */

describe('queryRepoStandards', () => {
  it('returns standards when endpoint responds', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ result: '## Standards\n- Vitest for testing\n- Biome for linting' }),
    );

    const result = await queryRepoStandards(enabledConfig(), 'owner/repo');

    expect(result).toContain('Vitest');
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.tool).toBe('repo_standards');
    expect(body.params).toEqual({ repo: 'owner/repo' });
  });

  it('returns empty string when disabled', async () => {
    const result = await queryRepoStandards({ enabled: false, limit: 5 } as RepoIntelConfig, 'owner/repo');
    expect(result).toBe('');
  });

  it('returns empty string on error', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 500));

    const result = await queryRepoStandards(enabledConfig(), 'owner/repo');
    expect(result).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  Format functions                                                   */
/* ------------------------------------------------------------------ */

describe('formatRepoContext', () => {
  it('wraps raw context in a markdown section', () => {
    const result = formatRepoContext('Monorepo with auth and api modules.');
    expect(result).toBe('## Repository context\n\nMonorepo with auth and api modules.');
  });

  it('returns empty string for empty input', () => {
    expect(formatRepoContext('')).toBe('');
  });
});

describe('formatRepoSearch', () => {
  it('wraps raw search results in a markdown section', () => {
    const result = formatRepoSearch('function validateToken() {}');
    expect(result).toBe('## Similar implementations\n\nfunction validateToken() {}');
  });

  it('returns empty string for empty input', () => {
    expect(formatRepoSearch('')).toBe('');
  });
});

describe('formatRepoStandards', () => {
  it('wraps raw standards in a markdown section', () => {
    const result = formatRepoStandards('Vitest for testing, Biome for linting');
    expect(result).toBe('## Project standards\n\nVitest for testing, Biome for linting');
  });

  it('returns empty string for empty input', () => {
    expect(formatRepoStandards('')).toBe('');
  });
});
