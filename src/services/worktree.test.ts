import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import {
  commitAndPush,
  createSubWorktree,
  createWorktree,
  detectDefaultBranch,
  rebaseOnDefault,
  removeSubWorktree,
  subWorktreePath,
  worktreeExists,
} from './worktree.js';

$.verbose = false;

describe('worktreeExists', () => {
  let outerDir: string;
  let repoDir: string;

  beforeEach(async () => {
    // Use a nested dir so worktreePath (which resolves to ../..kova-worktrees) stays isolated
    outerDir = await mkdtemp(join(tmpdir(), 'kova-wt-'));
    repoDir = join(outerDir, 'repo');
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outerDir, { recursive: true, force: true });
  });

  it('returns false when worktree directory does not exist', async () => {
    const result = await worktreeExists(repoDir, 123);
    expect(result).toBe(false);
  });

  it('returns true when worktree directory exists', async () => {
    // Mirror the path that createWorktree would produce: <repoPath>/../.kova-worktrees/fix-<N>
    const wtPath = join(outerDir, '.kova-worktrees', 'fix-123');
    await mkdir(wtPath, { recursive: true });

    const result = await worktreeExists(repoDir, 123);
    expect(result).toBe(true);
  });
});

describe('detectDefaultBranch', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kova-test-'));
    await $`git -C ${repoPath} init -b main`;
    await $`git -C ${repoPath} commit --allow-empty -m "init"`;
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('detects default branch from origin/HEAD', async () => {
    const remotePath = await mkdtemp(join(tmpdir(), 'kova-remote-'));
    await $`git -C ${remotePath} init --bare -b main`;
    await $`git -C ${repoPath} remote add origin ${remotePath}`;
    await $`git -C ${repoPath} push -u origin main`;
    await $`git -C ${repoPath} remote set-head origin --auto`;

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe('main');

    await rm(remotePath, { recursive: true, force: true });
  });

  it('detects non-standard default branch name', async () => {
    const remotePath = await mkdtemp(join(tmpdir(), 'kova-remote-'));
    await $`git -C ${remotePath} init --bare -b develop`;

    const clonePath = await mkdtemp(join(tmpdir(), 'kova-clone-'));
    await $`git clone ${remotePath} ${clonePath}`;
    await $`git -C ${clonePath} checkout -b develop`;
    await $`git -C ${clonePath} commit --allow-empty -m "init"`;
    await $`git -C ${clonePath} push -u origin develop`;
    await $`git -C ${clonePath} remote set-head origin --auto`;

    const branch = await detectDefaultBranch(clonePath);
    expect(branch).toBe('develop');

    await rm(remotePath, { recursive: true, force: true });
    await rm(clonePath, { recursive: true, force: true });
  });

  it('falls back to main when origin/HEAD is not set', async () => {
    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe('main');
  });
});

