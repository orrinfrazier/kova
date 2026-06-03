// Pattern aggregation context provider (issue #431, originally #267).
//
// Mirrors the pre-WAVE-A block at fix.ts:1068-1077. Queries the local
// `patterns.db` for top recurring (diagnosis × module) patterns scoped to the
// repo. Best-effort: gated by `config.episodes?.enabled`; absent DB returns
// no patterns silently (never throws upward).

import { join as joinPath } from 'node:path';
import { formatPatterns, type PatternRecord, PatternStore } from '../../memory/pattern-store.js';
import type { EpisodicMemoryConfig } from '../../types/config.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const patternProvider: ContextProvider = {
  name: 'patternContext',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    if (!ctx.config.episodes?.enabled) return undefined;
    const patterns = queryPatternContext(ctx.workDir, ctx.config.episodes, ctx.repoName);
    if (patterns.length === 0) return undefined;
    return formatPatterns(patterns);
  },
};

/**
 * Resolve the on-disk path for the local pattern aggregation DB. Defaults to
 * `{workDir}/.kova/patterns.db` — co-located with the FTS index for cleanup.
 */
function resolvePatternStorePath(workDir: string): string {
  return joinPath(workDir, '.kova', 'patterns.db');
}

/**
 * Open the local PatternStore, run `queryTopPatterns(repo)`, return the rows.
 * Best-effort: any open/query failure returns []. Absent DB is the normal
 * case on a fresh checkout and produces no warning.
 */
function queryPatternContext(workDir: string, config: EpisodicMemoryConfig, repo: string): PatternRecord[] {
  if (!config.enabled) return [];
  let store: PatternStore | null = null;
  try {
    store = new PatternStore(resolvePatternStorePath(workDir));
    return store.queryTopPatterns(repo, { limit: config.max_episodes });
  } catch {
    return [];
  } finally {
    store?.close();
  }
}
