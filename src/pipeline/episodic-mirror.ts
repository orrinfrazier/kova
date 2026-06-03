// Episodic memory mirror — local write-side projection helpers (issue #435).
//
// Extracted from fix.ts to keep the orchestrator focused on flow control.
// The search-side counterparts already live in `./context/episodic-provider.ts`
// and `./context/pattern-provider.ts`; this module owns the post-fix mirror
// path that writes episodes into the local FTS5 index (#302) and aggregates
// them into the pattern store (#267).
//
// Pure side-effect helpers. Best-effort: open/write failures are logged and
// swallowed so they never break the REST-based `recordEpisode` path.

import { join as joinPath } from 'node:path';
import { EpisodeFTSStore } from '../services/episode-fts.js';
import { PatternStore, upsertPatternFromEpisode } from '../services/pattern-store.js';
import type { EpisodicMemoryConfig } from '../types/config.js';
import type { EpisodeRecord } from '../types/memory.js';

/**
 * Resolve the on-disk path for the local FTS5 episode index. Honors an
 * explicit override on `config.episodes.fts.path` if present; otherwise
 * defaults to `{workDir}/.kova/episode-fts.db`.
 */
export function resolveFTSPath(workDir: string, config: EpisodicMemoryConfig): string {
  return config.fts?.path ?? joinPath(workDir, '.kova', 'episode-fts.db');
}

/**
 * Whether the FTS5 sidecar is enabled. Default is on (treat `fts === undefined`
 * as enabled) — explicit opt-out via `fts: { enabled: false }`.
 */
export function ftsEnabled(config: EpisodicMemoryConfig): boolean {
  if (config.fts === undefined) return true;
  return config.fts.enabled !== false;
}

/**
 * Mirror an `EpisodeRecord` into the FTS5 index. Best-effort: open/write
 * failures are logged and swallowed so they never break the existing
 * REST-based recordEpisode path.
 */
export function upsertEpisodeFTS(
  workDir: string,
  config: EpisodicMemoryConfig,
  episode: EpisodeRecord,
  logger: { warn: (msg: string) => void },
): void {
  if (!ftsEnabled(config)) return;
  const dbPath = resolveFTSPath(workDir, config);
  let store: EpisodeFTSStore | null = null;
  try {
    store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode({
      issue_number: episode.issue_number,
      repo: episode.repo,
      issue_title: episode.issue_title,
      approach: episode.approach,
      files_changed: episode.files_changed,
      outcome: episode.outcome,
      timestamp: episode.timestamp,
      ...(episode.learnings != null && { learnings: episode.learnings }),
      ...(episode.error_message != null && { error_message: episode.error_message }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[episode-fts] Failed to upsert episode: ${msg}`);
  } finally {
    store?.close();
  }
}

/**
 * Resolve the on-disk path for the local pattern aggregation DB. Defaults to
 * `{workDir}/.kova/patterns.db` — co-located with the FTS index for cleanup.
 */
export function resolvePatternStorePath(workDir: string): string {
  return joinPath(workDir, '.kova', 'patterns.db');
}

/**
 * Aggregate the completed episode into the pattern store. Best-effort: open or
 * upsert failures are logged and swallowed so they never break the existing
 * recordEpisode path.
 */
export function upsertEpisodePattern(
  workDir: string,
  config: EpisodicMemoryConfig,
  episode: EpisodeRecord,
  logger: { warn: (msg: string) => void },
): void {
  if (!config.enabled) return;
  let store: PatternStore | null = null;
  try {
    store = new PatternStore(resolvePatternStorePath(workDir));
    upsertPatternFromEpisode(store, episode);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[pattern-store] Failed to upsert pattern: ${msg}`);
  } finally {
    store?.close();
  }
}
