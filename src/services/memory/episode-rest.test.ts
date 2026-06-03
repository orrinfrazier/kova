import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodicMemoryConfig } from '../../types/config.js';
import { type EpisodeContext, formatEpisodes, formatFailedEpisodes, queryEpisodeContext } from './episode-rest.js';

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENDPOINT = 'http://localhost:8100/query';

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

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
