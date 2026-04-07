import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $ } from 'zx';
import type { SubWorktree } from '../services/worktree.js';
import type { TestRunner } from './loops.js';
import { mergePiecesSequentially } from './piece-merger.js';

$.verbose = false;

/**
 * Sets up a bare remote + cloned local + fix worktree + N piece sub-worktrees,
 * each with their own committed changes. Mirrors kova's real workflow.
 */
async function setupMergeScenario(opts: {
  pieceCount: number;
  /** Function to create files in each piece worktree (called with piece path and index) */
  pieceSetup?: (piecePath: string, index: number) => Promise<void>;
  /** Create a conflict between two pieces on the same file */
  conflictBetween?: [number, number];
}): Promise<{
  base: string;
  remote: string;
  local: string;
  fixWorktree: string;
  fixBranch: string;
  pieces: SubWorktree[];
  issueNumber: number;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-merge-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const fixWtDir = join(base, '.kova-worktrees');
  const issueNumber = 42;
  const fixBranch = `kova/fix-${issueNumber}`;
  const fixWorktree = join(fixWtDir, `fix-${issueNumber}`);

  // Init bare remote + clone
  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;
  await writeFile(join(local, 'README.md'), '# Test repo\n');
  await $`git -C ${local} add README.md`;
  await $`git -C ${local} commit -m "init on main"`;
  await $`git -C ${local} push origin main`;

  // Create fix branch + worktree
  await $`git -C ${local} branch ${fixBranch}`;
  await mkdir(fixWtDir, { recursive: true });
  await $`git -C ${local} worktree add ${fixWorktree} ${fixBranch}`;
  await $`git -C ${fixWorktree} config user.email "test@kova.dev"`;
  await $`git -C ${fixWorktree} config user.name "Kova Test"`;

  // Create piece sub-worktrees with committed changes
  const pieces: SubWorktree[] = [];
  for (let i = 0; i < opts.pieceCount; i++) {
    const pieceBranch = `kova/fix-${issueNumber}-piece-${i}`;
    const piecePath = join(fixWtDir, `fix-${issueNumber}-piece-${i}`);

    await $`git -C ${local} branch ${pieceBranch} ${fixBranch}`;
    await $`git -C ${local} worktree add ${piecePath} ${pieceBranch}`;
    await $`git -C ${piecePath} config user.email "test@kova.dev"`;
    await $`git -C ${piecePath} config user.name "Kova Test"`;

    if (opts.pieceSetup) {
      await opts.pieceSetup(piecePath, i);
    } else {
      // Default: each piece creates a unique file
      await writeFile(join(piecePath, `piece-${i}.ts`), `export const piece${i} = true;\n`);
      await $`git -C ${piecePath} add piece-${i}.ts`;
      await $`git -C ${piecePath} commit -m "piece ${i} implementation"`;
    }

    pieces.push({ path: piecePath, branch: pieceBranch });
  }

  // Create conflict scenario if requested
  if (opts.conflictBetween) {
    const [a, b] = opts.conflictBetween;
    const pieceA = pieces[a];
    const pieceB = pieces[b];
    if (!pieceA || !pieceB) throw new Error('Invalid conflict indices');
    const conflictFile = 'shared.ts';

    await writeFile(join(pieceA.path, conflictFile), `export const shared = 'from piece ${a}';\n`);
    await $`git -C ${pieceA.path} add ${conflictFile}`;
    await $`git -C ${pieceA.path} commit -m "piece ${a}: add shared"`;

    await writeFile(join(pieceB.path, conflictFile), `export const shared = 'from piece ${b}';\n`);
    await $`git -C ${pieceB.path} add ${conflictFile}`;
    await $`git -C ${pieceB.path} commit -m "piece ${b}: add shared (conflicting)"`;
  }

  return { base, remote, local, fixWorktree, fixBranch, pieces, issueNumber };
}