describe('createWorktree', () => {
  let repoPath: string;
  let remotePath: string;
  let worktreePaths: string[];

  beforeEach(async () => {
    worktreePaths = [];
    remotePath = await mkdtemp(join(tmpdir(), 'kova-remote-'));
    await $`git -C ${remotePath} init --bare -b main`;

    repoPath = await mkdtemp(join(tmpdir(), 'kova-test-'));
    await $`git clone ${remotePath} ${repoPath}`;
    await $`git -C ${repoPath} commit --allow-empty -m "initial commit"`;
    await $`git -C ${repoPath} push -u origin main`;
    await $`git -C ${repoPath} remote set-head origin --auto`;
  });

  afterEach(async () => {
    for (const wt of worktreePaths) {
      try {
        await $`git -C ${repoPath} worktree remove ${wt} --force`;
      } catch {
        // best effort
      }
    }
    await rm(repoPath, { recursive: true, force: true });
    await rm(remotePath, { recursive: true, force: true });
  });

  it('branches from default branch, not HEAD', async () => {
    await $`git -C ${repoPath} commit --allow-empty -m "main commit"`;
    await $`git -C ${repoPath} push origin main`;
    const mainSha = (await $`git -C ${repoPath} rev-parse main`).stdout.trim();

    await $`git -C ${repoPath} checkout -b feature-branch`;
    await $`git -C ${repoPath} commit --allow-empty -m "feature commit"`;
    const featureSha = (await $`git -C ${repoPath} rev-parse HEAD`).stdout.trim();

    expect(featureSha).not.toBe(mainSha);

    const worktree = await createWorktree(repoPath, 999);
    worktreePaths.push(worktree.path);

    const worktreeBase = (await $`git -C ${worktree.path} rev-parse HEAD`).stdout.trim();
    expect(worktreeBase).toBe(mainSha);
  });

  it('creates worktree with correct branch name', async () => {
    const worktree = await createWorktree(repoPath, 42);
    worktreePaths.push(worktree.path);

    expect(worktree.branch).toBe('kova/fix-42');
    const currentBranch = (await $`git -C ${worktree.path} rev-parse --abbrev-ref HEAD`).stdout.trim();
    expect(currentBranch).toBe('kova/fix-42');
  });
});

describe('subWorktreePath', () => {
  it('returns deterministic path as sibling of fix worktree', () => {
    const fixWtPath = '/tmp/kova/.kova-worktrees/fix-42';
    const result = subWorktreePath(fixWtPath, 42, 0);
    expect(result).toBe('/tmp/kova/.kova-worktrees/fix-42-piece-0');
  });

  it('uses issue number and piece index in path', () => {
    const fixWtPath = '/tmp/kova/.kova-worktrees/fix-99';
    expect(subWorktreePath(fixWtPath, 99, 3)).toBe('/tmp/kova/.kova-worktrees/fix-99-piece-3');
  });
});

/**
 * Creates a bare remote + cloned local + fix worktree to mirror kova's
 * real workflow for sub-worktree tests.
 */
async function setupFixWorktree(): Promise<{
  remote: string;
  local: string;
  fixWorktree: string;
  fixBranch: string;
  issueNumber: number;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-sub-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const fixWtDir = join(base, '.kova-worktrees');
  const issueNumber = 42;
  const fixBranch = `kova/fix-${issueNumber}`;
  const fixWorktree = join(fixWtDir, `fix-${issueNumber}`);

  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;
  await writeFile(join(local, 'README.md'), '# Test repo\n');
  await $`git -C ${local} add README.md`;
  await $`git -C ${local} commit -m "init on main"`;
  await $`git -C ${local} push origin main`;

  // Create fix branch with an extra commit so it diverges from main
  await $`git -C ${local} branch ${fixBranch}`;
  await mkdir(fixWtDir, { recursive: true });
  await $`git -C ${local} worktree add ${fixWorktree} ${fixBranch}`;
  await $`git -C ${fixWorktree} config user.email "test@kova.dev"`;
  await $`git -C ${fixWorktree} config user.name "Kova Test"`;
  await writeFile(join(fixWorktree, 'fix.ts'), 'export const fix = true;\n');
  await $`git -C ${fixWorktree} add fix.ts`;
  await $`git -C ${fixWorktree} commit -m "fix commit on fix branch"`;

  return { remote, local, fixWorktree, fixBranch, issueNumber };
}

