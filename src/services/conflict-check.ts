// Pre-ship conflict detection via dry-run merge.
// Detects if the worktree branch will conflict with the default branch
// before attempting rebase/PR creation.

import { $ } from 'zx';
import { log } from '../utils/logger.js';
import { detectDefaultBranch } from './worktree.js';

$.verbose = false;

/**
 * Cross-piece dependency edge surfaced by the codegraph (#276).
 *
 * Two pieces touch no shared file but a symbol defined in one is called from
 * the other. checkForConflicts surfaces these as a separate field so the
 * caller can serialize the coupled pieces / flag the rename without textual
 * merge-conflict signal.
 */
export interface DependencyOverlapConflict {
  /** Symbol name defined in the source file. */
  symbolName: string;
  /** File where the symbol is defined (likely changed by this branch). */
  sourceFile: string;
  /** File where the symbol is called from (a live dependent). */
  dependentFile: string;
}

export interface ConflictCheckResult {
  /** Whether any conflicts were detected */
  hasConflicts: boolean;
  /** All files with conflicts */
  conflictingFiles: string[];
  /** Conflicts in files owned by the spec (our changes) */
  overlapping: string[];
  /** Conflicts in files we didn't touch (upstream-only) */
  nonOverlapping: string[];
  /**
   * Cross-piece dependency overlaps detected via the codegraph (#276).
   * Populated only when {@link CheckForConflictsOptions.dependencyLookup} is
   * provided. A non-empty list is independently meaningful even when
   * `hasConflicts === false` (textual merge clean but a renamed export with a
   * live dependent should still be flagged).
   */
  dependencyOverlaps: DependencyOverlapConflict[];
}

const NO_CONFLICTS: ConflictCheckResult = {
  hasConflicts: false,
  conflictingFiles: [],
  overlapping: [],
  nonOverlapping: [],
  dependencyOverlaps: [],
};

/**
 * Read-only slice of the codegraph store used by {@link checkForConflicts} to
 * detect dependency overlaps (#276). Structurally compatible with
 * `CodegraphHandle` from `services/codegraph` — production callers pass a
 * thin adapter.
 */
export interface ConflictDependencyLookup {
  /** Symbols defined in the given file. */
  listFileSymbols: (filePath: string) => { id: string; name: string; filePath: string }[];
  /** Files that import (directly) from the given file path. */
  getFileDependents: (filePath: string) => string[];
}

export interface CheckForConflictsOptions {
  /**
   * Optional codegraph lookup used to surface dependency overlaps. When
   * omitted, `dependencyOverlaps` is always `[]` and behavior matches the
   * pre-#276 contract exactly (file-overlap only).
   */
  dependencyLookup?: ConflictDependencyLookup;
  /**
   * Files changed in the branch (typically `git diff --name-only base..HEAD`).
   * Required when `dependencyLookup` is set — without it the function does
   * not know which symbols to interrogate.
   */
  changedFiles?: string[];
}

/**
 * Detect merge conflicts between the current branch and the default branch
 * using a dry-run merge (git merge --no-commit --no-ff).
 *
 * Always cleans up after itself (merge --abort), leaving the working tree unchanged.
 *
 * When {@link CheckForConflictsOptions.dependencyLookup} is provided, also
 * surfaces cross-piece dependency overlaps (#276): symbols defined in the
 * changed files that have live importers/callers outside the changed set.
 * Lookup failures degrade gracefully — textual conflict detection still runs.
 *
 * @param workDir - worktree working directory
 * @param specFiles - files owned by the spec (used to categorize overlapping vs non-overlapping)
 * @param options - optional dependency-lookup wiring for #276 surfacing
 */
