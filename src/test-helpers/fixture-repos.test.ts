import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoFixture, createPythonFixture, createRustFixture, createTypeScriptFixture } from './fixture-repos.js';
import type { TempRepo } from './mock-git.js';

describe('createTypeScriptFixture', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('creates a git repo with package.json', async () => {
    repo = await createTypeScriptFixture();

    const pkg = JSON.parse(await readFile(join(repo.path, 'package.json'), 'utf-8')) as { name: string };
    expect(pkg.name).toBe('ts-fixture');
  });

  it('has TypeScript source files', async () => {
    repo = await createTypeScriptFixture();

    await expect(stat(join(repo.path, 'src/validate.ts'))).resolves.toBeDefined();
    await expect(stat(join(repo.path, 'src/handler.ts'))).resolves.toBeDefined();
    await expect(stat(join(repo.path, 'src/index.ts'))).resolves.toBeDefined();
  });

  it('contains the known validation bug', async () => {
    repo = await createTypeScriptFixture();

    const validate = await readFile(join(repo.path, 'src/validate.ts'), 'utf-8');
    // Bug: accepts any non-empty string as email
    expect(validate).toContain('email.length > 0');
    expect(validate).not.toContain('@');
  });

  it('has git commits', async () => {
    repo = await createTypeScriptFixture();

    const { $ } = await import('zx');
    $.verbose = false;
    const log = await $({ cwd: repo.path })`git log --oneline`;
    expect(log.stdout).toContain('TypeScript project');
  });
});

describe('createRustFixture', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('creates a git repo with Cargo.toml', async () => {
    repo = await createRustFixture();

    const cargo = await readFile(join(repo.path, 'Cargo.toml'), 'utf-8');
    expect(cargo).toContain('rust-fixture');
  });

  it('contains the off-by-one range bug', async () => {
    repo = await createRustFixture();

    const lib = await readFile(join(repo.path, 'src/lib.rs'), 'utf-8');
    // Bug: uses exclusive range (from..to) instead of inclusive (from..=to)
    expect(lib).toContain('(from..to).sum()');
    expect(lib).not.toContain('from..=to');
  });
});

describe('createGoFixture', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('creates a git repo with go.mod', async () => {
    repo = await createGoFixture();

    const gomod = await readFile(join(repo.path, 'go.mod'), 'utf-8');
    expect(gomod).toContain('go-fixture');
  });

  it('contains the missing negative-age validation bug', async () => {
    repo = await createGoFixture();

    const age = await readFile(join(repo.path, 'age.go'), 'utf-8');
    // Bug: ParseAge doesn't reject negative numbers
    expect(age).toContain('strconv.Atoi(s)');
    expect(age).not.toContain('< 0');
  });
});

describe('createPythonFixture', () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('creates a git repo with pyproject.toml', async () => {
    repo = await createPythonFixture();

    const pyproject = await readFile(join(repo.path, 'pyproject.toml'), 'utf-8');
    expect(pyproject).toContain('py-fixture');
  });

  it('contains the empty-list division bug', async () => {
    repo = await createPythonFixture();

    const stats = await readFile(join(repo.path, 'src/stats.py'), 'utf-8');
    // Bug: no guard for empty list before division
    expect(stats).toContain('sum(numbers) / len(numbers)');
    expect(stats).not.toContain('if not numbers');
  });

  it('has failing test for the bug', async () => {
    repo = await createPythonFixture();

    const test = await readFile(join(repo.path, 'tests/test_stats.py'), 'utf-8');
    expect(test).toContain('test_average_empty');
    expect(test).toContain('ZeroDivisionError');
  });
});
