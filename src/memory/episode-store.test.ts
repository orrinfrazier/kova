// Tests for the sqlite-vec-backed EpisodeStore: upsert, query, repo
// filtering, language filtering, schema persistence, FTS migration.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodeRecord } from '../types/memory.js';
import { EpisodeFTSStore } from './episode-fts.js';
import { EpisodeStore } from './episode-store.js';

function makeEpisode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    issue_number: 1,
    issue_title: 'fix the thing',
    labels: ['bug'],
    repo: 'org/repo',
    approach: 'wrote a test, then implemented',
    files_changed: ['src/foo.ts'],
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

describe('EpisodeStore', () => {
  let tmp: string;
  let dbPath: string;
  let store: EpisodeStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-episode-store-'));
    dbPath = join(tmp, 'episodes-vec.db');
    store = new EpisodeStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  describe('upsertEpisode', () => {
    it('persists an episode and returns it on query', () => {
      store.upsertEpisode(
        makeEpisode({
          issue_number: 42,
          issue_title: 'database connection pool exhausted',
          approach: 'increased pool size and added timeout',
          repo: 'org/repo',
        }),
      );

      const results = store.queryEpisodes('database connection pool', { repo: 'org/repo', top_k: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.issue_number).toBe(42);
    });

    it('is idempotent — re-inserting the same issue replaces the row', () => {
      store.upsertEpisode(makeEpisode({ issue_number: 1, approach: 'first attempt' }));
      store.upsertEpisode(makeEpisode({ issue_number: 1, approach: 'second attempt' }));

      const results = store.queryEpisodes('attempt', { repo: 'org/repo', top_k: 10 });
      expect(results.length).toBe(1);
      expect(results[0]?.approach).toBe('second attempt');
    });

    it('persists across re-opens', () => {
      store.upsertEpisode(makeEpisode({ issue_number: 7, issue_title: 'persistence test' }));
      store.close();
      store = new EpisodeStore(dbPath);
      const results = store.queryEpisodes('persistence', { repo: 'org/repo', top_k: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.issue_number).toBe(7);
    });
  });

  describe('queryEpisodes', () => {
    it('returns empty array on empty DB', () => {
      const results = store.queryEpisodes('anything', { repo: 'x/y', top_k: 5 });
      expect(results).toEqual([]);
    });

    it('returns empty array on empty query string', () => {
      store.upsertEpisode(makeEpisode());
      expect(store.queryEpisodes('', { repo: 'org/repo', top_k: 5 })).toEqual([]);
      expect(store.queryEpisodes('   ', { repo: 'org/repo', top_k: 5 })).toEqual([]);
    });

    it('honors top_k limit', () => {
      for (let i = 1; i <= 5; i++) {
        store.upsertEpisode(makeEpisode({ issue_number: i, approach: `approach ${i}` }));
      }
      const results = store.queryEpisodes('approach', { repo: 'org/repo', top_k: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('filters by repo when cross_repo is false', () => {
      store.upsertEpisode(makeEpisode({ issue_number: 1, repo: 'org/a', approach: 'shared approach' }));
      store.upsertEpisode(makeEpisode({ issue_number: 2, repo: 'org/b', approach: 'shared approach' }));

      const sameRepo = store.queryEpisodes('shared', { repo: 'org/a', top_k: 5, cross_repo: false });
      expect(sameRepo.every((e) => e.repo === 'org/a')).toBe(true);
      expect(sameRepo.length).toBe(1);
    });

    it('returns cross-repo results when cross_repo is true', () => {
      store.upsertEpisode(makeEpisode({ issue_number: 1, repo: 'org/a', approach: 'cross repo approach' }));
      store.upsertEpisode(makeEpisode({ issue_number: 2, repo: 'org/b', approach: 'cross repo approach' }));

      const allRepos = store.queryEpisodes('cross repo', { repo: 'org/a', top_k: 5, cross_repo: true });
      expect(allRepos.length).toBe(2);
    });

    it('filters by language when language_filter is true', () => {
      store.upsertEpisode(makeEpisode({ issue_number: 1, language: 'typescript', approach: 'lang test' }));
      store.upsertEpisode(makeEpisode({ issue_number: 2, language: 'rust', approach: 'lang test' }));

      const tsOnly = store.queryEpisodes('lang test', {
        repo: 'org/repo',
        top_k: 5,
        cross_repo: true,
        language: 'typescript',
        language_filter: true,
      });
      expect(tsOnly.length).toBe(1);
      expect(tsOnly[0]?.issue_number).toBe(1);
    });

    it('does not throw when issued ill-formed query on populated DB', () => {
      store.upsertEpisode(makeEpisode());
      expect(() => store.queryEpisodes('!!!', { repo: 'org/repo', top_k: 5 })).not.toThrow();
    });
  });

  describe('schema migration', () => {
    it('migrates existing FTS episodes on first construction when present', () => {
      // Pre-populate a synthetic FTS sidecar in the same .kova dir
      const ftsPath = join(tmp, 'episode-fts.db');
      // Note: the migration helper looks for episode-fts.db alongside the vec db
      // and copies any rows into the new store. This test exercises that path.
      const fts = new EpisodeFTSStore(ftsPath);
      fts.upsertEpisode({
        issue_number: 99,
        repo: 'org/repo',
        outcome: 'pr_created',
        timestamp: new Date().toISOString(),
        issue_title: 'migrated from FTS',
        approach: 'a migrated approach',
        files_changed: ['src/migrated.ts'],
        learnings: 'a migrated learning',
      });
      fts.close();

      // Re-construct with migration enabled
      store.close();
      store = new EpisodeStore(dbPath, { ftsMigrationPath: ftsPath });

      const results = store.queryEpisodes('migrated', { repo: 'org/repo', top_k: 5 });
      expect(results.some((e) => e.issue_number === 99)).toBe(true);
    });

    it('migration is idempotent — running twice does not duplicate rows', () => {
      const ftsPath = join(tmp, 'episode-fts.db');
      const fts = new EpisodeFTSStore(ftsPath);
      fts.upsertEpisode({
        issue_number: 99,
        repo: 'org/repo',
        outcome: 'pr_created',
        timestamp: new Date().toISOString(),
        issue_title: 'migrated row',
        approach: 'approach',
        files_changed: [],
      });
      fts.close();

      store.close();
      store = new EpisodeStore(dbPath, { ftsMigrationPath: ftsPath });
      store.close();
      store = new EpisodeStore(dbPath, { ftsMigrationPath: ftsPath });

      const results = store.queryEpisodes('migrated', { repo: 'org/repo', top_k: 10 });
      expect(results.filter((e) => e.issue_number === 99).length).toBe(1);
    });
  });

  describe('graceful behavior', () => {
    it('queryEpisodes after close returns []', () => {
      store.upsertEpisode(makeEpisode());
      store.close();
      expect(store.queryEpisodes('anything', { repo: 'org/repo', top_k: 5 })).toEqual([]);
    });
  });
});
