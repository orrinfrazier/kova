import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  detectRepoName,
  findRepoByName,
  loadConfig,
  resolveConfigPath,
  resolveRepoConfig,
  resolveTilde,
} from './config.js';

/* ------------------------------------------------------------------ */
/*  Temp directory management                                          */
/* ------------------------------------------------------------------ */

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kova-config-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  loadConfig                                                         */
/* ------------------------------------------------------------------ */

describe('loadConfig', () => {
  it('loads a minimal valid config', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));

    const repo = config.repos['my-repo'];
    expect(repo).toBeDefined();
    expect(repo?.path).toBe('/tmp/my-repo');
    // Defaults applied by Zod
    expect(repo?.rules.coverage).toBe(80);
    expect(repo?.rules.auto_merge).toBe(false);
    expect(repo?.rules.max_issues_per_run).toBe(10);
    expect(repo?.isolation).toBe('worktree');
  });

  it('loads a full config with all optional fields', async () => {
    const yaml = `
repos:
  full-repo:
    path: /opt/repos/full
    rules:
      coverage: 95
      auto_merge: true
      max_issues_per_run: 5
      budget_usd: 100
      focus:
        - security
        - performance
    auto:
      source: labeled
      filter: kova
      max_per_run: 3
      schedule: "0 8 * * *"
    model:
      assess: large
      spec: large
      test: small
      impl: medium
      quality: small
      review: large
    isolation: docker
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['full-repo'];
    expect(repo).toBeDefined();
    if (!repo) return; // narrow for noUncheckedIndexedAccess

    expect(repo.path).toBe('/opt/repos/full');
    expect(repo.rules.coverage).toBe(95);
    expect(repo.rules.auto_merge).toBe(true);
    expect(repo.rules.budget_usd).toBe(100);
    expect(repo.rules.focus).toEqual(['security', 'performance']);
    expect(repo.auto?.source).toBe('labeled');
    expect(repo.auto?.filter).toBe('kova');
    expect(repo.auto?.max_per_run).toBe(3);
    expect(repo.auto?.schedule).toBe('0 8 * * *');
    expect(repo.model.test).toBe('small');
    expect(repo.isolation).toBe('docker');
  });

  it('loads config with per-wave thinking levels', async () => {
    const yaml = `
repos:
  thinking-repo:
    path: /tmp/thinking
    model:
      assess: large
      spec: large
      test: medium
      impl: medium
      quality: small
      review: large
      thinking:
        spec: high
        review: high
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['thinking-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.thinking?.spec).toBe('high');
    expect(repo.model.thinking?.review).toBe('high');
    expect(repo.model.thinking?.assess).toBeUndefined();
  });

  it('rejects invalid thinking level values', async () => {
    const yaml = `
repos:
  bad-thinking:
    path: /tmp/bad
    model:
      thinking:
        assess: invalid_level
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });

  it('throws on invalid YAML syntax', async () => {
    await writeFile(join(tempDir, 'bad.yaml'), '{{not: valid: yaml:::');

    await expect(loadConfig(join(tempDir, 'bad.yaml'))).rejects.toThrow();
  });

  it('throws ZodError when YAML is valid but schema is wrong (missing required path)', async () => {
    const yaml = `repos:\n  broken:\n    coverage: 80\n`;
    await writeFile(join(tempDir, 'invalid.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'invalid.yaml'))).rejects.toThrow(ZodError);
  });

  it('throws ZodError when field has wrong type', async () => {
    const yaml = `repos:\n  bad:\n    path: /tmp/bad\n    rules:\n      coverage: "not-a-number"\n`;
    await writeFile(join(tempDir, 'wrong-type.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'wrong-type.yaml'))).rejects.toThrow(ZodError);
  });

  it('throws descriptive error when file is not found', async () => {
    await expect(loadConfig(join(tempDir, 'nonexistent.yaml'))).rejects.toThrow(/Config file not found/);
  });

  it('includes file path in not-found error message', async () => {
    const missingPath = join(tempDir, 'missing.yaml');
    await expect(loadConfig(missingPath)).rejects.toThrow(missingPath);
  });

  it('resolves ~ in repo paths to home directory', async () => {
    const yaml = `repos:\n  tilde-repo:\n    path: ~/projects/my-app\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['tilde-repo'];
    expect(repo).toBeDefined();
    expect(repo?.path).toBe(join(homedir(), 'projects/my-app'));
  });

  it('resolves relative paths to absolute paths', async () => {
    const yaml = `repos:\n  rel-repo:\n    path: ./my-project\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['rel-repo'];
    expect(repo).toBeDefined();
    // Relative paths resolved from cwd
    expect(repo?.path).toBe(resolve('./my-project'));
  });

  it('preserves absolute paths unchanged', async () => {
    const yaml = `repos:\n  abs-repo:\n    path: /opt/repos/abs\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['abs-repo'];
    expect(repo?.path).toBe('/opt/repos/abs');
  });
});

