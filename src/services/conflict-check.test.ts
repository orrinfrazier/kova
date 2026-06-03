import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { type ConflictDependencyLookup, checkForConflicts } from './conflict-check.js';

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

// --- Dependency-overlap surfacing (#276) ---

describe('checkForConflicts — dependency overlaps (#276)', () => {
  let base: string;

  afterEach(async () => {
    if (base) {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns dependencyOverlaps = [] when no lookup is provided (back-compat)', async () => {
    const repos = await setupRepos({
      files: [{ name: 'a.ts', base: 'export const a = 1;\n', branch: 'export const a = 2;\n' }],
    });
    base = repos.base;

    const result = await checkForConflicts(repos.local);

    expect(result.dependencyOverlaps).toEqual([]);
  });

  it('returns dependencyOverlaps = [] when lookup yields no dependents', async () => {
    const repos = await setupRepos({
      files: [{ name: 'a.ts', base: 'export const a = 1;\n', branch: 'export const a = 2;\n' }],
    });
    base = repos.base;

    const emptyLookup: ConflictDependencyLookup = {
      listFileSymbols: () => [],
      getFileDependents: () => [],
    };

    const result = await checkForConflicts(repos.local, undefined, {
      dependencyLookup: emptyLookup,
      changedFiles: ['a.ts'],
    });

    expect(result.dependencyOverlaps).toEqual([]);
  });

  it('surfaces a dependency overlap for a renamed export with a live dependent and no textual conflict', async () => {
    // The exact scenario the issue's AC names: a renamed export with a live
    // dependent but no textual conflict is flagged.
    const repos = await setupRepos({
      files: [{ name: 'a.ts', base: 'export const a = 1;\n', branch: 'export const aRenamed = 2;\n' }],
    });
    base = repos.base;

    const lookup: ConflictDependencyLookup = {
      listFileSymbols: (fp) => (fp === 'a.ts' ? [{ id: 'a.ts::a@1', name: 'a', filePath: 'a.ts' }] : []),
      getFileDependents: (fp) => (fp === 'a.ts' ? ['src/consumer.ts'] : []),
    };

    const result = await checkForConflicts(repos.local, undefined, {
      dependencyLookup: lookup,
      changedFiles: ['a.ts'],
    });

    expect(result.hasConflicts).toBe(false); // No textual conflict
    expect(result.dependencyOverlaps).toHaveLength(1);
    expect(result.dependencyOverlaps[0]).toMatchObject({
      sourceFile: 'a.ts',
      dependentFile: 'src/consumer.ts',
    });
  });

  it('does not flag dependents that are themselves in the changed set', async () => {
    const repos = await setupRepos({
      files: [
        { name: 'a.ts', base: 'export const a = 1;\n', branch: 'export const a = 2;\n' },
        { name: 'b.ts', base: 'import { a } from "./a";\n', branch: 'import { a } from "./a";\nconst x = a;\n' },
      ],
    });
    base = repos.base;

    const lookup: ConflictDependencyLookup = {
      listFileSymbols: (fp) => (fp === 'a.ts' ? [{ id: 'a.ts::a@1', name: 'a', filePath: 'a.ts' }] : []),
      getFileDependents: (fp) => (fp === 'a.ts' ? ['b.ts'] : []),
    };

    const result = await checkForConflicts(repos.local, undefined, {
      dependencyLookup: lookup,
      changedFiles: ['a.ts', 'b.ts'], // b.ts is in the changed set
    });

    // b.ts is being changed in the same PR — coupled but not at risk of
    // a rename-collision scheduling problem.
    expect(result.dependencyOverlaps).toEqual([]);
  });

  it('degrades gracefully when the lookup throws (still returns textual result)', async () => {
    const repos = await setupRepos({
      files: [{ name: 'a.ts', base: 'export const a = 1;\n', branch: 'export const a = 2;\n' }],
    });
    base = repos.base;

    const throwingLookup: ConflictDependencyLookup = {
      listFileSymbols: () => {
        throw new Error('codegraph closed');
      },
      getFileDependents: () => {
        throw new Error('codegraph closed');
      },
    };

    const result = await checkForConflicts(repos.local, undefined, {
      dependencyLookup: throwingLookup,
      changedFiles: ['a.ts'],
    });

    // Textual result still correct; dep-overlap silently empty.
    expect(result.hasConflicts).toBe(false);
    expect(result.dependencyOverlaps).toEqual([]);
  });
});
