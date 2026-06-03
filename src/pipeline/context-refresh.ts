// Issue #277 — refresh codebaseContext after WAVE I.
//
// `codebaseContext` is built ONCE before the spec wave (see fix.ts) and
// reused across spec, retry, TI loop, re-spec, and conflict resolution.
// WAVE I edits files, so the cached context becomes STALE — re-impl and
// later reasoning would otherwise see PRE-edit code.
//
// This helper sits between WAVE I and any subsequent wave that consumes
// `codebaseContext`. Given the SHA captured BEFORE WAVE I started, it:
//
//   1. Lists the source files changed since that SHA via
//      `getChangedFilesSince` (git-diff aware).
//   2. POSTs that affected-set to the vector-DB reindex endpoint via
//      `reindexFiles` so the index now reflects post-edit code.
//   3. Re-runs `queryCodeContext` for the issue and reformats the chunks
//      via `formatCodeChunks` to produce a refreshed context string.
//
// Failure handling — every external call is guarded; on ANY failure
// (disabled config, missing SHA, no changed files, reindex 5xx, query
// returning empty, collaborator exception) the helper returns the
// caller-provided `currentContext` unchanged. The fix pipeline never
// crashes because of a stale-index refresh attempt.

import { getChangedFilesSince } from '../services/git-diff.js';
import { formatCodeChunks, queryCodeContext } from '../services/memory/code-rest.js';
import { reindexFiles } from '../services/reindex.js';
import type { RepoConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

export interface RefreshCodebaseContextOptions {
  /** Repo config — `vectordb.enabled` gates the entire helper. */
  config: Pick<RepoConfig, 'vectordb'>;
  /** Worktree path — passed to git-diff and reindex. */
  workDir: string;
  /**
   * The HEAD SHA captured BEFORE WAVE I started executing. `null` means
   * the caller did not capture a SHA — treat as a no-op (a mid-fix helper
   * should never trigger a full-repo reindex).
   */
  sinceSha: string | null;
  /** The query text used to re-run `queryCodeContext` (typically `${title}\n\n${body}`). */
  issueQuery: string;
  /**
   * The existing codebaseContext string (or `undefined` if vectordb was
   * disabled at the original spec-wave query). Returned unchanged on any
   * failure or no-op path.
   */
  currentContext: string | undefined;
}

/**
 * Refresh codebaseContext to reflect post-WAVE-I edits.
 *
 * Returns the refreshed context string on success, or `currentContext`
 * (unchanged) on any no-op / failure path. Never throws.
 */
export async function refreshCodebaseContext(options: RefreshCodebaseContextOptions): Promise<string | undefined> {
  const { config, workDir, sinceSha, issueQuery, currentContext } = options;

  // Gate 1: vectordb disabled or absent — no-op, no log noise.
  const vectordb = config.vectordb;
  if (!vectordb?.enabled) {
    return currentContext;
  }

  // Gate 2: no pre-impl SHA captured — refuse to operate on the full repo.
  if (sinceSha === null) {
    return currentContext;
  }

  try {
    // Step 1: list source files changed since the pre-impl SHA.
    const changed = await getChangedFilesSince(workDir, sinceSha);
    if (changed.length === 0) {
      // Impl wave touched no source files (or only ignored extensions) —
      // the existing context is still accurate.
      return currentContext;
    }

    // Step 2: reindex the affected set. On failure, warn and retain.
    const reindex = await reindexFiles(vectordb, workDir, changed);
    if (!reindex.success) {
      log.warn(
        `[context-refresh] reindex of ${changed.length} post-impl file(s) failed (${reindex.error ?? 'unknown'}) — retaining stale context`,
      );
      return currentContext;
    }
    log.info(`[context-refresh] Reindexed ${changed.length} file(s) post-impl (${reindex.duration}ms)`);

    // Step 3: re-query the vector DB now that the index reflects post-edit code.
    const chunks = await queryCodeContext(vectordb, issueQuery);
    if (chunks.length === 0) {
      // Query returned nothing — the existing context is at least non-empty,
      // so retain it rather than replacing with an empty string.
      return currentContext;
    }

    const refreshed = formatCodeChunks(chunks);
    log.info(`[context-refresh] codebaseContext refreshed (${chunks.length} chunks from post-impl index)`);
    return refreshed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[context-refresh] Unexpected failure: ${msg} — retaining existing context`);
    return currentContext;
  }
}
