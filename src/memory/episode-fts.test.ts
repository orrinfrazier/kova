import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodeContext } from '../types/memory.js';
import { type EpisodeFTSRecord, EpisodeFTSStore, mergeEpisodeRecall } from './episode-fts.js';

describe('EpisodeFTSStore', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-episode-fts-'));
    dbPath = join(tmp, 'episode-fts.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const record = (overrides: Partial<EpisodeFTSRecord> = {}): EpisodeFTSRecord => ({
    issue_number: 42,
    repo: 'orrinfrazier/kova',
    issue_title: 'pgvector connection drops on idle',
    approach: 'Added retry wrapper with exponential backoff in createVectorDBClient',
    learnings: 'Pool.connect throws ECONNRESET after 60s idle',
    error_message: 'Error: connect ECONNRESET 127.0.0.1:5433',
    files_changed: ['src/services/vectordb.ts', 'src/services/vectordb.test.ts'],
    outcome: 'pr_created',
    timestamp: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });

  it('creates schema on first open (FTS5 virtual table exists)', () => {
    const store = new EpisodeFTSStore(dbPath);
    // Search on empty index returns empty without throwing.
    expect(store.searchEpisodesFTS('anything')).toEqual([]);
    store.close();
  });

  it('upsertEpisode + searchEpisodesFTS returns exact error-string matches', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record());
    const hits = store.searchEpisodesFTS('ECONNRESET');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.issue_number).toBe(42);
    expect(hits[0]?.error_message).toContain('ECONNRESET');
    store.close();
  });

  it('searchEpisodesFTS matches symbol names exactly', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record({ issue_number: 1, approach: 'Refactored queryCodeEmbeddings signature' }));
    store.upsertEpisode(record({ issue_number: 2, approach: 'Touched unrelated logger code' }));
    const hits = store.searchEpisodesFTS('queryCodeEmbeddings');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.issue_number).toBe(1);
    store.close();
  });

  it('searchEpisodesFTS matches file paths', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record({ issue_number: 5, files_changed: ['src/services/vectordb.ts'] }));
    store.upsertEpisode(record({ issue_number: 6, files_changed: ['src/utils/logger.ts'] }));
    const hits = store.searchEpisodesFTS('vectordb');
    expect(hits.map((h) => h.issue_number)).toContain(5);
    expect(hits.map((h) => h.issue_number)).not.toContain(6);
    store.close();
  });

  it('upsertEpisode is idempotent — same issue inserted twice yields one row', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record());
    store.upsertEpisode(record({ approach: 'Updated approach text' }));
    const hits = store.searchEpisodesFTS('ECONNRESET');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.approach).toBe('Updated approach text');
    store.close();
  });

  it('searchEpisodesFTS returns empty array for unknown query without throwing', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record());
    expect(store.searchEpisodesFTS('totally-unrelated-12345')).toEqual([]);
    store.close();
  });

  it('searchEpisodesFTS is crash-safe with FTS5 special characters', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record());
    // Raw error strings can contain quote/dash/star/caret — must not throw.
    expect(() => store.searchEpisodesFTS('Error: "connect" - ECONNRESET *127*')).not.toThrow();
    expect(() => store.searchEpisodesFTS('^malformed query"')).not.toThrow();
    expect(() => store.searchEpisodesFTS('AND OR NOT NEAR')).not.toThrow();
    store.close();
  });

  it('searchEpisodesFTS respects limit', () => {
    const store = new EpisodeFTSStore(dbPath);
    for (let i = 1; i <= 5; i++) {
      store.upsertEpisode(record({ issue_number: i, error_message: 'ECONNRESET shared token' }));
    }
    expect(store.searchEpisodesFTS('ECONNRESET', 3)).toHaveLength(3);
    store.close();
  });

  it('close is idempotent', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it('different repos are isolated by (repo, issue_number) compound key', () => {
    const store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode(record({ issue_number: 1, repo: 'org-a/repo' }));
    store.upsertEpisode(record({ issue_number: 1, repo: 'org-b/repo' }));
    const hits = store.searchEpisodesFTS('ECONNRESET');
    expect(hits).toHaveLength(2);
    store.close();
  });

  it('handles missing optional fields gracefully (no error_message, no learnings)', () => {
    const store = new EpisodeFTSStore(dbPath);
    expect(() =>
      store.upsertEpisode({
        issue_number: 99,
        repo: 'r',
        issue_title: 'title',
        approach: 'approach',
        files_changed: [],
        outcome: 'failed',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(store.searchEpisodesFTS('title')).toHaveLength(1);
    store.close();
  });
});

describe('mergeEpisodeRecall', () => {
  const fts = (issue_number: number, repo = 'r'): EpisodeFTSRecord => ({
    issue_number,
    repo,
    issue_title: `fts ${issue_number}`,
    approach: 'fts approach',
    files_changed: [],
    outcome: 'pr_created',
    timestamp: '2026-01-01T00:00:00.000Z',
  });

  const vec = (issue_number: number, repo = 'r'): EpisodeContext => ({
    issue_number,
    issue_title: `vec ${issue_number}`,
    approach: 'vec approach',
    outcome: 'success',
    learnings: 'vec learning',
    score: 0.9,
    repo,
  });

  it('returns empty array when both inputs empty', () => {
    expect(mergeEpisodeRecall([], [])).toEqual([]);
  });

  it('returns vector results when fts is empty', () => {
    const merged = mergeEpisodeRecall([], [vec(1), vec(2)]);
    expect(merged.map((m) => m.issue_number)).toEqual([1, 2]);
  });

  it('returns fts results when vector is empty', () => {
    const merged = mergeEpisodeRecall([fts(1), fts(2)], []);
    expect(merged.map((m) => m.issue_number)).toEqual([1, 2]);
  });

  it('puts FTS results first, then non-duplicate vector results', () => {
    const merged = mergeEpisodeRecall([fts(1), fts(2)], [vec(3), vec(4)]);
    expect(merged.map((m) => m.issue_number)).toEqual([1, 2, 3, 4]);
  });

  it('deduplicates by (repo, issue_number) — FTS wins', () => {
    const merged = mergeEpisodeRecall([fts(1)], [vec(1), vec(2)]);
    expect(merged.map((m) => m.issue_number)).toEqual([1, 2]);
    // Position 0 came from FTS (issue_title contains 'fts').
    expect(merged[0]?.issue_title).toBe('fts 1');
  });

  it('treats same issue_number in different repos as distinct', () => {
    const merged = mergeEpisodeRecall([fts(1, 'org-a/repo')], [vec(1, 'org-b/repo')]);
    expect(merged).toHaveLength(2);
  });
});