/* ------------------------------------------------------------------ */
/*  resolveTilde                                                       */
/* ------------------------------------------------------------------ */

describe('resolveTilde', () => {
  it('expands ~ at the start of a path', () => {
    expect(resolveTilde('~/projects')).toBe(join(homedir(), 'projects'));
  });

  it('expands ~/nested/deep paths', () => {
    expect(resolveTilde('~/a/b/c')).toBe(join(homedir(), 'a/b/c'));
  });

  it('does not expand ~ in the middle of a path', () => {
    expect(resolveTilde('/home/~user/foo')).toBe('/home/~user/foo');
  });

  it('returns absolute paths unchanged', () => {
    expect(resolveTilde('/opt/repos')).toBe('/opt/repos');
  });

  it('returns relative paths unchanged (not its job)', () => {
    expect(resolveTilde('./foo/bar')).toBe('./foo/bar');
  });
});

/* ------------------------------------------------------------------ */
/*  resolveConfigPath                                                  */
/* ------------------------------------------------------------------ */

describe('resolveConfigPath', () => {
  it('returns explicit path when provided', () => {
    expect(resolveConfigPath('/custom/repos.yaml')).toBe('/custom/repos.yaml');
  });

  it('defaults to ~/.kova/repos.yaml when no path given', () => {
    expect(resolveConfigPath()).toBe(join(homedir(), '.kova', 'repos.yaml'));
  });

  it('resolves tilde in explicit config path', () => {
    expect(resolveConfigPath('~/.config/kova/repos.yaml')).toBe(join(homedir(), '.config/kova/repos.yaml'));
  });
});

/* ------------------------------------------------------------------ */
/*  findRepoByName                                                     */
/* ------------------------------------------------------------------ */

