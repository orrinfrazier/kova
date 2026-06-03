// EpisodeStore — sqlite-vec-backed local episode store (#433).
//
// Replaces the REST `queryEpisodeContext` / `recordEpisode` codepaths with a
// single local SQLite DB carrying both the row data and an L2-normalized
// embedding (via the local SimHash projection — see sqlite-vec.ts). Per
// ADR 002, this is the only vector backend; the in-memory JS fallback is
// rejected.
//
// Schema:
//   episodes(rowid, repo, issue_number, issue_title, approach, learnings,
//            outcome, files_changed, language, timestamp)
//   episodes_vec(rowid, embedding float[EMBED_DIM])  -- vec0 virtual table
//
// Dedup key: (repo, issue_number) — re-insertion DELETEs + INSERTs in a
// single transaction (vec0 has no UPSERT support).

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle, type Statement } from 'better-sqlite3';
import type { EpisodeContext, EpisodeRecord } from '../types/memory.js';
import { EpisodeFTSStore } from './episode-fts.js';
import { EMBED_DIM, loadSqliteVec, localEmbed, serializeVec } from './sqlite-vec.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL,
  approach TEXT NOT NULL,
  learnings TEXT,
  outcome TEXT NOT NULL,
  files_changed TEXT NOT NULL,
  language TEXT,
  timestamp TEXT NOT NULL,
  UNIQUE (repo, issue_number)
);
CREATE INDEX IF NOT EXISTS episodes_repo_idx ON episodes(repo);
`;

interface EpisodeRow {
  rowid: number;
  repo: string;
  issue_number: number;
  issue_title: string;
  approach: string;
  learnings: string | null;
  outcome: string;
  files_changed: string;
  language: string | null;
  timestamp: string;
}

export interface EpisodeStoreOptions {
  /**
   * Optional path to a legacy `episode-fts.db` (the FTS5 sidecar). When
   * present on first construction, episodes are copied into the new
   * sqlite-vec store. Idempotent — re-running migration skips
   * already-present (repo, issue_number) pairs via the UNIQUE constraint.
   */
  ftsMigrationPath?: string | undefined;
}

export interface QueryEpisodesOptions {
  /** Caller's repo — used for same-repo filtering and weighting. */
  repo: string;
  /** Max episodes to return. */
  top_k: number;
  /** When false, restrict results to `repo`. Defaults to true. */
  cross_repo?: boolean;
  /** Caller's language — required when `language_filter` is true. */
  language?: string | undefined;
  /** When true, drop episodes whose `language` does not match. Default false. */
  language_filter?: boolean;
  /** Cosine-similarity multiplier applied to same-repo results. Defaults to 1.5. */
  same_repo_weight?: number;
}

export class EpisodeStore {
  private readonly db: DbHandle;
  private closed = false;
  private readonly insertEpisode: Statement<unknown[]>;
  private readonly deleteEpisode: Statement<[string, number]>;
  private readonly insertVec: Statement<unknown[]>;
  private readonly deleteVec: Statement<[bigint]>;

  constructor(dbPath: string, options: EpisodeStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    loadSqliteVec(this.db);
    this.db.exec(SCHEMA);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(embedding float[${EMBED_DIM}])`);

    this.insertEpisode = this.db.prepare(`
      INSERT INTO episodes (repo, issue_number, issue_title, approach, learnings, outcome, files_changed, language, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteEpisode = this.db.prepare('DELETE FROM episodes WHERE repo = ? AND issue_number = ?');
    this.insertVec = this.db.prepare('INSERT INTO episodes_vec (rowid, embedding) VALUES (?, ?)');
    this.deleteVec = this.db.prepare('DELETE FROM episodes_vec WHERE rowid = ?');

    if (options.ftsMigrationPath && existsSync(options.ftsMigrationPath)) {
      this.migrateFromFTS(options.ftsMigrationPath);
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /**
   * Insert or replace the episode for (repo, issue_number). Embedding is
   * computed from `approach + issue_title + learnings + files_changed`.
   */
  upsertEpisode(record: EpisodeRecord): void {
    if (this.closed) return;
    const filesJoined = record.files_changed.join(' ');
    const embedText = [record.issue_title, record.approach, record.learnings ?? '', filesJoined]
      .filter((s) => s.length > 0)
      .join(' ');
    const vec = serializeVec(localEmbed(embedText));

    const tx = this.db.transaction(() => {
      // DELETE prior row + its vec entry (if any), then INSERT fresh.
      const prior = this.db
        .prepare<[string, number], { rowid: number }>('SELECT rowid FROM episodes WHERE repo = ? AND issue_number = ?')
        .get(record.repo, record.issue_number);
      if (prior) {
        this.deleteVec.run(BigInt(prior.rowid));
        this.deleteEpisode.run(record.repo, record.issue_number);
      }
      const info = this.insertEpisode.run(
        record.repo,
        record.issue_number,
        record.issue_title,
        record.approach,
        record.learnings ?? null,
        record.outcome,
        filesJoined,
        record.language ?? null,
        record.timestamp,
      );
      this.insertVec.run(BigInt(info.lastInsertRowid as number), vec);
    });
    tx();
  }

  /**
   * Return episodes most similar to `query`, ranked by cosine similarity
   * (lower vec0 distance is more similar). Empty query / closed store /
   * empty table all return [] without throwing.
   */
  queryEpisodes(query: string, options: QueryEpisodesOptions): EpisodeContext[] {
    if (this.closed) return [];
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const crossRepo = options.cross_repo ?? true;
    const sameRepoWeight = options.same_repo_weight ?? 1.5;
    const k = Math.max(1, options.top_k);
    const overFetch = Math.max(k * 4, 20); // over-fetch to leave room for filters

    const vec = serializeVec(localEmbed(trimmed));
    let rows: Array<EpisodeRow & { distance: number }>;
    try {
      rows = this.db
        .prepare<[Buffer, number], EpisodeRow & { distance: number }>(`
          SELECT e.rowid, e.repo, e.issue_number, e.issue_title, e.approach, e.learnings,
                 e.outcome, e.files_changed, e.language, e.timestamp, v.distance
            FROM episodes_vec v
            JOIN episodes e ON e.rowid = v.rowid
           WHERE v.embedding MATCH ? AND v.k = ?
        ORDER BY v.distance
        `)
        .all(vec, overFetch);
    } catch {
      return [];
    }

    // Repo filter: when cross_repo is false, drop other repos.
    let filtered = crossRepo ? rows : rows.filter((r) => r.repo === options.repo);

    // Language filter: when language_filter is true and caller supplied a
    // language, drop rows whose language differs.
    if (options.language_filter && options.language) {
      filtered = filtered.filter((r) => r.language === options.language);
    }

    // Apply same-repo weighting: same-repo rows boost their score by
    // dividing distance by sameRepoWeight (closer = better).
    const scored = filtered.map((r) => {
      const adjustedDistance = r.repo === options.repo ? r.distance / sameRepoWeight : r.distance;
      return { row: r, adjustedDistance };
    });
    scored.sort((a, b) => a.adjustedDistance - b.adjustedDistance);

    return scored.slice(0, k).map(({ row, adjustedDistance }) => rowToContext(row, adjustedDistance));
  }

  /* ----------------------------------------------------------------- */
  /*  Migration                                                         */
  /* ----------------------------------------------------------------- */

  private migrateFromFTS(ftsPath: string): void {
    let fts: EpisodeFTSStore | null = null;
    try {
      fts = new EpisodeFTSStore(ftsPath);
      // Pull every row by issuing a wildcard query. FTS5 has no native
      // "select *"; the simplest portable path is to query for the empty
      // phrase, which `searchEpisodesFTS` rejects — so go direct via the
      // underlying DB.
      const ftsDb = new Database(ftsPath, { readonly: true });
      try {
        const rows = ftsDb
          .prepare<
            [],
            {
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
          >(
            `SELECT issue_number, repo, outcome, timestamp,
                    issue_title, approach, learnings, error_message, files_changed
               FROM episodes_fts`,
          )
          .all();

        for (const r of rows) {
          // Skip rows already present (idempotent migration).
          const exists = this.db
            .prepare<[string, number], { rowid: number }>(
              'SELECT rowid FROM episodes WHERE repo = ? AND issue_number = ?',
            )
            .get(r.repo, r.issue_number);
          if (exists) continue;

          const filesArr = r.files_changed.length > 0 ? r.files_changed.split(' ') : [];
          this.upsertEpisode({
            issue_number: r.issue_number,
            issue_title: r.issue_title,
            labels: [],
            repo: r.repo,
            approach: r.approach,
            files_changed: filesArr,
            quality_gates: null,
            review_findings: [],
            outcome: outcomeForRoundtrip(r.outcome),
            failed_at_wave: null,
            total_cost: 0,
            total_duration: 0,
            total_turns: 0,
            timestamp: r.timestamp,
            ...(r.learnings.length > 0 && { learnings: r.learnings }),
            ...(r.error_message.length > 0 && { error_message: r.error_message }),
          });
        }
      } finally {
        ftsDb.close();
      }
    } catch {
      // Migration is best-effort — a failure should not break store init.
    } finally {
      fts?.close();
    }
  }
}

/**
 * Map an episode-row outcome string into the `EpisodeContext.outcome`
 * union. The FTS sidecar stores raw EpisodeRecord outcomes; we map to the
 * narrower 3-value union the formatter expects.
 */
function outcomeForContext(raw: string): EpisodeContext['outcome'] {
  switch (raw) {
    case 'pr_created':
      return 'success';
    case 'failed':
      return 'failure';
    case 'skipped':
      return 'partial';
    case 'success':
    case 'partial':
    case 'failure':
      return raw;
    default:
      return 'partial';
  }
}

/**
 * Map a stored row outcome back into the EpisodeRecord union when
 * round-tripping during migration. EpisodeRecord requires
 * 'pr_created' | 'failed' | 'skipped' — collapse the EpisodeContext
 * variants the same way.
 */
function outcomeForRoundtrip(raw: string): EpisodeRecord['outcome'] {
  switch (raw) {
    case 'pr_created':
    case 'failed':
    case 'skipped':
      return raw;
    case 'success':
      return 'pr_created';
    case 'failure':
      return 'failed';
    case 'partial':
      return 'skipped';
    default:
      return 'failed';
  }
}

function rowToContext(row: EpisodeRow, distance: number): EpisodeContext {
  // Convert cosine distance to a score in [0, 1+] where higher is better.
  // vec0 returns L2-style distance for normalized vectors → distance is in
  // [0, 2] for unit vectors. Score = (2 - distance) / 2 maps that to [0, 1].
  const score = Math.max(0, (2 - distance) / 2);
  return {
    issue_number: row.issue_number,
    issue_title: row.issue_title,
    approach: row.approach,
    outcome: outcomeForContext(row.outcome),
    learnings: row.learnings ?? '',
    score,
    repo: row.repo,
  };
}
