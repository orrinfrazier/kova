/**
 * Git mock helpers for worktree operations in tests.
 *
 * Provides utilities to create temporary git repos with commits,
 * mock worktree create/remove functions, and common git operation stubs.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Temporary git repo — real filesystem with `git init` + initial commit
// ---------------------------------------------------------------------------

export interface TempRepo {
  path: string;
  /** Remove the temp repo from disk. Call in afterEach. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary directory with `git init` and an initial commit.
 * Useful for tests that need a real git repo without hitting a remote.
 */
export async function createTempRepo(): Promise<TempRepo> {
  const { $ } = await import('zx');
  const path = await mkdtemp(join(tmpdir(), 'kova-test-repo-'));

  // Suppress zx output
  $.verbose = false;

  await $({ cwd: path })`git init`;
  await $({ cwd: path })`git config user.email test@kova.dev`;
  await $({ cwd: path })`git config user.name kova-test`;

  // Need at least one commit for worktree operations
  await writeFile(join(path, 'README.md'), '# Test Repo\n');
  await $({ cwd: path })`git add .`;
  await $({ cwd: path })`git commit -m ${'chore: initial commit'}`;

  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Mock worktree functions — drop-in replacements for vi.mock('../services/worktree.js')
// ---------------------------------------------------------------------------

export interface MockWorktreeFns {
  createWorktree: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  commitAndPush: ReturnType<typeof vi.fn>;
  /** Reset all mock state. */
  reset: () => void;
}

/**
 * Creates mock functions for the worktree service.
 * Call `worktree.createWorktree.mockResolvedValue(...)` to configure per-test.
 */
export function createMockWorktreeFns(workDir?: string): MockWorktreeFns {
  const createWorktree = vi.fn().mockResolvedValue({
    path: workDir ?? '/tmp/kova-worktree',
    branch: 'kova/fix-1',
  });

  const removeWorktree = vi.fn().mockResolvedValue(undefined);

  const commitAndPush = vi.fn().mockResolvedValue({
    committed: true,
    filesStaged: ['src/handler.ts', 'src/handler.test.ts'],
    commitMessage: 'fix: Test issue (#1)',
  });

  return {
    createWorktree,
    removeWorktree,
    commitAndPush,
    reset() {
      createWorktree.mockClear();
      removeWorktree.mockClear();
      commitAndPush.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Mock test runner — always-passing by default
// ---------------------------------------------------------------------------

export function createMockTestRunner(
  result: { passed: boolean; output: string; exitCode: number } = {
    passed: true,
    output: 'All tests pass',
    exitCode: 0,
  },
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result);
}
