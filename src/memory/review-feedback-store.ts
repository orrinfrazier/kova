// ReviewFeedbackStore — sqlite-vec-backed local store for past PR review
// comments (#433). Replaces the REST `recordReviewFeedback` /
// `queryReviewFeedbackContext` paths with a fully local backend per ADR 002.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle, type Statement } from 'better-sqlite3';
import type { ReviewFeedbackItem, ReviewFeedbackRecord } from '../types/memory.js';
import { EMBED_DIM, loadSqliteVec, localEmbed, serializeVec } from './sqlite-vec.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  feedback_type TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  file_path TEXT,
  author TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_repo_idx ON feedback(repo);
`;

interface FeedbackRow {
  rowid: number;
  repo: string;
  pr_number: number;
  feedback_type: string;
  comment_text: string;
  file_path: string | null;
}

export class ReviewFeedbackStore {
  private readonly db: DbHandle;
  private closed = false;
  private readonly insertFeedback: Statement<unknown[]>;
  private readonly insertVec: Statement<unknown[]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    loadSqliteVec(this.db);
    this.db.exec(SCHEMA);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS feedback_vec USING vec0(embedding float[${EMBED_DIM}])`);

    this.insertFeedback = this.db.prepare(`
      INSERT INTO feedback (repo, pr_number, feedback_type, comment_text, file_path, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertVec = this.db.prepare('INSERT INTO feedback_vec (rowid, embedding) VALUES (?, ?)');
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /**
   * Append a batch of review-comment records to the store. Each record's
   * `comment_text` is embedded and stored alongside the row data. Records
   * are append-only — no dedup; the caller is responsible for not
   * re-collecting the same PR twice.
   */
  recordFeedback(records: ReviewFeedbackRecord[]): void {
    if (this.closed || records.length === 0) return;
    const now = new Date().toISOString();
    const tx = this.db.transaction((rs: ReviewFeedbackRecord[]) => {
      for (const r of rs) {
        const info = this.insertFeedback.run(
          r.repo,
          r.pr_number,
          r.feedback_type,
          r.comment_text,
          r.file_path ?? null,
          r.author ?? null,
          now,
        );
        const vec = serializeVec(localEmbed(r.comment_text));
        this.insertVec.run(BigInt(info.lastInsertRowid as number), vec);
      }
    });
    tx(records);
  }

  /**
   * Return top-`top_k` feedback items most similar to `query`. When `repo`
   * is provided, restrict results to that repo. Empty / closed / unmatched
   * inputs return [] without throwing.
   */
  queryFeedback(query: string, top_k: number, repo?: string): ReviewFeedbackItem[] {
    if (this.closed) return [];
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const k = Math.max(1, top_k);
    const overFetch = Math.max(k * 4, 20);
    const vec = serializeVec(localEmbed(trimmed));

    let rows: Array<FeedbackRow & { distance: number }>;
    try {
      rows = this.db
        .prepare<[Buffer, number], FeedbackRow & { distance: number }>(`
          SELECT f.rowid, f.repo, f.pr_number, f.feedback_type, f.comment_text, f.file_path, v.distance
            FROM feedback_vec v
            JOIN feedback f ON f.rowid = v.rowid
           WHERE v.embedding MATCH ? AND v.k = ?
        ORDER BY v.distance
        `)
        .all(vec, overFetch);
    } catch {
      return [];
    }

    const filtered = repo ? rows.filter((r) => r.repo === repo) : rows;
    return filtered.slice(0, k).map((r) => ({
      feedback_type: r.feedback_type,
      pr_number: r.pr_number,
      comment_text: r.comment_text,
      ...(r.file_path != null && { file_path: r.file_path }),
    }));
  }
}