describe('mergePiecesSequentially', () => {
  let repos: Awaited<ReturnType<typeof setupMergeScenario>>;
  let passingTestRunner: TestRunner;
  let failingTestRunner: TestRunner;

  beforeEach(() => {
    passingTestRunner = vi.fn<TestRunner>().mockResolvedValue({
      passed: true,
      output: 'All tests passed',
      exitCode: 0,
    });
    failingTestRunner = vi.fn<TestRunner>().mockResolvedValue({
      passed: false,
      output: 'Test failed: shared module conflict',
      exitCode: 1,
    });
  });

  afterEach(async () => {
    if (repos?.base) {
      await rm(repos.base, { recursive: true, force: true });
    }
  });

  it('merges a single piece into the fix branch', async () => {
    repos = await setupMergeScenario({ pieceCount: 1 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    expect(result.success).toBe(true);
    expect(result.mergedPieces).toHaveLength(1);
    expect(result.mergedPieces[0]?.pieceIndex).toBe(0);
    expect(result.mergedPieces[0]?.success).toBe(true);
    expect(result.failedPieces).toHaveLength(0);

    // Verify file exists in fix worktree after merge
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(repos.fixWorktree, 'piece-0.ts'))).resolves.toBeTruthy();
  });

  it('merges multiple pieces in dependency order', async () => {
    repos = await setupMergeScenario({ pieceCount: 3 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0], [1, 2]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    expect(result.success).toBe(true);
    expect(result.mergedPieces).toHaveLength(3);
    expect(result.failedPieces).toHaveLength(0);

    // All piece files should be in the fix worktree
    const { stat } = await import('node:fs/promises');
    for (let i = 0; i < 3; i++) {
      await expect(stat(join(repos.fixWorktree, `piece-${i}.ts`))).resolves.toBeTruthy();
    }
  });

  it('runs test suite after each merge', async () => {
    repos = await setupMergeScenario({ pieceCount: 2 });
    const testRunner = vi.fn<TestRunner>().mockResolvedValue({
      passed: true,
      output: 'ok',
      exitCode: 0,
    });

    await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0], [1]],
      testCommand: 'npm test',
      testRunner,
    });

    // Test runner called once per piece merge
    expect(testRunner).toHaveBeenCalledTimes(2);
    expect(testRunner).toHaveBeenCalledWith('npm test', repos.fixWorktree);
  });

  it('handles merge conflict — aborts, retries last, marks failed', async () => {
    repos = await setupMergeScenario({
      pieceCount: 2,
      conflictBetween: [0, 1],
    });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0, 1]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    // Piece 0 should merge fine, piece 1 conflicts
    expect(result.mergedPieces.some((p) => p.pieceIndex === 0 && p.success)).toBe(true);
    expect(result.failedPieces).toHaveLength(1);
    expect(result.failedPieces[0]?.pieceIndex).toBe(1);
    expect(result.failedPieces[0]?.error).toContain('conflict');
  });

  it('marks piece as failed when tests fail after merge', async () => {
    repos = await setupMergeScenario({ pieceCount: 2 });

    // First merge: pass. Second merge: fail.
    const testRunner = vi
      .fn<TestRunner>()
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: integration broke', exitCode: 1 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0], [1]],
      testCommand: 'npm test',
      testRunner,
    });

    expect(result.mergedPieces.some((p) => p.pieceIndex === 0 && p.success)).toBe(true);
    expect(result.failedPieces).toHaveLength(1);
    expect(result.failedPieces[0]?.pieceIndex).toBe(1);
    expect(result.failedPieces[0]?.error).toContain('Tests failed');
  });

  it('cleans up sub-worktrees after merge (success)', async () => {
    repos = await setupMergeScenario({ pieceCount: 2 });

    await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0, 1]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    // Sub-worktree directories should be removed
    const { stat } = await import('node:fs/promises');
    for (const piece of repos.pieces) {
      await expect(stat(piece.path)).rejects.toThrow();
    }
  });

  it('cleans up sub-worktrees after merge (with failures)', async () => {
    repos = await setupMergeScenario({
      pieceCount: 2,
      conflictBetween: [0, 1],
    });

    await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0, 1]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    // All sub-worktrees cleaned up regardless of success
    const { stat } = await import('node:fs/promises');
    for (const piece of repos.pieces) {
      await expect(stat(piece.path)).rejects.toThrow();
    }
  });

  it('reports failed pieces in result', async () => {
    repos = await setupMergeScenario({
      pieceCount: 3,
      conflictBetween: [1, 2],
    });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0], [1, 2]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    // Piece 0 and one of 1/2 merge, the other conflicts
    expect(result.mergedPieces.length + result.failedPieces.length).toBe(3);
    expect(result.failedPieces.length).toBeGreaterThanOrEqual(1);
    // Each failed piece has conflicting files info
    for (const fp of result.failedPieces) {
      expect(fp.error).toBeDefined();
    }
  });

  it('retries conflicting piece after other pieces in batch', async () => {
    repos = await setupMergeScenario({
      pieceCount: 2,
      conflictBetween: [0, 1],
    });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0, 1]],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    // First piece in the batch merges, second still conflicts after retry
    const totalProcessed = result.mergedPieces.length + result.failedPieces.length;
    expect(totalProcessed).toBe(2);
  });

  it('handles empty pieces array', async () => {
    repos = await setupMergeScenario({ pieceCount: 0 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: [],
      dependencyOrder: [],
      testCommand: 'echo "tests pass"',
      testRunner: passingTestRunner,
    });

    expect(result.success).toBe(true);
    expect(result.mergedPieces).toHaveLength(0);
    expect(result.failedPieces).toHaveLength(0);
  });

  it('reverts merge when tests fail', async () => {
    repos = await setupMergeScenario({ pieceCount: 1 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0]],
      testCommand: 'npm test',
      testRunner: failingTestRunner,
    });

    expect(result.failedPieces).toHaveLength(1);

    // The fix branch should NOT contain the piece's file (merge reverted)
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(repos.fixWorktree, 'piece-0.ts'))).rejects.toThrow();
  });

  it('overall success is false when any piece fails', async () => {
    repos = await setupMergeScenario({ pieceCount: 2 });

    const testRunner = vi
      .fn<TestRunner>()
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL', exitCode: 1 });

    const result = await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0], [1]],
      testCommand: 'npm test',
      testRunner,
    });

    expect(result.success).toBe(false);
  });
});

describe('mergePiecesSequentially — mergeSubWorktree integration', () => {
  let repos: Awaited<ReturnType<typeof setupMergeScenario>>;

  afterEach(async () => {
    if (repos?.base) {
      await rm(repos.base, { recursive: true, force: true });
    }
  });

  it('uses git merge --no-ff for merge commits', async () => {
    repos = await setupMergeScenario({ pieceCount: 1 });

    await mergePiecesSequentially({
      fixWorktreePath: repos.fixWorktree,
      repoPath: repos.local,
      pieces: repos.pieces,
      dependencyOrder: [[0]],
      testCommand: 'echo "tests pass"',
      testRunner: vi.fn<TestRunner>().mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 }),
    });

    // The merge commit should be a merge commit (2 parents)
    const log = (await $`git -C ${repos.fixWorktree} log --oneline --merges -1`).stdout.trim();
    expect(log).toContain('piece-0');
  });
});
