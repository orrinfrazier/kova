// EpisodeFTSStore — local SQLite FTS5 keyword index over episode records.
//
// Complements (not replaces) the vector-based episodic memory in vectordb.ts.
// Vector search is weak at exact-token recall — finding the past episode that
// hit a specific error string, stack frame, symbol, or path. FTS5 fills that
// gap with BM25-ranked keyword matches.
//
// The store is local + optional:
//   - DB lives at `.kova/episode-fts.db` in the repo root by default.
//   - Absent file → store opens an empty index, queries return [] without error.
//   - Disabled in config → never opened at all (caller skips).
//
// Schema: a single FTS5 virtual table `episodes_fts` over the keyword-rich
// fields (issue_title, approach, learnings, error_message, files_changed) with
// UNINDEXED metadata columns (issue_number, repo, outcome, timestamp). Dedup
// is by (repo, issue_number) — DELETE-then-INSERT inside a transaction, since
// FTS5 has no real primary key.
//
// Query safety: any user-supplied query (including raw error strings with FTS5
// special chars like `"`, `-`, `*`, `^`) is phrase-wrapped before being passed
// to MATCH. This is the simplest crash-safe sanitization: a phrase query never
// triggers FTS5's grammar even on malformed input.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle } from 'better-sqlite3';
import type { EpisodeContext } from '../types/memory.js';

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  issue_number UNINDEXED,
  repo UNINDEXED,
  outcome UNINDEXED,
  timestamp UNINDEXED,
  issue_title,
  approach,
  learnings,
  error_message,
  files_changed,
  tokenize = 'porter unicode61'
);
`;

/**
 * Subset of EpisodeRecord needed for FTS indexing. All keyword-rich fields are
 * required by the schema (empty string is fine — FTS5 happily indexes ''),
 * optional source fields collapse to '' at write time.
 */
export interface EpisodeFTSRecord {
  issue_number: number;
  repo: string;
  issue_title: string;
  approach: string;
  files_changed: string[];
  outcome: string;
  timestamp: string;
  learnings?: string | undefined;
  error_message?: string | undefined;
}

interface FTSRow {
  issue_number: number;
  repo: string;
  outcome: string;
  timestamp: string;
  issue_title: string;
  approach: string;
  learnings: string;
  error_message: string;
  files_changed: string;
}

export class EpisodeFTSStore {
  private readonly db: DbHandle;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /**
   * Insert or replace an episode in the FTS index. Idempotent: re-inserting
   * the same (repo, issue_number) replaces the prior row in a single
   * transaction. Empty/missing optional fields collapse to ''.
   */
  upsertEpisode(record: EpisodeFTSRecord): void {
    const tx = this.db.transaction((r: EpisodeFTSRecord) => {
      this.db.prepare('DELETE FROM episodes_fts WHERE repo = ? AND issue_number = ?').run(r.repo, r.issue_number);
      this.db
        .prepare(
          `INSERT INTO episodes_fts (
             issue_number, repo, outcome, timestamp,
             issue_title, approach, learnings, error_message, files_changed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.issue_number,
          r.repo,
          r.outcome,
          r.timestamp,
          r.issue_title,
          r.approach,
          r.learnings ?? '',
          r.error_message ?? '',
          r.files_changed.join(' '),
        );
    });
    tx(record);
  }

  /**
   * Run a full-text MATCH query and return the top-K rows ordered by bm25
   * relevance (lower is better in SQLite FTS5 BM25). Query is phrase-wrapped
   * for crash-safety on raw error strings.
   */
  searchEpisodesFTS(query: string, limit = 10): EpisodeFTSRecord[] {
    if (this.closed) return [];
    const safe = toPhraseQuery(query);
    if (!safe) return [];

    let rows: FTSRow[];
    try {
      rows = this.db
        .prepare<[string, number], FTSRow>(
          `SELECT issue_number, repo, outcome, timestamp,
                  issue_title, approach, learnings, error_message, files_changed
             FROM episodes_fts
             WHERE episodes_fts MATCH ?
             ORDER BY bm25(episodes_fts)
             LIMIT ?`,
        )
        .all(safe, limit);
    } catch {
      // Defense-in-depth: even with phrase-wrapping, FTS5 can occasionally
      // reject pathological input. Crash-safe by contract.
      return [];
    }
    return rows.map(rowToRecord);
  }
}

function rowToRecord(r: FTSRow): EpisodeFTSRecord {
  return {
    issue_number: r.issue_number,
    repo: r.repo,
    outcome: r.outcome,
    timestamp: r.timestamp,
    issue_title: r.issue_title,
    approach: r.approach,
    files_changed: r.files_changed.length > 0 ? r.files_changed.split(' ') : [],
    ...(r.learnings.length > 0 && { learnings: r.learnings }),
    ...(r.error_message.length > 0 && { error_message: r.error_message }),
  };
}

/**
 * Wrap an arbitrary query in an FTS5 phrase so the parser never sees special
 * characters as operators. Embedded `"` inside the phrase is doubled per FTS5
 * string-escape rules. Returns null for empty/whitespace-only input.
 */
function toPhraseQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/* ================================================================== */
/*  mergeEpisodeRecall — hybrid FTS5 + vector dedup                    */
/* ================================================================== */

/**
 * Subset of EpisodeFTSRecord and EpisodeContext that callers (spec/retry
 * waves) can format uniformly. Either source shape can flow through the
 * formatting pipeline downstream.
 */
export type MergedEpisode = (EpisodeFTSRecord & { source: 'fts' }) | (EpisodeContext & { source: 'vector' });

/**
 * Merge FTS5 keyword hits and vector neighbors into a deduplicated list. FTS5
 * results are placed first (exact matches are higher-signal for the
 * spec/retry recall use case described in #302); vector results are appended
 * if their (repo, issue_number) is not already present.
 *
 * The `repo` key on EpisodeContext is optional — when absent it defaults to
 * '' for dedup purposes, matching FTS records that also have '' (impossible
 * in practice since FTS records always carry a repo, but keeps the contract
 * total).
 */
export function mergeEpisodeRecall(ftsResults: EpisodeFTSRecord[], vectorResults: EpisodeContext[]): MergedEpisode[] {
  const seen = new Set<string>();
  const out: MergedEpisode[] = [];

  for (const fts of ftsResults) {
    const key = `${fts.repo}:${fts.issue_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...fts, source: 'fts' });
  }

  for (const vec of vectorResults) {
    const key = `${vec.repo ?? ''}:${vec.issue_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...vec, source: 'vector' });
  }

  return out;
}