describe('createSubWorktree', () => {
  let repos: Awaited<ReturnType<typeof setupFixWorktree>>;
  const subWorktrees: string[] = [];

  beforeEach(async () => {
    repos = await setupFixWorktree();
    subWorktrees.length = 0;
  });

  afterEach(async () => {
    for (const swt of subWorktrees) {
      try {
        await $`git -C ${repos.local} worktree remove ${swt} --force`;
      } catch {
        // best effort
      }
    }
    try {
      await $`git -C ${repos.local} worktree remove ${repos.fixWorktree} --force`;
    } catch {
      // best effort
    }
    await rm(join(repos.fixWorktree, '../..'), { recursive: true, force: true }).catch(() => {});
  });

  it('branches from the fix branch, not main', async () => {
    const fixSha = (await $`git -C ${repos.fixWorktree} rev-parse HEAD`).stdout.trim();
    const mainSha = (await $`git -C ${repos.local} rev-parse main`).stdout.trim();
    expect(fixSha).not.toBe(mainSha);

    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);
    subWorktrees.push(sub.path);

    const subSha = (await $`git -C ${sub.path} rev-parse HEAD`).stdout.trim();
    expect(subSha).toBe(fixSha);
  });

  it('uses deterministic branch naming: kova/fix-{issue}-piece-{index}', async () => {
    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 2);
    subWorktrees.push(sub.path);

    expect(sub.branch).toBe('kova/fix-42-piece-2');
    const currentBranch = (await $`git -C ${sub.path} rev-parse --abbrev-ref HEAD`).stdout.trim();
    expect(currentBranch).toBe('kova/fix-42-piece-2');
  });

  it('returns SubWorktree with path and branch', async () => {
    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 1);
    subWorktrees.push(sub.path);

    expect(sub).toHaveProperty('path');
    expect(sub).toHaveProperty('branch');
    expect(sub.path).toContain('fix-42-piece-1');
    expect(sub.branch).toBe('kova/fix-42-piece-1');
  });

  it('handles resume case when sub-worktree already exists', async () => {
    const sub1 = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);
    subWorktrees.push(sub1.path);

    // Second call should not throw
    const sub2 = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);
    expect(sub2.path).toBe(sub1.path);
    expect(sub2.branch).toBe(sub1.branch);
  });
});

describe('removeSubWorktree', () => {
  let repos: Awaited<ReturnType<typeof setupFixWorktree>>;

  beforeEach(async () => {
    repos = await setupFixWorktree();
  });

  afterEach(async () => {
    try {
      await $`git -C ${repos.local} worktree remove ${repos.fixWorktree} --force`;
    } catch {
      // best effort
    }
    await rm(join(repos.fixWorktree, '../..'), { recursive: true, force: true }).catch(() => {});
  });

  it('removes the sub-worktree directory and deletes the branch', async () => {
    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);

    await removeSubWorktree(repos.local, sub.path, sub.branch);

    // Worktree directory should be gone
    const { stat } = await import('node:fs/promises');
    await expect(stat(sub.path)).rejects.toThrow();

    // Branch should be gone
    const branches = (await $`git -C ${repos.local} branch`).stdout;
    expect(branches).not.toContain('kova/fix-42-piece-0');
  });

  it('handles already-removed worktree gracefully', async () => {
    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);
    await $`git -C ${repos.local} worktree remove ${sub.path} --force`;

    // Should not throw
    await expect(removeSubWorktree(repos.local, sub.path, sub.branch)).resolves.toBeUndefined();
  });

  it('handles already-removed branch gracefully', async () => {
    const sub = await createSubWorktree(repos.fixWorktree, repos.issueNumber, 0);
    await $`git -C ${repos.local} worktree remove ${sub.path} --force`;
    await $`git -C ${repos.local} branch -D ${sub.branch}`;

    // Should not throw
    await expect(removeSubWorktree(repos.local, sub.path, sub.branch)).resolves.toBeUndefined();
  });
});

/**
 * Creates a bare remote + cloned local + feature branch worktree
 * to mirror kova's real workflow for commitAndPush tests.
 */
async function setupCommitRepos(): Promise<{
  remote: string;
  local: string;
  worktree: string;
  branch: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-cap-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const wt = join(base, 'worktree');
  const branch = 'kova/fix-42';

  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;
  await writeFile(join(local, 'README.md'), '# Test repo\n');
  await $`git -C ${local} add README.md`;
  await $`git -C ${local} commit -m "init"`;
  await $`git -C ${local} push origin main`;

  await $`git -C ${local} branch ${branch}`;
  await $`git -C ${local} worktree add ${wt} ${branch}`;
  await $`git -C ${wt} config user.email "test@kova.dev"`;
  await $`git -C ${wt} config user.name "Kova Test"`;

  return { remote, local, worktree: wt, branch };
}

