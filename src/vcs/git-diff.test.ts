import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { getChangedFiles, getLastIndexedSha, SOURCE_EXTENSIONS, saveLastIndexedSha } from './git-diff.js';

$.verbose = false;

/* ------------------------------------------------------------------ */
/*  Temp directory management                                          */
/* ------------------------------------------------------------------ */

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kova-git-diff-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  SOURCE_EXTENSIONS                                                  */
/* ------------------------------------------------------------------ */

describe('SOURCE_EXTENSIONS', () => {
  it('contains .ts extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.ts');
  });

  it('contains .js extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.js');
  });

  it('contains .rs extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.rs');
  });

  it('contains .go extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.go');
  });

  it('contains .py extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.py');
  });

  it('contains .java extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.java');
  });

  it('contains .rb extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.rb');
  });

  it('contains .c extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.c');
  });

  it('contains .cpp extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.cpp');
  });

  it('contains .h extension', () => {
    expect(SOURCE_EXTENSIONS).toContain('.h');
  });
});

/* ------------------------------------------------------------------ */
/*  getLastIndexedSha                                                  */
/* ------------------------------------------------------------------ */

describe('getLastIndexedSha', () => {
  it('returns null when .kova/last-index-sha.txt does not exist', async () => {
    const result = await getLastIndexedSha(tempDir);
    expect(result).toBeNull();
  });

  it('returns the SHA when .kova/last-index-sha.txt exists', async () => {
    const sha = 'abc1234567890abcdef1234567890abcdef123456';
    const kovaDir = join(tempDir, '.kova');
    await mkdir(kovaDir, { recursive: true });
    await writeFile(join(kovaDir, 'last-index-sha.txt'), sha);

    const result = await getLastIndexedSha(tempDir);
    expect(result).toBe(sha);
  });

  it('trims whitespace/newlines from the stored SHA', async () => {
    const sha = 'abc1234567890abcdef1234567890abcdef123456';
    const kovaDir = join(tempDir, '.kova');
    await mkdir(kovaDir, { recursive: true });
    await writeFile(join(kovaDir, 'last-index-sha.txt'), `${sha}\n`);

    const result = await getLastIndexedSha(tempDir);
    expect(result).toBe(sha);
  });
});

/* ------------------------------------------------------------------ */
/*  saveLastIndexedSha                                                 */
/* ------------------------------------------------------------------ */

describe('saveLastIndexedSha', () => {
  it('writes SHA to .kova/last-index-sha.txt', async () => {
    const sha = 'deadbeef1234567890abcdef1234567890abcdef';
    const kovaDir = join(tempDir, '.kova');
    await mkdir(kovaDir, { recursive: true });

    await saveLastIndexedSha(tempDir, sha);

    const written = await readFile(join(kovaDir, 'last-index-sha.txt'), 'utf-8');
    expect(written.trim()).toBe(sha);
  });

  it('creates .kova directory if it does not exist', async () => {
    const sha = 'cafebabe1234567890abcdef1234567890abcdef';

    // .kova directory does NOT exist — saveLastIndexedSha must create it
    await saveLastIndexedSha(tempDir, sha);

    const written = await readFile(join(tempDir, '.kova', 'last-index-sha.txt'), 'utf-8');
    expect(written.trim()).toBe(sha);
  });

  it('overwrites an existing SHA', async () => {
    const kovaDir = join(tempDir, '.kova');
    await mkdir(kovaDir, { recursive: true });
    await writeFile(join(kovaDir, 'last-index-sha.txt'), 'oldshaoldshaoldshaoldshaoldshaoldshaoldsha');

    const newSha = 'newsha1234567890abcdef1234567890abcdef12';
    await saveLastIndexedSha(tempDir, newSha);

    const written = await readFile(join(kovaDir, 'last-index-sha.txt'), 'utf-8');
    expect(written.trim()).toBe(newSha);
  });
});

/* ------------------------------------------------------------------ */
/*  getChangedFiles                                                    */
/* ------------------------------------------------------------------ */

/**
 * Sets up a minimal git repo in tempDir with an initial commit and a
 * follow-up commit adding source + non-source files for diff testing.
 */
