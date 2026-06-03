// PlaybookStore — sqlite-vec-backed local store for distilled procedural
// playbooks (#433). Replaces the REST `queryPlaybook` / `recordPlaybook`
// paths with a fully local backend per ADR 002.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle, type Statement } from 'better-sqlite3';
import type { PlaybookRecord } from '../../types/memory.js';
import { EMBED_DIM, loadSqliteVec, localEmbed, serializeVec } from './sqlite-vec.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS playbooks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_labels TEXT NOT NULL,
  trigger_language TEXT,
  trigger_file_globs TEXT NOT NULL,
  steps TEXT NOT NULL,
  gotchas TEXT NOT NULL,
  files_to_touch TEXT NOT NULL,
  episode_refs TEXT NOT NULL,
  synthesized_from_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

interface PlaybookRow {
  rowid: number;
  trigger_labels: string;
  trigger_language: string | null;
  trigger_file_globs: string;
  steps: string;
  gotchas: string;
  files_to_touch: string;
  episode_refs: string;
  synthesized_from_count: number;
  created_at: string;
}

/**
 * Cosine-similarity floor — playbook hits whose adjusted score falls below
 * this threshold are treated as "no match" and `queryPlaybook` returns
 * null. Keeps the spec wave from injecting an irrelevant playbook.
 */
const MIN_SCORE = 0.3;

export class PlaybookStore {
  private readonly db: DbHandle;
  private closed = false;
  private readonly insertPlaybook: Statement<unknown[]>;
  private readonly insertVec: Statement<unknown[]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    loadSqliteVec(this.db);
    this.db.exec(SCHEMA);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS playbooks_vec USING vec0(embedding float[${EMBED_DIM}])`);

    this.insertPlaybook = this.db.prepare(`
      INSERT INTO playbooks (trigger_labels, trigger_language, trigger_file_globs, steps, gotchas,
                             files_to_touch, episode_refs, synthesized_from_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertVec = this.db.prepare('INSERT INTO playbooks_vec (rowid, embedding) VALUES (?, ?)');
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /**
   * Persist a playbook. Embedding is computed from
   * `labels + language + steps + gotchas + files_to_touch` so retrieval
   * keys on the procedural text. Append-only — synthesis re-runs simply
   * add a new row, the highest-similarity one wins on query.
   */
  recordPlaybook(record: PlaybookRecord): void {
    if (this.closed) return;
    const embedText = [
      record.trigger.labels.join(' '),
      record.trigger.language ?? '',
      record.steps.join(' '),
      record.gotchas.join(' '),
      record.files_to_touch.join(' '),
    ]
      .filter((s) => s.length > 0)
      .join(' ');
    const vec = serializeVec(localEmbed(embedText));

    const tx = this.db.transaction(() => {
      const info = this.insertPlaybook.run(
        JSON.stringify(record.trigger.labels),
        record.trigger.language ?? null,
        JSON.stringify(record.trigger.file_globs),
        JSON.stringify(record.steps),
        JSON.stringify(record.gotchas),
        JSON.stringify(record.files_to_touch),
        JSON.stringify(record.episode_refs),
        record.synthesized_from_count,
        record.created_at,
      );
      this.insertVec.run(BigInt(info.lastInsertRowid as number), vec);
    });
    tx();
  }

  /**
   * Return the single best-matching playbook for `query`, subject to the
   * MIN_SCORE floor. Empty query, closed store, no rows, or all below the
   * floor → null. The optional `language` filter (if provided) restricts
   * results to playbooks with a matching trigger language; `repo` is
   * accepted for parity with the REST shape but not used today (playbooks
   * are cross-repo by design).
   */
  queryPlaybook(query: string, _repo?: string, language?: string): PlaybookRecord | null {
    if (this.closed) return null;
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;

    const vec = serializeVec(localEmbed(trimmed));
    let rows: Array<PlaybookRow & { distance: number }>;
    try {
      rows = this.db
        .prepare<[Buffer], PlaybookRow & { distance: number }>(`
          SELECT p.rowid, p.trigger_labels, p.trigger_language, p.trigger_file_globs,
                 p.steps, p.gotchas, p.files_to_touch, p.episode_refs,
                 p.synthesized_from_count, p.created_at, v.distance
            FROM playbooks_vec v
            JOIN playbooks p ON p.rowid = v.rowid
           WHERE v.embedding MATCH ? AND v.k = 5
        ORDER BY v.distance
        `)
        .all(vec);
    } catch {
      return null;
    }

    let candidates = rows;
    if (language) {
      candidates = candidates.filter((r) => r.trigger_language === language);
    }
    const best = candidates[0];
    if (!best) return null;

    const score = Math.max(0, (2 - best.distance) / 2);
    if (score < MIN_SCORE) return null;

    return rowToRecord(best);
  }
}

function rowToRecord(r: PlaybookRow): PlaybookRecord {
  return {
    trigger: {
      labels: safeParseStringArray(r.trigger_labels),
      language: r.trigger_language ?? undefined,
      file_globs: safeParseStringArray(r.trigger_file_globs),
    },
    steps: safeParseStringArray(r.steps),
    gotchas: safeParseStringArray(r.gotchas),
    files_to_touch: safeParseStringArray(r.files_to_touch),
    episode_refs: safeParseNumberArray(r.episode_refs),
    synthesized_from_count: r.synthesized_from_count,
    created_at: r.created_at,
  };
}

function safeParseStringArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeParseNumberArray(s: string): number[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}