describe('commitAndPush', () => {
  let repos: Awaited<ReturnType<typeof setupCommitRepos>>;

  beforeEach(async () => {
    repos = await setupCommitRepos();
  });

  afterEach(async () => {
    try {
      await $`git -C ${repos.local} worktree remove ${repos.worktree} --force`;
    } catch {
      // best effort
    }
    await rm(join(repos.worktree, '..'), { recursive: true, force: true }).catch(() => {});
  });

  it('stages changed files, commits with conventional message, and pushes', async () => {
    await writeFile(join(repos.worktree, 'fix.ts'), 'export const fix = true;\n');
    await writeFile(join(repos.worktree, 'helper.ts'), 'export const helper = true;\n');

    const result = await commitAndPush(repos.worktree, repos.branch, {
      number: 42,
      title: 'Ship wave: git stage, commit, push',
    });

    expect(result.committed).toBe(true);
    expect(result.filesStaged).toContain('fix.ts');
    expect(result.filesStaged).toContain('helper.ts');
    expect(result.commitMessage).toBe('fix: Ship wave: git stage, commit, push (#42)');

    // Verify pushed to remote
    const remoteLog = await $`git -C ${repos.remote} log --oneline ${repos.branch}`;
    expect(remoteLog.stdout).toContain('fix: Ship wave: git stage, commit, push (#42)');
  });

  it('handles modified files alongside new files', async () => {
    await writeFile(join(repos.worktree, 'README.md'), '# Updated\n');
    await writeFile(join(repos.worktree, 'new.ts'), 'export {};\n');

    const result = await commitAndPush(repos.worktree, repos.branch, {
      number: 7,
      title: 'Add feature',
    });

    expect(result.committed).toBe(true);
    expect(result.filesStaged).toContain('README.md');
    expect(result.filesStaged).toContain('new.ts');
  });

  it('returns no-op when no files changed', async () => {
    const result = await commitAndPush(repos.worktree, repos.branch, {
      number: 99,
      title: 'Nothing changed',
    });

    expect(result.committed).toBe(false);
    expect(result.filesStaged).toEqual([]);
  });

  it('stages files in subdirectories', async () => {
    await $`mkdir -p ${join(repos.worktree, 'src', 'services')}`;
    await writeFile(join(repos.worktree, 'src', 'services', 'deep.ts'), 'export {};\n');

    const result = await commitAndPush(repos.worktree, repos.branch, {
      number: 10,
      title: 'Deep file',
    });

    expect(result.committed).toBe(true);
    expect(result.filesStaged).toContain('src/services/deep.ts');
  });
});

/**
 * Creates a bare remote + cloned local + feature branch worktree
 * with independent commit history for rebase testing.
 */
async function setupRebaseRepos(): Promise<{
  remote: string;
  local: string;
  worktree: string;
  branch: string;
  base: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-rebase-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const wt = join(base, 'worktree');
  const branch = 'kova/fix-61';

  // Set up bare remote and clone
  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;
  await writeFile(join(local, 'README.md'), '# Test repo\n');
  await $`git -C ${local} add README.md`;
  await $`git -C ${local} commit -m "init"`;
  await $`git -C ${local} push origin main`;

  // Create fix branch and worktree from main
  await $`git -C ${local} branch ${branch}`;
  await $`git -C ${local} worktree add ${wt} ${branch}`;
  await $`git -C ${wt} config user.email "test@kova.dev"`;
  await $`git -C ${wt} config user.name "Kova Test"`;

  return { remote, local, worktree: wt, branch, base };
}

