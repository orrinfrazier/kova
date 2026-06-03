// Sequential piece merger — merges completed sub-worktree pieces into the fix branch
// one at a time with test verification between each merge.

import { $ } from 'zx';
import { log } from '../utils/logger.js';
import { removeSubWorktree, type SubWorktree } from '../vcs/worktree.js';
import type { TestRunner } from './loops.js';

$.verbose = false;

export interface PieceMergeResult {
  pieceIndex: number;
  success: boolean;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  mergedPieces: PieceMergeResult[];
  failedPieces: PieceMergeResult[];
}

export interface PieceMergerConfig {
  fixWorktreePath: string;
  repoPath: string;
  pieces: SubWorktree[];
  dependencyOrder: number[][];
  testCommand: string;
  testRunner: TestRunner;
}

/**
 * Merge a single piece branch into the fix worktree using --no-ff.
 * Returns true on success, throws on conflict.
 */
async function mergeSubWorktree(fixWorktreePath: string, pieceBranch: string, pieceIndex: number): Promise<void> {
  try {
    await $`git -C ${fixWorktreePath} merge --no-ff -m ${`Merge piece-${pieceIndex} (${pieceBranch})`} ${pieceBranch}`;
  } catch {
    // Abort the failed merge to restore clean state
    try {
      await $`git -C ${fixWorktreePath} merge --abort`;
    } catch {
      // merge --abort can fail if there's no merge in progress
    }
    throw new Error(`Merge conflict merging ${pieceBranch} into fix branch`);
  }
}

/**
 * Revert the last merge commit (used when tests fail after a successful merge).
 */
async function revertLastMerge(fixWorktreePath: string): Promise<void> {
  try {
    await $`git -C ${fixWorktreePath} reset --hard HEAD~1`;
  } catch (error) {
    log.warn(`Failed to revert merge: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Merge completed pieces sequentially into the fix branch with test verification.
 *
 * For each piece in dependency order:
 * 1. git merge --no-ff piece branch into fix branch
 * 2. Run full test suite
 * 3. If tests fail: revert merge, mark piece as failed
 * 4. If merge conflicts: abort, defer to end of batch, retry once
 * 5. Clean up all sub-worktrees when done
 */
export async function mergePiecesSequentially(config: PieceMergerConfig): Promise<MergeResult> {
  const { fixWorktreePath, repoPath, pieces, dependencyOrder, testCommand, testRunner } = config;

  if (pieces.length === 0) {
    return { success: true, mergedPieces: [], failedPieces: [] };
  }

  const mergedPieces: PieceMergeResult[] = [];
  const failedPieces: PieceMergeResult[] = [];

  // Process each batch in dependency order
  for (const batch of dependencyOrder) {
    if (batch.length === 0) continue;

    const deferred: number[] = [];

    // First pass: merge each piece in the batch
    for (const pieceIndex of batch) {
      const piece = pieces[pieceIndex];
      if (!piece) {
        failedPieces.push({ pieceIndex, success: false, error: `Piece at index ${pieceIndex} not found` });
        continue;
      }

      const result = await mergeSinglePiece(fixWorktreePath, piece, pieceIndex, testCommand, testRunner);
      if (result.success) {
        mergedPieces.push(result);
      } else if (result.error?.includes('conflict')) {
        // Defer conflicting pieces for retry after the rest of the batch
        deferred.push(pieceIndex);
      } else {
        failedPieces.push(result);
      }
    }

    // Second pass: retry deferred (conflicting) pieces
    for (const pieceIndex of deferred) {
      const piece = pieces[pieceIndex];
      if (!piece) continue;
      const result = await mergeSinglePiece(fixWorktreePath, piece, pieceIndex, testCommand, testRunner);
      if (result.success) {
        mergedPieces.push(result);
      } else {
        failedPieces.push(result);
      }
    }
  }

  // Clean up all sub-worktrees
  for (const piece of pieces) {
    await removeSubWorktree(repoPath, piece.path, piece.branch);
  }

  return {
    success: failedPieces.length === 0,
    mergedPieces,
    failedPieces,
  };
}

async function mergeSinglePiece(
  fixWorktreePath: string,
  piece: SubWorktree,
  pieceIndex: number,
  testCommand: string,
  testRunner: TestRunner,
): Promise<PieceMergeResult> {
  // Step 1: Attempt merge
  try {
    await mergeSubWorktree(fixWorktreePath, piece.branch, pieceIndex);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[piece-merger] Piece ${pieceIndex} merge failed: ${msg}`);
    return { pieceIndex, success: false, error: msg };
  }

  // Step 2: Run tests
  log.info(`[piece-merger] Running tests after merging piece ${pieceIndex}`);
  const testRun = await testRunner(testCommand, fixWorktreePath);

  if (testRun.passed) {
    log.info(`[piece-merger] Piece ${pieceIndex} merged and tests pass`);
    return { pieceIndex, success: true };
  }

  // Step 3: Tests failed — revert the merge
  log.warn(`[piece-merger] Tests failed after merging piece ${pieceIndex} — reverting`);
  await revertLastMerge(fixWorktreePath);

  return {
    pieceIndex,
    success: false,
    error: `Tests failed after merge: ${testRun.output.slice(0, 500)}`,
  };
}
