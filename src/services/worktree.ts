// Git worktree management — create isolated working directories for each fix.

import { $, fs, path } from 'zx';
import { log } from '../utils/logger.js';
import { type BranchTemplateVars, kebabDescription, renderBranchTemplate } from './branch-template.js';

$.verbose = false;

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Optional context for templated branch naming (issue #320, pattern 2).
 *
 * When `template` is set, the branch name is rendered from the template with
 * variables drawn from `issue` and the optional fields below. When `template`
 * is omitted, the historical `kova/fix-{issueNumber}` pattern is preserved.
 */
export interface BranchNamingContext {
  template?: string | undefined;
  issue: { number: number; title?: string | undefined; labels?: readonly string[] | undefined };
  /** Override the prefix substituted for `{{prefix}}`. Default `"kova/"`. */
  prefix?: string | undefined;
  /** Override the entity type substituted for `{{entityType}}`. Default `"fix"`. */
  entityType?: string | undefined;
}

function resolveBranchName(ctx: BranchNamingContext): string {
  const { template, issue } = ctx;
  if (template == null || template.trim().length === 0) {
    return `kova/fix-${issue.number}`;
  }
  const vars: BranchTemplateVars = {
    prefix: ctx.prefix ?? 'kova/',
    entityType: ctx.entityType ?? 'fix',
    entityNumber: issue.number,
    timestamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    sha: '',
    label: issue.labels?.[0] ?? '',
    description: kebabDescription(issue.title ?? ''),
  };
  const rendered = renderBranchTemplate(template, vars);
  // Guard against pathological templates that produce empty refs.
  return rendered.length > 0 ? rendered : `kova/fix-${issue.number}`;
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

export async function createWorktree(
  repoPath: string,
  issueNumber: number,
  branchContext?: BranchNamingContext,
): Promise<Worktree> {
  const branch = branchContext != null ? resolveBranchName(branchContext) : `kova/fix-${issueNumber}`;
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

export interface SubWorktree {
  path: string;
  branch: string;
}

export function subWorktreePath(fixWorktreePath: string, issueNumber: number, pieceIndex: number): string {
  return path.join(fixWorktreePath, '..', `fix-${issueNumber}-piece-${pieceIndex}`);
}

export async function createSubWorktree(
  fixWorktreePath: string,
  issueNumber: number,
  pieceIndex: number,
): Promise<SubWorktree> {
  const branch = `kova/fix-${issueNumber}-piece-${pieceIndex}`;
  const swPath = subWorktreePath(fixWorktreePath, issueNumber, pieceIndex);
  const fixBranch = (await $`git -C ${fixWorktreePath} rev-parse --abbrev-ref HEAD`).stdout.trim();

  // Create branch from the fix branch
  try {
    await $`git -C ${fixWorktreePath} branch ${branch} ${fixBranch}`;
  } catch {
    log.debug(`Branch ${branch} already exists`);
  }

  // Create sub-worktree
  try {
    await $`git -C ${fixWorktreePath} worktree add ${swPath} ${branch}`;
    log.info(`Sub-worktree created: ${swPath} (${branch})`);
  } catch {
    log.debug(`Sub-worktree already exists at ${swPath}`);
  }

  return { path: swPath, branch };
}

export async function removeSubWorktree(repoPath: string, swPath: string, branch: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree remove ${swPath} --force`;
    log.info(`Sub-worktree removed: ${swPath}`);
  } catch (error) {
    log.warn(`Failed to remove sub-worktree: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await $`git -C ${repoPath} branch -D ${branch}`;
    log.info(`Sub-worktree branch deleted: ${branch}`);
  } catch (error) {
    log.warn(`Failed to delete branch ${branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

export async function getChangedFiles(workDir: string): Promise<string[]> {
  const [modified, untracked] = await Promise.all([
    $`git -C ${workDir} diff --name-only`,
    $`git -C ${workDir} ls-files --others --exclude-standard`,
  ]);
  return [
    ...modified.stdout.trim().split('\n').filter(Boolean),
    ...untracked.stdout.trim().split('\n').filter(Boolean),
  ];
}

export async function commitAndPush(
  workDir: string,
  branch: string,
  issue: { number: number; title: string },
): Promise<CommitAndPushResult> {
  const files = await getChangedFiles(workDir);

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

export interface RebaseResult {
  success: boolean;
  conflicted: boolean;
  conflictFiles?: string[];
}

export async function rebaseOnDefault(workDir: string): Promise<RebaseResult> {
  const defaultBranch = await detectDefaultBranch(workDir);

  // Fetch latest from origin
  await $`git -C ${workDir} fetch origin`;

  // Attempt rebase onto origin/defaultBranch
  try {
    await $`git -C ${workDir} rebase origin/${defaultBranch}`;
    return { success: true, conflicted: false };
  } catch {
    // Rebase failed — collect conflict files then abort
    log.debug('Rebase conflict detected, collecting conflict files');
    try {
      const status = await $`git -C ${workDir} diff --name-only --diff-filter=U`;
      const conflictFiles = status.stdout.trim().split('\n').filter(Boolean);
      await $`git -C ${workDir} rebase --abort`;
      return { success: false, conflicted: true, conflictFiles };
    } catch {
      // Best effort abort
      try {
        await $`git -C ${workDir} rebase --abort`;
      } catch {
        /* best effort */
      }
      return { success: false, conflicted: true, conflictFiles: [] };
    }
  }
}

export async function cleanupWorktrees(repoPath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} worktree prune`;
  } catch {
    // Best effort
  }
}
