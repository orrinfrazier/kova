// Tests for deterministic static pre-scan over diff-added lines.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { $ } from 'zx';
import { scanDiffForBlockingFindings } from './review-prescan.js';

$.verbose = false;

async function makeRepo(): Promise<string> {
  const dir = join(tmpdir(), `kova-prescan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email t@t.test`;
  await $`git -C ${dir} config user.name test`;
  return dir;
}

async function commit(dir: string, file: string, content: string): Promise<void> {
  await writeFile(join(dir, file), content);
  await $`git -C ${dir} add ${file}`;
  await $`git -C ${dir} commit -q -m ${'add ' + file}`;
}

async function modifyUncommitted(dir: string, file: string, content: string): Promise<void> {
  await writeFile(join(dir, file), content);
}

describe('scanDiffForBlockingFindings', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await makeRepo();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns no findings when diff has no added lines with secrets', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(workDir, 'a.ts', 'export const safe = 1;\nexport const also_safe = 2;\n');

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.findings).toEqual([]);
    expect(result.blocking).toBe(false);
  });

  it('flags a hardcoded GitHub PAT in newly added lines', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const safe = 1;\nexport const token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.blocking).toBe(true);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.some((f) => f.type === 'GitHub PAT')).toBe(true);
  });

  it('flags a hardcoded Anthropic API key in newly added lines', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const safe = 1;\nexport const token = "sk-ant-aaaaaaaaaaaaaaaaaaaaaa";\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.type === 'Anthropic API key')).toBe(true);
  });

  it('flags an eval() call in newly added lines', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const safe = 1;\nexport function dangerous(input: string) { return eval(input); }\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.type === 'eval()')).toBe(true);
  });

  it('flags new Function() construction in newly added lines', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const safe = 1;\nexport const fn = new Function("a", "return a + 1");\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.type === 'new Function()')).toBe(true);
  });

  it('does NOT flag secrets in unchanged context lines (pre-existing only)', async () => {
    // The pre-existing file already contains a key; we add an unrelated line.
    await commit(workDir, 'a.ts', 'export const old_token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const old_token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\nexport const safe = 1;\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    // The pre-existing PAT is in a context line (not added), so should NOT
    // be flagged. Pre-scan is for *new* additions in this diff only.
    expect(result.findings.filter((f) => f.type === 'GitHub PAT')).toEqual([]);
    expect(result.blocking).toBe(false);
  });

  it('returns a human-readable summary listing findings', async () => {
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await modifyUncommitted(
      workDir,
      'a.ts',
      'export const safe = 1;\nexport const token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n',
    );

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.summary).toMatch(/GitHub PAT/);
    expect(result.summary).toMatch(/a\.ts/);
  });

  it('also scans untracked (newly-created) files', async () => {
    // Repo with an initial commit; new file is added but not yet committed.
    await commit(workDir, 'a.ts', 'export const safe = 1;\n');
    await writeFile(join(workDir, 'new.ts'), 'export const tok = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n');

    const result = await scanDiffForBlockingFindings(workDir);

    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.file === 'new.ts' && f.type === 'GitHub PAT')).toBe(true);
  });
});
