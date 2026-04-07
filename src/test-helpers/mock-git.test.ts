import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockTestRunner, createMockWorktreeFns, createTempRepo, type TempRepo } from './mock-git.js';

describe('createTempRepo', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('creates a directory with git initialized', async () => {
    repo = await createTempRepo();

    const gitDir = await stat(join(repo.path, '.git'));
    expect(gitDir.isDirectory()).toBe(true);
  });

  it('has at least one commit (HEAD exists)', async () => {
    repo = await createTempRepo();

    const { $ } = await import('zx');
    $.verbose = false;
    const result = await $({ cwd: repo.path })`git log --oneline -1`;
    expect(result.stdout.trim()).toContain('initial commit');
  });

  it('cleanup removes the directory', async () => {
    repo = await createTempRepo();
    const repoPath = repo.path;

    await repo.cleanup();
    repo = undefined;

    await expect(stat(repoPath)).rejects.toThrow();
  });
});

describe('createMockWorktreeFns', () => {
  it('returns createWorktree, removeWorktree, commitAndPush mocks', () => {
    const fns = createMockWorktreeFns();
    expect(fns.createWorktree).toBeTypeOf('function');
    expect(fns.removeWorktree).toBeTypeOf('function');
    expect(fns.commitAndPush).toBeTypeOf('function');
  });

  it('createWorktree resolves with path and branch', async () => {
    const fns = createMockWorktreeFns('/custom/path');
    const result = (await fns.createWorktree('/repo', 42)) as { path: string; branch: string };
    expect(result.path).toBe('/custom/path');
    expect(result.branch).toBe('kova/fix-1');
  });

  it('commitAndPush resolves with committed: true by default', async () => {
    const fns = createMockWorktreeFns();
    const result = (await fns.commitAndPush('/repo')) as { committed: boolean };
    expect(result.committed).toBe(true);
  });

  it('reset() clears all mock state', async () => {
    const fns = createMockWorktreeFns();
    await fns.createWorktree('/repo', 1);
    await fns.commitAndPush('/repo');

    fns.reset();

    expect(fns.createWorktree.mock.calls).toHaveLength(0);
    expect(fns.commitAndPush.mock.calls).toHaveLength(0);
  });
});

describe('createMockTestRunner', () => {
  it('returns passing result by default', async () => {
    const runner = createMockTestRunner();
    const result = (await runner()) as { passed: boolean; output: string; exitCode: number };

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('accepts custom result', async () => {
    const runner = createMockTestRunner({ passed: false, output: '2 failing', exitCode: 1 });
    const result = (await runner()) as { passed: boolean; output: string; exitCode: number };

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('2 failing');
  });
});
