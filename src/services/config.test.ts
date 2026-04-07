import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { detectRepoName, loadConfig, resolveRepoConfig } from './config.js';

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
    expect(config.isolation).toBe('worktree');
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
