import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { checkForConflicts } from './conflict-check.js';

$.verbose = false;

/**
 * Creates a bare remote + cloned local with diverged branches.
 * `mainDelta` and `branchDelta` control which files are modified on each side.
 */
async function setupRepos(opts: {
  files: Array<{
    name: string;
    base: string;
    main?: string;
    branch?: string;
  }>;
}): Promise<{
  remote: string;
  local: string;
  branch: string;
  base: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'kova-cc-'));
  const remote = join(base, 'remote.git');
  const local = join(base, 'local');
  const branch = 'kova/fix-220';

  // Init bare remote + clone
  await $`git init --bare ${remote}`;
  await $`git clone ${remote} ${local}`;
  await $`git -C ${local} config user.email "test@kova.dev"`;
  await $`git -C ${local} config user.name "Kova Test"`;

  // Initial commit with all files
  for (const f of opts.files) {
    await writeFile(join(local, f.name), f.base);
    await $`git -C ${local} add ${f.name}`;
  }
  await $`git -C ${local} commit -m "initial commit"`;
  await $`git -C ${local} push origin main`;

  // Create fix branch from this point
  await $`git -C ${local} branch ${branch}`;

  // Make changes on main (only files with main delta)
  const mainFiles = opts.files.filter((f) => f.main != null);
  if (mainFiles.length > 0) {
    for (const f of mainFiles) {
      await writeFile(join(local, f.name), f.main!);
      await $`git -C ${local} add ${f.name}`;
    }
    await $`git -C ${local} commit -m "main: updates"`;
    await $`git -C ${local} push origin main`;
  }

  // Switch to fix branch and make changes
  await $`git -C ${local} checkout ${branch}`;
  const branchFiles = opts.files.filter((f) => f.branch != null);
  if (branchFiles.length > 0) {
    for (const f of branchFiles) {
      await writeFile(join(local, f.name), f.branch!);
      await $`git -C ${local} add ${f.name}`;
    }
    await $`git -C ${local} commit -m "fix: branch changes"`;
  }

  return { remote, local, branch, base };
}

describe('checkForConflicts', () => {
  let base: string;

  afterEach(async () => {
    if (base) {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns no conflicts when branches have no overlapping changes', async () => {
    const repos = await setupRepos({
      files: [
        { name: 'a.ts', base: 'const a = 1;\n', main: 'const a = 2;\n' },
        { name: 'b.ts', base: 'const b = 1;\n', branch: 'const b = 2;\n' },
      ],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    expect(result.hasConflicts).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it('detects conflicts when both branches modify the same file', async () => {
    const repos = await setupRepos({
      files: [
        {
          name: 'data.ts',
          base: 'export const value = "original";\n',
          main: 'export const value = "main-change";\n',
          branch: 'export const value = "branch-change";\n',
        },
      ],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toContain('data.ts');
  });

  it('leaves working tree clean after conflict detection (merge --abort)', async () => {
    const repos = await setupRepos({
      files: [
        {
          name: 'data.ts',
          base: 'export const value = "original";\n',
          main: 'export const value = "main-change";\n',
          branch: 'export const value = "branch-change";\n',
        },
      ],
    });
    base = repos.base;

    await checkForConflicts(repos.local);

    // Working tree should be clean
    const status = (await $`git -C ${repos.local} status --porcelain`).stdout.trim();
    expect(status).toBe('');

    // No merge in progress
    const mergeHead = await $`git -C ${repos.local} rev-parse --verify MERGE_HEAD`.nothrow();
    expect(mergeHead.exitCode).not.toBe(0);
  });

  it('categorizes conflicts: overlapping (in specFiles) vs non-overlapping', async () => {
    const repos = await setupRepos({
      files: [
        {
          name: 'our-file.ts',
          base: 'export const x = 1;\n',
          main: 'export const x = 99;\n',
          branch: 'export const x = 42;\n',
        },
        {
          name: 'their-file.ts',
          base: 'export const y = 1;\n',
          main: 'export const y = 99;\n',
          branch: 'export const y = 42;\n',
        },
      ],
    });
    base = repos.base;

    const specFiles = ['our-file.ts'];
    const result = await checkForConflicts(repos.local, specFiles);

    expect(result.hasConflicts).toBe(true);
    expect(result.overlapping).toContain('our-file.ts');
    expect(result.nonOverlapping).toContain('their-file.ts');
  });

  it('returns no conflicts when branches have not diverged', async () => {
    const repos = await setupRepos({
      files: [{ name: 'a.ts', base: 'const a = 1;\n', branch: 'const a = 2;\n' }],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    expect(result.hasConflicts).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it('detects conflicts across multiple files', async () => {
    const repos = await setupRepos({
      files: [
        {
          name: 'a.ts',
          base: 'const a = 1;\n',
          main: 'const a = 100;\n',
          branch: 'const a = 200;\n',
        },
        {
          name: 'b.ts',
          base: 'const b = 1;\n',
          main: 'const b = 100;\n',
          branch: 'const b = 200;\n',
        },
        { name: 'c.ts', base: 'const c = 1;\n', branch: 'const c = 2;\n' },
      ],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toContain('a.ts');
    expect(result.conflictingFiles).toContain('b.ts');
    expect(result.conflictingFiles).not.toContain('c.ts');
  });

  it('handles merge that succeeds (auto-merged) — no conflicts', async () => {
    // Non-overlapping regions within the same file
    const repos = await setupRepos({
      files: [
        {
          name: 'data.ts',
          base: '// Section A\nexport const a = 1;\n\n// Section B\nexport const b = 2;\n',
          main: '// Section A\nexport const a = 1;\n\n// Section B\nexport const b = 42;\n',
          branch: '// Section A\nexport const a = 100;\n\n// Section B\nexport const b = 2;\n',
        },
      ],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    // Git can auto-merge non-overlapping changes within the same file
    expect(result.hasConflicts).toBe(false);
  });
});
