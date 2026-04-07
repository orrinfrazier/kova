// Git worktree management — create isolated working directories for each fix.

import { $, fs, path } from 'zx';
import { log } from '../utils/logger.js';

$.verbose = false;

export interface Worktree {
  path: string;
  branch: string;
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const result = await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`;
    // Returns e.g. "refs/remotes/origin/main" — extract the branch name
    const ref = result.stdout.trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    log.debug('Could not detect default branch from origin/HEAD, falling back to main');
  }
  return 'main';
}

export async function createWorktree(repoPath: string, issueNumber: number): Promise<Worktree> {
  const branch = `kova/fix-${issueNumber}`;
  const wtPath = worktreePath(repoPath, issueNumber);
  const defaultBranch = await detectDefaultBranch(repoPath);

  // Create branch from default branch if it doesn't exist
  try {
    await $`git -C ${repoPath} branch ${branch} ${defaultBranch}`;
  } catch {
    // Branch may already exist (resume case)
    log.debug(`Branch ${branch} already exists`);
  }

  // Create worktree
  try {
    await $`git -C ${repoPath} worktree add ${wtPath} ${branch}`;
    log.info(`Worktree created: ${wtPath} (${branch})`);
  } catch {
    // Worktree may already exist (resume case)
    log.debug(`Worktree already exists at ${wtPath}`);
  }

  return { path: wtPath, branch };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree remove ${worktreePath} --force`;
    log.info(`Worktree removed: ${worktreePath}`);
  } catch (error) {
    log.warn(`Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function worktreePath(repoPath: string, issueNumber: number): string {
  return path.join(repoPath, '..', '.kova-worktrees', `fix-${issueNumber}`);
}

export async function worktreeExists(repoPath: string, issueNumber: number): Promise<boolean> {
  try {
    const stat = await fs.stat(worktreePath(repoPath, issueNumber));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export interface CommitAndPushResult {
  committed: boolean;
  filesStaged: string[];
  commitMessage?: string;
}

export async function commitAndPush(
  workDir: string,
  branch: string,
  issue: { number: number; title: string },
): Promise<CommitAndPushResult> {
  // Detect changed files: modified tracked + untracked
  const [modified, untracked] = await Promise.all([
    $`git -C ${workDir} diff --name-only`,
    $`git -C ${workDir} ls-files --others --exclude-standard`,
  ]);
  const files = [
    ...modified.stdout.trim().split('\n').filter(Boolean),
    ...untracked.stdout.trim().split('\n').filter(Boolean),
  ];

  if (files.length === 0) {
    log.info('[ship] No changed files — skipping commit');
    return { committed: false, filesStaged: [] };
  }

  // Stage specific files (not -A)
  await $`git -C ${workDir} add ${files}`;

  // Commit with conventional message
  const commitMessage = `fix: ${issue.title} (#${issue.number})`;
  await $`git -C ${workDir} commit -m ${commitMessage}`;
  log.info(`[ship] Committed ${files.length} file(s): ${commitMessage}`);

  // Push branch to origin
  await $`git -C ${workDir} push -u origin ${branch}`;
  log.info(`[ship] Pushed ${branch} to origin`);

  return { committed: true, filesStaged: files, commitMessage };
}

export async function cleanupWorktrees(repoPath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree prune`;
  } catch {
    // Best effort
  }
}
