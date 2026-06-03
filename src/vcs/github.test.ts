import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { branchExistsOnRemote } from './github.js';

$.verbose = false;

describe('branchExistsOnRemote', () => {
  let repoPath: string;
  let remotePath: string;

  beforeEach(async () => {
    remotePath = await mkdtemp(join(tmpdir(), 'kova-remote-'));
    await $`git -C ${remotePath} init --bare -b main`;

    repoPath = await mkdtemp(join(tmpdir(), 'kova-test-'));
    await $`git clone ${remotePath} ${repoPath}`;
    await $`git -C ${repoPath} config user.email "test@kova.dev"`;
    await $`git -C ${repoPath} config user.name "Kova Test"`;
    await $`git -C ${repoPath} commit --allow-empty -m "init"`;
    await $`git -C ${repoPath} push origin main`;
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(remotePath, { recursive: true, force: true });
  });

  it('returns true when remote branch exists', async () => {
    await $`git -C ${repoPath} push origin main:kova/fix-42`;
    const result = await branchExistsOnRemote(repoPath, 'kova/fix-42');
    expect(result).toBe(true);
  });

  it('returns false when remote branch does not exist', async () => {
    const result = await branchExistsOnRemote(repoPath, 'kova/fix-999');
    expect(result).toBe(false);
  });
});
