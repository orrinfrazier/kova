// Git worktree management — create isolated working directories for each fix.

import { $, path } from 'zx';
import { log } from '../utils/logger.js';

$.verbose = false;

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(repoPath: string, issueNumber: number): Promise<Worktree> {
  const branch = `kova/fix-${issueNumber}`;
  const worktreePath = path.join(repoPath, '..', `.kova-worktrees`, `fix-${issueNumber}`);

  // Create branch from current HEAD if it doesn't exist
  try {
    await $`git -C ${repoPath} branch ${branch}`;
  } catch {
    // Branch may already exist (resume case)
    log.debug(`Branch ${branch} already exists`);
  }

  // Create worktree
  try {
    await $`git -C ${repoPath} worktree add ${worktreePath} ${branch}`;
    log.info(`Worktree created: ${worktreePath} (${branch})`);
  } catch {
    // Worktree may already exist (resume case)
    log.debug(`Worktree already exists at ${worktreePath}`);
  }

  return { path: worktreePath, branch };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree remove ${worktreePath} --force`;
    log.info(`Worktree removed: ${worktreePath}`);
  } catch (error) {
    log.warn(`Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cleanupWorktrees(repoPath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree prune`;
  } catch {
    // Best effort
  }
}
