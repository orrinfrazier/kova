// Tests for the public surface of `episode-rest.ts` after the #433 migration
// to sqlite-vec. The REST-fetch tests that lived here previously are gone
// because there is no remote endpoint anymore — the local sqlite-vec store
// is the only path. What remains:
//   - `queryEpisodeContext` integration against the local DB (graceful gates +
//     happy-path roundtrip).
//   - `recordEpisode` integration (writes a row that the next query reads).
//   - The pure helpers `formatEpisodes` and `formatFailedEpisodes`, which are
//     unchanged.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodicMemoryConfig } from '../types/config.js';
import type { EpisodeRecord } from '../types/memory.js';
import {
  type EpisodeContext,
  formatEpisodes,
  formatFailedEpisodes,
  queryEpisodeContext,
  recordEpisode,
} from './episode-rest.js';

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
    max_episodes: 3,
    cross_repo: true,
    same_repo_weight: 1.5,
    language_filter: true,
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<EpisodeRecord>): EpisodeRecord {
  return {
    issue_number: 1,
    issue_title: 'database connection pool exhausted',
    labels: ['bug'],
    repo: 'org/repo',
    approach: 'increased pool size and added timeout',
    files_changed: ['src/db.ts'],
    quality_gates: null,
    review_findings: [],
    outcome: 'pr_created',
    failed_at_wave: null,
    total_cost: 0.5,
    total_duration: 1000,
    total_turns: 3,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('queryEpisodeContext (sqlite-vec)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-episode-rest-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty array when disabled', async () => {
    const result = await queryEpisodeContext(makeEpisodeConfig({ enabled: false }), 'query', undefined, tmp);
    expect(result).toEqual([]);
  });

  it('returns empty array when workDir is missing', async () => {
    const result = await queryEpisodeContext(makeEpisodeConfig(), 'query');
    expect(result).toEqual([]);
  });

  it('returns empty array on empty DB', async () => {
    const result = await queryEpisodeContext(makeEpisodeConfig(), 'query', { repo: 'org/repo' }, tmp);
    expect(result).toEqual([]);
  });

  it('returns recorded episodes via roundtrip', async () => {
    await recordEpisode(makeEpisodeConfig(), makeRecord({ issue_number: 42 }), tmp);
    const results = await queryEpisodeContext(
      makeEpisodeConfig(),
      'database connection pool',
      { repo: 'org/repo' },
      tmp,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.issue_number).toBe(42);
  });

  it('caps results at max_episodes', async () => {
    const config = makeEpisodeConfig({ max_episodes: 2 });
    for (let i = 1; i <= 5; i++) {
      await recordEpisode(config, makeRecord({ issue_number: i, approach: `approach ${i}` }), tmp);
    }
    const results = await queryEpisodeContext(config, 'approach', { repo: 'org/repo' }, tmp);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by language when language_filter is true and language is provided', async () => {
    const config = makeEpisodeConfig({ language_filter: true });
    await recordEpisode(
      config,
      makeRecord({ issue_number: 1, language: 'typescript', approach: 'a typescript approach' }),
      tmp,
    );
    await recordEpisode(
      config,
      makeRecord({ issue_number: 2, language: 'rust', approach: 'a typescript approach' }),
      tmp,
    );

    const results = await queryEpisodeContext(
      config,
      'a typescript approach',
      { repo: 'org/repo', language: 'typescript' },
      tmp,
    );
    expect(results.length).toBe(1);
    expect(results[0]?.issue_number).toBe(1);
  });
});

describe('recordEpisode (sqlite-vec)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-episode-rest-record-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when disabled', async () => {
    const ok = await recordEpisode(makeEpisodeConfig({ enabled: false }), makeRecord(), tmp);
    expect(ok).toBe(false);
  });

  it('returns false when workDir is missing', async () => {
    const ok = await recordEpisode(makeEpisodeConfig(), makeRecord());
    expect(ok).toBe(false);
  });

  it('returns true and persists the record on success', async () => {
    const ok = await recordEpisode(makeEpisodeConfig(), makeRecord({ issue_number: 7 }), tmp);
    expect(ok).toBe(true);
    const results = await queryEpisodeContext(makeEpisodeConfig(), 'database connection', { repo: 'org/repo' }, tmp);
    expect(results.some((r) => r.issue_number === 7)).toBe(true);
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
