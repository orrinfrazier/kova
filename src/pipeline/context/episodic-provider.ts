// Episodic-memory context provider (issue #431).
//
// Resolves past-issue learnings by merging two recall surfaces:
//   1. Vector neighbors via `queryEpisodeContext` (semantic similarity).
//   2. FTS5 keyword matches via `EpisodeFTSStore` (issue #302 — exact tokens).
// The merged set produces TWO output strings — the headline `episodicContext`
// (all merged episodes) and the specialized `failedEpisodicContext` (only the
// failed-outcome subset) — so this provider returns a multi-key output.

import { join as joinPath } from 'node:path';
import { type EpisodeFTSRecord, EpisodeFTSStore } from '../../services/episode-fts.js';
import type { EpisodeContext } from '../../services/vectordb.js';
import { formatEpisodes, formatFailedEpisodes, queryEpisodeContext } from '../../services/vectordb.js';
import type { EpisodicMemoryConfig } from '../../types/config.js';
import type { ContextProvider, ContextProviderInput, MultiContextOutput } from './types.js';

export const episodicProvider: ContextProvider = {
  name: 'episodicContext',
  async resolve(ctx: ContextProviderInput): Promise<MultiContextOutput | undefined> {
    if (!ctx.config.episodes?.enabled) return undefined;
    const episodesConfig = ctx.config.episodes;
    const query = `${ctx.issue.title}\n\n${ctx.issue.body}`;
    const vectorEpisodes = await queryEpisodeContext(episodesConfig, query, {
      repo: ctx.repoName,
      language: ctx.language !== 'unknown' ? ctx.language : undefined,
    });

    // FTS5 keyword recall (#302): complements vector neighbors with exact
    // matches on error strings, symbols, paths. Local + optional — absent
    // DB returns []; disabled in config skips the path entirely.
    const ftsEpisodes = queryFTSEpisodes(ctx.workDir, episodesConfig, query);
    const ftsAsContext = ftsEpisodes.map(ftsRecordToContext);

    // Merge: FTS hits first (exact tokens are higher-signal for recall),
    // then non-duplicate vector neighbors. Dedup key = `${repo}:${issue_number}`.
    const seenKeys = new Set<string>();
    const merged: typeof vectorEpisodes = [];
    for (const ep of ftsAsContext) {
      const key = `${ep.repo ?? ''}:${ep.issue_number}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      merged.push(ep);
    }
    for (const ep of vectorEpisodes) {
      const key = `${ep.repo ?? ''}:${ep.issue_number}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      merged.push(ep);
    }

    if (merged.length === 0) return undefined;

    return {
      episodicContext: formatEpisodes(merged, ctx.repoName),
      failedEpisodicContext: formatFailedEpisodes(merged, ctx.repoName) || undefined,
    };
  },
};

/* ================================================================== */
/*  Local FTS5 episode recall (#302) — helpers                         */
/* ================================================================== */

/**
 * Resolve the on-disk path for the local FTS5 episode index. Honors an
 * explicit override on `config.episodes.fts.path` if present; otherwise
 * defaults to `{workDir}/.kova/episode-fts.db`.
 */
function resolveFTSPath(workDir: string, config: EpisodicMemoryConfig): string {
  return config.fts?.path ?? joinPath(workDir, '.kova', 'episode-fts.db');
}

/**
 * Whether the FTS5 sidecar is enabled. Default is on (treat `fts === undefined`
 * as enabled) — explicit opt-out via `fts: { enabled: false }`.
 */
function ftsEnabled(config: EpisodicMemoryConfig): boolean {
  if (config.fts === undefined) return true;
  return config.fts.enabled !== false;
}

function queryFTSEpisodes(workDir: string, config: EpisodicMemoryConfig, query: string): EpisodeFTSRecord[] {
  if (!ftsEnabled(config)) return [];
  const dbPath = resolveFTSPath(workDir, config);
  let store: EpisodeFTSStore | null = null;
  try {
    store = new EpisodeFTSStore(dbPath);
    return store.searchEpisodesFTS(query, config.max_episodes);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

/**
 * Adapt an `EpisodeFTSRecord` into the `EpisodeContext` shape expected by
 * `formatEpisodes` / `formatFailedEpisodes`. Maps `outcome` to the EpisodeContext
 * union (`success` | `partial` | `failure`) using the same convention as
 * `buildEpisodeRecord`. Score is a synthetic constant so all FTS hits sort
 * after each other purely by insertion order (which is BM25 order from the
 * store).
 */
function ftsRecordToContext(r: EpisodeFTSRecord): EpisodeContext {
  let outcome: EpisodeContext['outcome'];
  switch (r.outcome) {
    case 'pr_created':
      outcome = 'success';
      break;
    case 'failed':
      outcome = 'failure';
      break;
    case 'skipped':
      outcome = 'partial';
      break;
    case 'success':
    case 'partial':
    case 'failure':
      outcome = r.outcome;
      break;
    default:
      outcome = 'partial';
  }
  return {
    issue_number: r.issue_number,
    issue_title: r.issue_title,
    approach: r.approach,
    outcome,
    learnings: r.learnings ?? '',
    score: 1,
    repo: r.repo,
  };
}
