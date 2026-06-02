// PatternStore — local SQLite aggregation table over recurring (diagnosis × module)
// failure patterns observed across episodes.
//
// Wires #267 — the pgvector `patterns` table defined in vectordb.ts (upsertPattern /
// queryPatterns) has zero callers because no production code provides a real pg.Pool.
// Like the FTS5 episode sidecar (#302), this store sidesteps the missing pg
// infrastructure with a local SQLite table that the fix pipeline can write to on every
// completed episode and query from before the assess wave.
//
// Schema: a single regular table `patterns(repo, diagnosis, module, frequency,
// success_count, total_count, updated_at)` keyed on the (repo, diagnosis, module)
// triple. Upsert increments `frequency` and `total_count`; `success_count` ticks up
// when the episode succeeded. `success_rate` is derived as success_count / total_count
// at read time.
//
// The store is local + optional, mirroring EpisodeFTSStore:
//   - DB lives at `.kova/patterns.db` in the workDir by default.
//   - Absent file → store opens an empty table, queries return [] without error.
//   - Disabled in config → never opened at all (caller skips).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle } from 'better-sqlite3';
import type { EpisodeRecord } from './vectordb.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patterns (
  repo TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  module TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, diagnosis, module)
);
CREATE INDEX IF NOT EXISTS patterns_repo_idx ON patterns(repo);
CREATE INDEX IF NOT EXISTS patterns_repo_module_idx ON patterns(repo, module);
`;

/** One row of the patterns table, post-derivation of success_rate. */
export interface PatternRecord {
  repo: string;
  diagnosis: string;
  module: string;
  frequency: number;
  success_rate: number;
  updated_at: string;
}

/** Input for upsertPattern — one observation of (diagnosis, module) with an outcome. */
export interface PatternObservation {
  repo: string;
  diagnosis: string;
  module: string;
  outcome: 'success' | 'failure';
}

/** Query options for queryTopPatterns. */
export interface QueryPatternOptions {
  /** Limit on number of rows returned. Default 5. */
  limit?: number;
  /** Filter to patterns whose `module` column starts with this prefix. */
  modulePrefix?: string;
}

interface PatternRow {
  repo: string;
  diagnosis: string;
  module: string;
  frequency: number;
  success_count: number;
  total_count: number;
  updated_at: string;
}

export class PatternStore {
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
   * Insert or increment the row for (repo, diagnosis, module). Each call adds one
   * to `frequency` and `total_count`; `success_count` ticks up only when
   * `outcome === 'success'`. The row's `updated_at` is refreshed.
   */
  upsertPattern(observation: PatternObservation): void {
    const now = new Date().toISOString();
    const successDelta = observation.outcome === 'success' ? 1 : 0;
    const sql = `
      INSERT INTO patterns (repo, diagnosis, module, frequency, success_count, total_count, updated_at)
      VALUES (?, ?, ?, 1, ?, 1, ?)
      ON CONFLICT (repo, diagnosis, module)
      DO UPDATE SET
        frequency = frequency + 1,
        success_count = success_count + ?,
        total_count = total_count + 1,
        updated_at = excluded.updated_at
    `;
    this.db
      .prepare(sql)
      .run(observation.repo, observation.diagnosis, observation.module, successDelta, now, successDelta);
  }

  /**
   * Return the top patterns for a repo, ordered by frequency descending. When
   * `modulePrefix` is provided, only rows whose `module` starts with that prefix
   * are returned (useful for "patterns in src/" scoping). Default limit 5.
   */
  queryTopPatterns(repo: string, options: QueryPatternOptions = {}): PatternRecord[] {
    if (this.closed) return [];
    const limit = options.limit ?? 5;

    let rows: PatternRow[];
    try {
      if (options.modulePrefix != null) {
        rows = this.db
          .prepare<[string, string, number], PatternRow>(
            `SELECT repo, diagnosis, module, frequency, success_count, total_count, updated_at
               FROM patterns
              WHERE repo = ? AND module LIKE ? || '%'
              ORDER BY frequency DESC, updated_at DESC
              LIMIT ?`,
          )
          .all(repo, options.modulePrefix, limit);
      } else {
        rows = this.db
          .prepare<[string, number], PatternRow>(
            `SELECT repo, diagnosis, module, frequency, success_count, total_count, updated_at
               FROM patterns
              WHERE repo = ?
              ORDER BY frequency DESC, updated_at DESC
              LIMIT ?`,
          )
          .all(repo, limit);
      }
    } catch {
      return [];
    }

    return rows.map(rowToRecord);
  }
}

function rowToRecord(r: PatternRow): PatternRecord {
  const successRate = r.total_count > 0 ? r.success_count / r.total_count : 0;
  return {
    repo: r.repo,
    diagnosis: r.diagnosis,
    module: r.module,
    frequency: r.frequency,
    success_rate: successRate,
    updated_at: r.updated_at,
  };
}

/* ================================================================== */
/*  Episode → Pattern aggregation                                      */
/* ================================================================== */

/**
 * Map an episode outcome to the simpler success/failure axis used by the
 * pattern aggregation. `pr_created` is the only success outcome; everything
 * else is treated as failure.
 */
function episodeOutcomeToPatternOutcome(outcome: EpisodeRecord['outcome']): 'success' | 'failure' {
  return outcome === 'pr_created' ? 'success' : 'failure';
}

/**
 * Derive the module prefix for a file path: the first two segments when present
 * (e.g. `src/services/foo.ts` → `src/services`), otherwise the top-level
 * segment (`README.md` → `README.md`). Empty input returns ''.
 */
export function deriveModulePrefix(filePath: string): string {
  const parts = filePath.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Aggregate a completed `EpisodeRecord` into the pattern store. Builds a set of
 * (diagnosis × module) keys from the episode's `files_changed`, derives each
 * file's module prefix, and upserts one row per unique key. Episodes without a
 * diagnosis fall back to `UNKNOWN`. Episodes with no files_changed are skipped
 * (no module to attribute the pattern to).
 *
 * Idempotency: this is not de-duplicated across re-runs of the same episode —
 * callers are expected to call this once per episode-completion.
 */
export function upsertPatternFromEpisode(store: PatternStore, episode: EpisodeRecord): void {
  if (episode.files_changed.length === 0) return;
  const diagnosis = episode.diagnosis ?? 'UNKNOWN';
  const outcome = episodeOutcomeToPatternOutcome(episode.outcome);
  const seenModules = new Set<string>();
  for (const file of episode.files_changed) {
    const module = deriveModulePrefix(file);
    if (module.length === 0 || seenModules.has(module)) continue;
    seenModules.add(module);
    store.upsertPattern({
      repo: episode.repo,
      diagnosis,
      module,
      outcome,
    });
  }
}

/* ================================================================== */
/*  Formatter for wave context injection                               */
/* ================================================================== */

/**
 * Format a list of patterns into a markdown section suitable for injection
 * into an early wave prompt. Returns an empty string when the list is empty
 * so callers can append unconditionally.
 */
export function formatPatterns(patterns: PatternRecord[]): string {
  if (patterns.length === 0) return '';
  const rows = patterns.map((p) => {
    const pct = (p.success_rate * 100).toFixed(0);
    return `- **${p.diagnosis}** in \`${p.module}\` — seen ${p.frequency}× (success rate ${pct}%)`;
  });
  return [
    '## Recurring failure patterns in this area',
    '',
    'These (diagnosis × module) patterns have repeated across past fixes in this repo. Consider whether the current issue is another instance and watch for the failure modes that surfaced before.',
    '',
    ...rows,
  ].join('\n');
}
