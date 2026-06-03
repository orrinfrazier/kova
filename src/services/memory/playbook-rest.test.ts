import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybooksConfig } from '../../types/config.js';
import {
  clusterEpisodes,
  type EpisodeForCluster,
  formatPlaybook,
  type PlaybookRecord,
  queryPlaybook,
  recordPlaybook,
  type SynthesizeFn,
  synthesizePlaybook,
} from './playbook-rest.js';

let tmpRoot: string | null = null;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kova-playbook-rest-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function getTmp(): string {
  if (!tmpRoot) throw new Error('tmpRoot not initialised');
  return tmpRoot;
}

function makePlaybooksConfig(overrides?: Partial<PlaybooksConfig>): PlaybooksConfig {
  return {
    enabled: true,
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

describe('queryPlaybook (sqlite-vec)', () => {
  const pb: PlaybookRecord = {
    trigger: { labels: ['bug'], language: 'typescript', file_globs: ['src/auth.ts'] },
    steps: ['auth token refresh check before api call', 'guard middleware path'],
    gotchas: ['watch the ttl drift'],
    files_to_touch: ['src/auth.ts'],
    episode_refs: [1, 2, 3],
    synthesized_from_count: 3,
    created_at: '2026-06-01T00:00:00.000Z',
  };

  it('returns playbook after roundtrip', async () => {
    await recordPlaybook(makePlaybooksConfig(), pb, getTmp());
    const result = await queryPlaybook(
      makePlaybooksConfig(),
      'auth token refresh check before api call',
      { repo: 'my-repo', language: 'typescript' },
      getTmp(),
    );
    expect(result).not.toBeNull();
    expect(result?.steps[0]).toContain('auth token refresh');
  });

  it('returns null when disabled', async () => {
    const result = await queryPlaybook(makePlaybooksConfig({ enabled: false }), 'q', undefined, getTmp());
    expect(result).toBeNull();
  });

  it('returns null when workDir is missing', async () => {
    const result = await queryPlaybook(makePlaybooksConfig(), 'q');
    expect(result).toBeNull();
  });

  it('returns null when no rows exist', async () => {
    const result = await queryPlaybook(makePlaybooksConfig(), 'anything', undefined, getTmp());
    expect(result).toBeNull();
  });

  it('filters by language when language is provided and does not match', async () => {
    await recordPlaybook(makePlaybooksConfig(), pb, getTmp());
    const result = await queryPlaybook(
      makePlaybooksConfig(),
      'auth token refresh check before api call',
      { language: 'rust' },
      getTmp(),
    );
    expect(result).toBeNull();
  });
});

describe('recordPlaybook (sqlite-vec)', () => {
  const pb: PlaybookRecord = {
    trigger: { labels: ['bug'], language: 'typescript', file_globs: ['src/a.ts'] },
    steps: ['record then query'],
    gotchas: [],
    files_to_touch: ['src/a.ts'],
    episode_refs: [1, 2, 3],
    synthesized_from_count: 3,
    created_at: '2026-06-01T00:00:00.000Z',
  };

  it('returns false when disabled', async () => {
    const ok = await recordPlaybook(makePlaybooksConfig({ enabled: false }), pb, getTmp());
    expect(ok).toBe(false);
  });

  it('returns false when workDir is missing', async () => {
    const ok = await recordPlaybook(makePlaybooksConfig(), pb);
    expect(ok).toBe(false);
  });

  it('returns true on successful persist', async () => {
    const ok = await recordPlaybook(makePlaybooksConfig(), pb, getTmp());
    expect(ok).toBe(true);
  });
});
