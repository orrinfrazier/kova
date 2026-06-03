import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodeRecord } from '../types/memory.js';
import { formatPatterns, type PatternRecord, PatternStore, upsertPatternFromEpisode } from './pattern-store.js';

describe('PatternStore', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-pattern-store-'));
    dbPath = join(tmp, 'patterns.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates schema on first open (patterns table exists, empty query returns [])', () => {
    const store = new PatternStore(dbPath);
    expect(store.queryTopPatterns('orrinfrazier/kova')).toEqual([]);
    store.close();
  });

  it('upsertPattern increments frequency on re-insert of same (repo, diagnosis, module) key', () => {
    const store = new PatternStore(dbPath);
    store.upsertPattern({
      repo: 'orrinfrazier/kova',
      diagnosis: 'APPROACH_WRONG',
      module: 'src/services',
      outcome: 'failure',
    });
    store.upsertPattern({
      repo: 'orrinfrazier/kova',
      diagnosis: 'APPROACH_WRONG',
      module: 'src/services',
      outcome: 'failure',
    });
    store.upsertPattern({
      repo: 'orrinfrazier/kova',
      diagnosis: 'APPROACH_WRONG',
      module: 'src/services',
      outcome: 'success',
    });
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.frequency).toBe(3);
    expect(hits[0]?.diagnosis).toBe('APPROACH_WRONG');
    expect(hits[0]?.module).toBe('src/services');
    store.close();
  });

  it('upsertPattern tracks success_rate across mixed outcomes', () => {
    const store = new PatternStore(dbPath);
    for (let i = 0; i < 3; i++) {
      store.upsertPattern({
        repo: 'r',
        diagnosis: 'SPEC_WRONG',
        module: 'src/pipeline',
        outcome: 'success',
      });
    }
    store.upsertPattern({
      repo: 'r',
      diagnosis: 'SPEC_WRONG',
      module: 'src/pipeline',
      outcome: 'failure',
    });
    const hits = store.queryTopPatterns('r');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.frequency).toBe(4);
    // 3 of 4 succeeded → success_rate = 0.75
    expect(hits[0]?.success_rate).toBeCloseTo(0.75, 5);
    store.close();
  });

  it('queryTopPatterns orders by frequency descending', () => {
    const store = new PatternStore(dbPath);
    // 3 hits on services
    for (let i = 0; i < 3; i++) {
      store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/services', outcome: 'failure' });
    }
    // 5 hits on pipeline
    for (let i = 0; i < 5; i++) {
      store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/pipeline', outcome: 'failure' });
    }
    // 1 hit on utils
    store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/utils', outcome: 'failure' });

    const hits = store.queryTopPatterns('r');
    expect(hits.map((h) => h.module)).toEqual(['src/pipeline', 'src/services', 'src/utils']);
    expect(hits.map((h) => h.frequency)).toEqual([5, 3, 1]);
    store.close();
  });

  it('queryTopPatterns respects limit parameter', () => {
    const store = new PatternStore(dbPath);
    for (let i = 0; i < 4; i++) {
      store.upsertPattern({
        repo: 'r',
        diagnosis: 'STUCK',
        module: `src/m${i}`,
        outcome: 'failure',
      });
    }
    expect(store.queryTopPatterns('r', { limit: 2 })).toHaveLength(2);
    store.close();
  });

  it('queryTopPatterns filters by module prefix when provided', () => {
    const store = new PatternStore(dbPath);
    store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/services', outcome: 'failure' });
    store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/pipeline', outcome: 'failure' });
    store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'tests', outcome: 'failure' });

    const hits = store.queryTopPatterns('r', { modulePrefix: 'src/' });
    expect(hits.map((h) => h.module).sort()).toEqual(['src/pipeline', 'src/services']);
    store.close();
  });

  it('queryTopPatterns isolates by repo', () => {
    const store = new PatternStore(dbPath);
    store.upsertPattern({ repo: 'repo-a', diagnosis: 'STUCK', module: 'src/x', outcome: 'failure' });
    store.upsertPattern({ repo: 'repo-b', diagnosis: 'STUCK', module: 'src/y', outcome: 'failure' });
    expect(store.queryTopPatterns('repo-a').map((h) => h.module)).toEqual(['src/x']);
    expect(store.queryTopPatterns('repo-b').map((h) => h.module)).toEqual(['src/y']);
    store.close();
  });

  it('close is idempotent', () => {
    const store = new PatternStore(dbPath);
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it('different (diagnosis, module) pairs in the same repo are separate rows', () => {
    const store = new PatternStore(dbPath);
    store.upsertPattern({ repo: 'r', diagnosis: 'APPROACH_WRONG', module: 'src/services', outcome: 'failure' });
    store.upsertPattern({ repo: 'r', diagnosis: 'STUCK', module: 'src/services', outcome: 'failure' });
    const hits = store.queryTopPatterns('r');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.diagnosis).sort()).toEqual(['APPROACH_WRONG', 'STUCK']);
    store.close();
  });
});