describe('rebaseOnDefault', () => {
  let repos: Awaited<ReturnType<typeof setupRebaseRepos>>;

  beforeEach(async () => {
    repos = await setupRebaseRepos();
  });

  afterEach(async () => {
    try {
      await $`git -C ${repos.local} worktree remove ${repos.worktree} --force`;
    } catch {
      // best effort
    }
    await rm(repos.base, { recursive: true, force: true }).catch(() => {});
  });

  it('rebases cleanly when main has new commits', async () => {
    // Add a commit on the fix branch
    await writeFile(join(repos.worktree, 'fix.ts'), 'export const fix = true;\n');
    await $`git -C ${repos.worktree} add fix.ts`;
    await $`git -C ${repos.worktree} commit -m "fix commit"`;

    // Advance main with a non-conflicting commit and push to remote
    await $`git -C ${repos.local} checkout main`;
    await writeFile(join(repos.local, 'other.ts'), 'export const other = true;\n');
    await $`git -C ${repos.local} add other.ts`;
    await $`git -C ${repos.local} commit -m "advance main"`;
    await $`git -C ${repos.local} push origin main`;
    await $`git -C ${repos.local} checkout -`; // back to previous branch

    const result = await rebaseOnDefault(repos.worktree);

    expect(result.success).toBe(true);
    expect(result.conflicted).toBe(false);

    // Verify the fix branch now includes the main advance commit
    const log = (await $`git -C ${repos.worktree} log --oneline`).stdout;
    expect(log).toContain('advance main');
    expect(log).toContain('fix commit');
  });

  it('succeeds as no-op when branch is already up to date', async () => {
    // No new commits on main — branch is already based on latest main
    const result = await rebaseOnDefault(repos.worktree);

    expect(result.success).toBe(true);
    expect(result.conflicted).toBe(false);
  });

  it('returns conflict info when rebase has conflicts', async () => {
    // Create conflicting changes: modify README.md on both branches
    await writeFile(join(repos.worktree, 'README.md'), '# Fix branch version\n');
    await $`git -C ${repos.worktree} add README.md`;
    await $`git -C ${repos.worktree} commit -m "fix: modify readme"`;

    // Advance main with a conflicting change to the same file
    await $`git -C ${repos.local} checkout main`;
    await writeFile(join(repos.local, 'README.md'), '# Main branch version\n');
    await $`git -C ${repos.local} add README.md`;
    await $`git -C ${repos.local} commit -m "main: modify readme"`;
    await $`git -C ${repos.local} push origin main`;
    await $`git -C ${repos.local} checkout -`;

    const result = await rebaseOnDefault(repos.worktree);

    expect(result.success).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.conflictFiles).toBeDefined();
    expect(result.conflictFiles?.length).toBeGreaterThan(0);
    expect(result.conflictFiles).toContain('README.md');
  });

  it('leaves working tree clean after conflict (rebase is aborted)', async () => {
    // Create conflicting changes
    await writeFile(join(repos.worktree, 'README.md'), '# Fix branch version\n');
    await $`git -C ${repos.worktree} add README.md`;
    await $`git -C ${repos.worktree} commit -m "fix: modify readme"`;

    await $`git -C ${repos.local} checkout main`;
    await writeFile(join(repos.local, 'README.md'), '# Main branch version\n');
    await $`git -C ${repos.local} add README.md`;
    await $`git -C ${repos.local} commit -m "main: modify readme"`;
    await $`git -C ${repos.local} push origin main`;
    await $`git -C ${repos.local} checkout -`;

    await rebaseOnDefault(repos.worktree);

    // Verify no rebase is in progress (git status should be clean)
    const status = (await $`git -C ${repos.worktree} status --porcelain`).stdout.trim();
    expect(status).toBe('');

    // Verify we're not in a rebase state
    const rebaseDir = join(repos.worktree, '.git', 'rebase-merge');
    const { stat } = await import('node:fs/promises');
    await expect(stat(rebaseDir)).rejects.toThrow();
  });
});