export async function checkForConflicts(
  workDir: string,
  specFiles?: string[],
  options?: CheckForConflictsOptions,
): Promise<ConflictCheckResult> {
  const defaultBranch = await detectDefaultBranch(workDir);

  // Fetch latest from origin
  await $`git -C ${workDir} fetch origin`;

  // Compute dependency overlaps up front (independent of textual merge result).
  // Wrapped in try/catch — any failure leaves `dependencyOverlaps = []` and the
  // textual-conflict path runs unchanged (pre-#276 behavior preserved).
  let dependencyOverlaps: DependencyOverlapConflict[] = [];
  if (options?.dependencyLookup && options.changedFiles && options.changedFiles.length > 0) {
    try {
      dependencyOverlaps = computeDependencyOverlaps(options.dependencyLookup, options.changedFiles);
    } catch (err) {
      log.debug(
        `[conflict-check] dependency-overlap probe threw — proceeding without: ${err instanceof Error ? err.message : String(err)}`,
      );
      dependencyOverlaps = [];
    }
  }

  // Attempt dry-run merge
  try {
    await $`git -C ${workDir} merge --no-commit --no-ff origin/${defaultBranch}`;
    // Merge succeeded (auto-merged) — no textual conflicts.
    // hasConflicts stays false; dependencyOverlaps may still be non-empty.
    await safeAbortMerge(workDir);
    return {
      hasConflicts: false,
      conflictingFiles: [],
      overlapping: [],
      nonOverlapping: [],
      dependencyOverlaps,
    };
  } catch {
    // Merge failed — textual conflicts exist
    log.debug('Dry-run merge detected conflicts');
  }

  // Collect conflicting files from unmerged paths
  let conflictingFiles: string[];
  try {
    const result = await $`git -C ${workDir} diff --name-only --diff-filter=U`;
    conflictingFiles = result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    // Can't determine conflicts — clean up and report empty
    await safeAbortMerge(workDir);
    return { ...NO_CONFLICTS, dependencyOverlaps };
  }

  // Clean up the merge state
  await safeAbortMerge(workDir);

  if (conflictingFiles.length === 0) {
    return { ...NO_CONFLICTS, dependencyOverlaps };
  }

  // Categorize: overlapping (in spec files) vs non-overlapping
  const specFileSet = new Set(specFiles ?? []);
  const overlapping = specFileSet.size > 0 ? conflictingFiles.filter((f) => specFileSet.has(f)) : conflictingFiles;
  const nonOverlapping = specFileSet.size > 0 ? conflictingFiles.filter((f) => !specFileSet.has(f)) : [];

  return {
    hasConflicts: true,
    conflictingFiles,
    overlapping,
    nonOverlapping,
    dependencyOverlaps,
  };
}

/**
 * Walk changed files, find their symbols, and surface importers/callers that
 * live OUTSIDE the changed set. Returns the list of edges so the caller can
 * flag potential rename/signature breakage even without a textual conflict.
 */
function computeDependencyOverlaps(
  lookup: ConflictDependencyLookup,
  changedFiles: string[],
): DependencyOverlapConflict[] {
  if (changedFiles.length === 0) return [];

  const changedSet = new Set(changedFiles);
  const out: DependencyOverlapConflict[] = [];
  const seen = new Set<string>();

  for (const file of changedFiles) {
    let symbols: { id: string; name: string; filePath: string }[];
    try {
      symbols = lookup.listFileSymbols(file);
    } catch {
      continue;
    }

    let importers: string[];
    try {
      importers = lookup.getFileDependents(file);
    } catch {
      importers = [];
    }

    // Importers of a changed file that themselves are not changed — those are
    // the dependents at risk of a rename/signature break.
    for (const importer of importers) {
      if (changedSet.has(importer)) continue;
      // One entry per (changed-file, importer) pair. Symbol name omitted at
      // the file-level — pick a representative symbol from the changed file
      // for the report so the caller has something concrete to cite. If the
      // file exports nothing the lookup knows about, fall back to '<file>'.
      const repSymbol = symbols[0]?.name ?? '<file>';
      const key = `${file}->${importer}:imports`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        symbolName: repSymbol,
        sourceFile: file,
        dependentFile: importer,
      });
    }
  }

  return out;
}

async function safeAbortMerge(workDir: string): Promise<void> {
  try {
    await $`git -C ${workDir} merge --abort`;
  } catch {
    // Best effort — reset if merge --abort doesn't work
    try {
      await $`git -C ${workDir} reset --hard HEAD`;
    } catch {
      // Best effort
    }
  }
}