describe('upsertPatternFromEpisode', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-pattern-store-'));
    dbPath = join(tmp, 'patterns.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseEpisode = (overrides: Partial<EpisodeRecord> = {}): EpisodeRecord => ({
    issue_number: 1,
    issue_title: 'fix something',
    labels: [],
    repo: 'orrinfrazier/kova',
    approach: 'change a file',
    files_changed: ['src/services/vectordb.ts'],
    quality_gates: null,
    review_findings: [],
    outcome: 'pr_created',
    failed_at_wave: null,
    total_cost: 0,
    total_duration: 0,
    total_turns: 0,
    timestamp: '2026-06-02T00:00:00.000Z',
    ...overrides,
  });

  it('extracts diagnosis + module prefix and upserts a row', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(store, baseEpisode({ diagnosis: 'APPROACH_WRONG', outcome: 'failed' }));
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.diagnosis).toBe('APPROACH_WRONG');
    expect(hits[0]?.module).toBe('src/services');
    expect(hits[0]?.frequency).toBe(1);
    store.close();
  });

  it('uses outcome=pr_created → success, failed → failure', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(store, baseEpisode({ diagnosis: 'APPROACH_WRONG', outcome: 'pr_created' }));
    upsertPatternFromEpisode(store, baseEpisode({ diagnosis: 'APPROACH_WRONG', outcome: 'failed' }));
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.frequency).toBe(2);
    expect(hits[0]?.success_rate).toBeCloseTo(0.5, 5);
    store.close();
  });

  it('falls back to "UNKNOWN" diagnosis when episode has no diagnosis field', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(store, baseEpisode());
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.diagnosis).toBe('UNKNOWN');
    store.close();
  });

  it('skips episodes with no files_changed (no module to attribute)', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(store, baseEpisode({ files_changed: [], diagnosis: 'STUCK' }));
    expect(store.queryTopPatterns('orrinfrazier/kova')).toEqual([]);
    store.close();
  });

  it('uses first two path segments as module prefix (src/services/foo.ts → src/services)', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(
      store,
      baseEpisode({
        files_changed: ['src/services/vectordb.ts'],
        diagnosis: 'STUCK',
      }),
    );
    upsertPatternFromEpisode(
      store,
      baseEpisode({
        issue_number: 2,
        files_changed: ['src/services/episode-fts.ts'],
        diagnosis: 'STUCK',
      }),
    );
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.module).toBe('src/services');
    expect(hits[0]?.frequency).toBe(2);
    store.close();
  });

  it('uses top-level segment when path has only one component', () => {
    const store = new PatternStore(dbPath);
    upsertPatternFromEpisode(store, baseEpisode({ files_changed: ['README.md'], diagnosis: 'STUCK' }));
    const hits = store.queryTopPatterns('orrinfrazier/kova');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.module).toBe('README.md');
    store.close();
  });
});

describe('formatPatterns', () => {
  it('returns empty string for empty list', () => {
    expect(formatPatterns([])).toBe('');
  });

  it('formats patterns into a markdown section', () => {
    const patterns: PatternRecord[] = [
      {
        repo: 'r',
        diagnosis: 'APPROACH_WRONG',
        module: 'src/services',
        frequency: 5,
        success_rate: 0.4,
        updated_at: '2026-06-02T00:00:00.000Z',
      },
      {
        repo: 'r',
        diagnosis: 'STUCK',
        module: 'src/pipeline',
        frequency: 2,
        success_rate: 0,
        updated_at: '2026-06-02T00:00:00.000Z',
      },
    ];
    const out = formatPatterns(patterns);
    expect(out).toContain('## Recurring failure patterns in this area');
    expect(out).toContain('APPROACH_WRONG');
    expect(out).toContain('src/services');
    expect(out).toContain('5');
    expect(out).toContain('STUCK');
    expect(out).toContain('src/pipeline');
  });
});
