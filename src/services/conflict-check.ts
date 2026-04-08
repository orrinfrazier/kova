// Pre-ship conflict detection via dry-run merge.
// Detects if the worktree branch will conflict with the default branch
// before attempting rebase/PR creation.

import { $ } from 'zx';
import { log } from '../utils/logger.js';
import { detectDefaultBranch } from './worktree.js';

$.verbose = false;

export interface ConflictCheckResult {
  /** Whether any conflicts were detected */
  hasConflicts: boolean;
  /** All files with conflicts */
  conflictingFiles: string[];
  /** Conflicts in files owned by the spec (our changes) */
  overlapping: string[];
  /** Conflicts in files we didn't touch (upstream-only) */
  nonOverlapping: string[];
}

const NO_CONFLICTS: ConflictCheckResult = {
  hasConflicts: false,
  conflictingFiles: [],
  overlapping: [],
  nonOverlapping: [],
};

/**
 * Detect merge conflicts between the current branch and the default branch
 * using a dry-run merge (git merge --no-commit --no-ff).
 *
 * Always cleans up after itself (merge --abort), leaving the working tree unchanged.
 *
 * @param workDir - worktree working directory
 * @param specFiles - files owned by the spec (used to categorize overlapping vs non-overlapping)
 */
export async function checkForConflicts(workDir: string, specFiles?: string[]): Promise<ConflictCheckResult> {
  const defaultBranch = await detectDefaultBranch(workDir);

  // Fetch latest from origin
  await $`git -C ${workDir} fetch origin`;

  // Attempt dry-run merge
  try {
    await $`git -C ${workDir} merge --no-commit --no-ff origin/${defaultBranch}`;
    // Merge succeeded (auto-merged) — no conflicts
    await safeAbortMerge(workDir);
    return NO_CONFLICTS;
  } catch {
    // Merge failed — conflicts exist
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
    return NO_CONFLICTS;
  }

  // Clean up the merge state
  await safeAbortMerge(workDir);

  if (conflictingFiles.length === 0) {
    return NO_CONFLICTS;
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
  };
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
