import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { resolveConflicts } from './conflict-resolver.js';

$.verbose = false;

/**
 * Creates a bare remote + cloned local with conflicting changes on main
 * and a fix branch, ready for rebase conflict resolution testing.
 */
async function setupConflictRepos(opts?: {
  extraFiles?: Array<{ name: string; baseContent: string; mainContent: string; branchContent: string }>;
}): Promise<{
  remote: string;
  local: string;
  branch: string;
  conflictFile: string;
  base: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-conflict-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const branch = 'kova/fix-99';

  // Set up bare remote and clone
  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;

  // Initial commit with data.ts on main
  const baseContent = ['// Section A', 'export const a = 1;', '', '// Section B', 'export const b = 2;', ''].join('\n');
  await writeFile(join(local, 'data.ts'), baseContent);
  await $`git -C ${local} add data.ts`;

  // Write any extra files in the initial commit
  if (opts?.extraFiles) {
    for (const f of opts.extraFiles) {
      await writeFile(join(local, f.name), f.baseContent);
      await $`git -C ${local} add ${f.name}`;
    }
  }

  await $`git -C ${local} commit -m "initial commit with data.ts"`;
  await $`git -C ${local} push origin main`;

  // Create the fix branch from this initial commit
  await $`git -C ${local} branch ${branch}`;

  // Now make a change on main (modify Section B)
  const mainContent = [
    '// Section A',
    'export const a = 1;',
    '',
    '// Section B',
    'export const b = 42; // changed on main',
    '',
  ].join('\n');
  await writeFile(join(local, 'data.ts'), mainContent);
  await $`git -C ${local} add data.ts`;

  if (opts?.extraFiles) {
    for (const f of opts.extraFiles) {
      await writeFile(join(local, f.name), f.mainContent);
      await $`git -C ${local} add ${f.name}`;
    }
  }

  await $`git -C ${local} commit -m "main: update section B"`;
  await $`git -C ${local} push origin main`;

  // Switch to fix branch and make a conflicting change (modify Section A)
  await $`git -C ${local} checkout ${branch}`;
  const branchContent = [
    '// Section A',
    'export const a = 100; // changed on fix branch',
    '',
    '// Section B',
    'export const b = 2;',
    '',
  ].join('\n');
  await writeFile(join(local, 'data.ts'), branchContent);
  await $`git -C ${local} add data.ts`;

  if (opts?.extraFiles) {
    for (const f of opts.extraFiles) {
      await writeFile(join(local, f.name), f.branchContent);
      await $`git -C ${local} add ${f.name}`;
    }
  }

  await $`git -C ${local} commit -m "fix: change section A"`;

  return { remote, local, branch, conflictFile: 'data.ts', base };
}

/**
 * Creates a repo where both branches modify the exact same line, producing
 * a true conflict that cannot be auto-resolved.
 */
async function setupTrueConflictRepos(): Promise<{
  remote: string;
  local: string;
  branch: string;
  conflictFile: string;
  base: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-conflict-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const branch = 'kova/fix-99';

  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;

  // Initial commit
  await writeFile(join(local, 'data.ts'), 'export const value = "original";\n');
  await $`git -C ${local} add data.ts`;
  await $`git -C ${local} commit -m "initial commit"`;
  await $`git -C ${local} push origin main`;

  // Create fix branch from this point
  await $`git -C ${local} branch ${branch}`;

  // Change the same line on main
  await writeFile(join(local, 'data.ts'), 'export const value = "changed-on-main";\n');
  await $`git -C ${local} add data.ts`;
  await $`git -C ${local} commit -m "main: change value"`;
  await $`git -C ${local} push origin main`;

  // Change the same line on fix branch
  await $`git -C ${local} checkout ${branch}`;
  await writeFile(join(local, 'data.ts'), 'export const value = "changed-on-fix-branch";\n');
  await $`git -C ${local} add data.ts`;
  await $`git -C ${local} commit -m "fix: change value differently"`;

  return { remote, local, branch, conflictFile: 'data.ts', base };
}

describe('resolveConflicts', () => {
  let base: string;

  afterEach(async () => {
    if (base) {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('resolves simple non-overlapping conflicts', async () => {
    // Sections A and B are modified on different branches -- non-overlapping
    const repos = await setupConflictRepos();
    base = repos.base;

    const result = await resolveConflicts(repos.local, 'main');

    expect(result.resolved).toBe(true);
    expect(result).toHaveProperty('filesResolved');
    expect((result as { resolved: true; filesResolved: string[] }).filesResolved).toContain('data.ts');

    // Working tree should be clean after resolution
    const status = (await $`git -C ${repos.local} status --porcelain`).stdout.trim();
    expect(status).toBe('');

    // No rebase should be in progress
    await expect($`git -C ${repos.local} rebase --show-current-patch`).rejects.toThrow();
  });

  it('returns unresolved for truly conflicting overlapping edits', async () => {
    const repos = await setupTrueConflictRepos();
    base = repos.base;

    const result = await resolveConflicts(repos.local, 'main');

    expect(result.resolved).toBe(false);
    expect(result).toHaveProperty('filesUnresolved');
    expect((result as { resolved: false; filesUnresolved: string[] }).filesUnresolved).toContain('data.ts');
  });

  it('aborts rebase after failed resolution, leaving clean working tree', async () => {
    const repos = await setupTrueConflictRepos();
    base = repos.base;

    await resolveConflicts(repos.local, 'main');

    // .git/rebase-merge should NOT exist (rebase was aborted)
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(repos.local, '.git', 'rebase-merge'))).rejects.toThrow();

    // Working tree should be clean
    const status = (await $`git -C ${repos.local} status --porcelain`).stdout.trim();
    expect(status).toBe('');
  });

  it('handles multiple conflicting files', async () => {
    const repos = await setupConflictRepos({
      extraFiles: [
        {
          name: 'config.ts',
          baseContent: 'export const config = { port: 3000 };\n',
          mainContent: 'export const config = { port: 8080 };\n',
          branchContent: 'export const config = { port: 3000, debug: true };\n',
        },
      ],
    });
    base = repos.base;

    const result = await resolveConflicts(repos.local, 'main');

    // Whether resolved or not, the response should reference both files
    if (result.resolved) {
      const resolved = (result as { resolved: true; filesResolved: string[] }).filesResolved;
      expect(resolved).toContain('data.ts');
      expect(resolved).toContain('config.ts');
      expect(resolved.length).toBeGreaterThanOrEqual(2);
    } else {
      const unresolved = (result as { resolved: false; filesUnresolved: string[] }).filesUnresolved;
      expect(unresolved.length).toBeGreaterThanOrEqual(1);
      // At least one of the two files should appear
      const allFiles = [...unresolved];
      expect(allFiles.includes('data.ts') || allFiles.includes('config.ts')).toBe(true);
    }
  });
});