async function setupGitRepo(dir: string): Promise<{ initialSha: string; headSha: string }> {
  await $`git -C ${dir} init -b main`;
  await $`git -C ${dir} config user.email "test@kova.dev"`;
  await $`git -C ${dir} config user.name "Kova Test"`;

  // Initial commit with one source file and one non-source file
  await writeFile(join(dir, 'main.ts'), 'export const main = true;\n');
  await writeFile(join(dir, 'README.md'), '# Repo\n');
  await $`git -C ${dir} add .`;
  await $`git -C ${dir} commit -m "initial commit"`;
  const initialSha = (await $`git -C ${dir} rev-parse HEAD`).stdout.trim();

  // Second commit adding more files of various types
  await writeFile(join(dir, 'helper.go'), 'package main\n');
  await writeFile(join(dir, 'util.py'), 'pass\n');
  await writeFile(join(dir, 'logo.png'), 'binary');
  await writeFile(join(dir, 'config.yaml'), 'key: value\n');
  await $`git -C ${dir} add .`;
  await $`git -C ${dir} commit -m "add more files"`;
  const headSha = (await $`git -C ${dir} rev-parse HEAD`).stdout.trim();

  return { initialSha, headSha };
}

describe('getChangedFiles', () => {
  it('returns all tracked source files when sinceSha is null (full index)', async () => {
    await setupGitRepo(tempDir);

    const files = await getChangedFiles(tempDir, null);

    // Source files from both commits should be present
    expect(files).toContain('main.ts');
    expect(files).toContain('helper.go');
    expect(files).toContain('util.py');
  });

  it('excludes non-source files when sinceSha is null', async () => {
    await setupGitRepo(tempDir);

    const files = await getChangedFiles(tempDir, null);

    expect(files).not.toContain('README.md');
    expect(files).not.toContain('logo.png');
    expect(files).not.toContain('config.yaml');
  });

  it('returns only changed source files since the given SHA (incremental)', async () => {
    const { initialSha } = await setupGitRepo(tempDir);

    const files = await getChangedFiles(tempDir, initialSha);

    // Only files added after initialSha
    expect(files).toContain('helper.go');
    expect(files).toContain('util.py');
    // main.ts was added in the initial commit, so NOT in the diff
    expect(files).not.toContain('main.ts');
  });

  it('excludes non-source files in incremental mode', async () => {
    const { initialSha } = await setupGitRepo(tempDir);

    const files = await getChangedFiles(tempDir, initialSha);

    expect(files).not.toContain('logo.png');
    expect(files).not.toContain('config.yaml');
    expect(files).not.toContain('README.md');
  });

  it('returns an empty array when no source files changed since SHA', async () => {
    await setupGitRepo(tempDir);
    const headSha = (await $`git -C ${tempDir} rev-parse HEAD`).stdout.trim();

    // No commits since HEAD — nothing changed
    const files = await getChangedFiles(tempDir, headSha);

    expect(files).toEqual([]);
  });

  it('filters to source file extensions only (.ts, .js, .rs, .go, .py, .java, .rb, .c, .cpp, .h)', async () => {
    await $`git -C ${tempDir} init -b main`;
    await $`git -C ${tempDir} config user.email "test@kova.dev"`;
    await $`git -C ${tempDir} config user.name "Kova Test"`;

    // Add one file of every source type plus noise
    const sourceFiles = ['a.ts', 'b.js', 'c.rs', 'd.go', 'e.py', 'f.java', 'g.rb', 'h.c', 'i.cpp', 'j.h'];
    const noiseFiles = ['k.md', 'l.yaml', 'm.json', 'n.png', 'o.txt'];

    for (const f of [...sourceFiles, ...noiseFiles]) {
      await writeFile(join(tempDir, f), '// content\n');
    }
    await $`git -C ${tempDir} add .`;
    await $`git -C ${tempDir} commit -m "all file types"`;

    const files = await getChangedFiles(tempDir, null);

    for (const sf of sourceFiles) {
      expect(files).toContain(sf);
    }
    for (const nf of noiseFiles) {
      expect(files).not.toContain(nf);
    }
  });
});