describe('findRepoByName', () => {
  const makeConfig = () => ({
    repos: {
      onexos: {
        path: '/home/user/dev/onexos',
        rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
        model: {
          assess: 'large' as const,
          spec: 'large' as const,
          test: 'medium' as const,
          impl: 'medium' as const,
          quality: 'small' as const,
          review: 'large' as const,
          brainstorm: 'large' as const,
        },
        isolation: 'worktree' as const,
      },
      kova: {
        path: '/home/user/dev/kova',
        rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
        model: {
          assess: 'large' as const,
          spec: 'large' as const,
          test: 'medium' as const,
          impl: 'medium' as const,
          quality: 'small' as const,
          review: 'large' as const,
          brainstorm: 'large' as const,
        },
        isolation: 'worktree' as const,
      },
    },
  });

  it('finds a repo by its config key name', () => {
    const result = findRepoByName(makeConfig(), 'onexos');
    expect(result).toBeDefined();
    expect(result?.name).toBe('onexos');
    expect(result?.config.path).toBe('/home/user/dev/onexos');
  });

  it('returns undefined for unknown repo name', () => {
    const result = findRepoByName(makeConfig(), 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns the correct repo when multiple exist', () => {
    const result = findRepoByName(makeConfig(), 'kova');
    expect(result?.config.path).toBe('/home/user/dev/kova');
  });
});

/* ------------------------------------------------------------------ */
/*  resolveRepoConfig                                                  */
/* ------------------------------------------------------------------ */

describe('resolveRepoConfig', () => {
  it('returns config with all defaults for a bare path', () => {
    const config = resolveRepoConfig('/home/user/project');

    expect(config.path).toBe('/home/user/project');
    expect(config.rules.coverage).toBe(80);
    expect(config.rules.auto_merge).toBe(false);
    expect(config.rules.max_issues_per_run).toBe(10);
    expect(config.model.assess).toBe('large');
    expect(config.model.spec).toBe('large');
    expect(config.model.test).toBe('medium');
    expect(config.model.impl).toBe('medium');
    expect(config.model.quality).toBe('small');
    expect(config.model.review).toBe('large');
    expect(config.model.brainstorm).toBe('large');
    expect(config.isolation).toBe('worktree');
  });

  it('thinking config is undefined by default', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.model.thinking).toBeUndefined();
  });

  it('auto field is undefined by default', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.auto).toBeUndefined();
  });

  it('optional budget fields are undefined by default', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.rules.budget_usd).toBeUndefined();
    expect(config.rules.focus).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  per-repo model tier overrides                                      */
/* ------------------------------------------------------------------ */

describe('per-repo model tier overrides', () => {
  it('different repos get different model tiers from repos.yaml', async () => {
    const yaml = `
repos:
  repo-a:
    path: /tmp/repo-a
    model:
      review: large
      brainstorm: large
  repo-b:
    path: /tmp/repo-b
    model:
      review: small
      brainstorm: small
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repoA = config.repos['repo-a'];
    const repoB = config.repos['repo-b'];
    expect(repoA).toBeDefined();
    expect(repoB).toBeDefined();
    if (!repoA || !repoB) return;

    expect(repoA.model.review).toBe('large');
    expect(repoA.model.brainstorm).toBe('large');
    expect(repoB.model.review).toBe('small');
    expect(repoB.model.brainstorm).toBe('small');
  });

  it('brainstorm model tier defaults to large', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.model.brainstorm).toBe('large');
  });

  it('allows brainstorm model tier override', async () => {
    const yaml = `
repos:
  test-repo:
    path: /tmp/test
    model:
      brainstorm: small
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['test-repo'];
    expect(repo?.model.brainstorm).toBe('small');
  });

  it('allows brainstorm thinking level override', async () => {
    const yaml = `
repos:
  test-repo:
    path: /tmp/test
    model:
      thinking:
        brainstorm: high
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['test-repo'];
    expect(repo?.model.thinking?.brainstorm).toBe('high');
  });

  it('model overrides merge with defaults for unspecified waves', async () => {
    const yaml = `
repos:
  partial-repo:
    path: /tmp/partial
    model:
      review: small
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['partial-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    // Overridden
    expect(repo.model.review).toBe('small');
    // Defaults preserved
    expect(repo.model.assess).toBe('large');
    expect(repo.model.spec).toBe('large');
    expect(repo.model.test).toBe('medium');
    expect(repo.model.impl).toBe('medium');
    expect(repo.model.quality).toBe('small');
    expect(repo.model.brainstorm).toBe('large');
  });
});

/* ------------------------------------------------------------------ */
/*  detectRepoName                                                     */
/* ------------------------------------------------------------------ */

describe('detectRepoName', () => {
  it('extracts basename from absolute path', () => {
    expect(detectRepoName('/home/user/projects/my-app')).toBe('my-app');
  });

  it('extracts basename from relative path', () => {
    expect(detectRepoName('repos/backend')).toBe('backend');
  });

  it('handles trailing slash', () => {
    // path.basename strips trailing slash
    expect(detectRepoName('/opt/repos/service/')).toBe('service');
  });

  it('returns single segment path as-is', () => {
    expect(detectRepoName('monorepo')).toBe('monorepo');
  });
});
