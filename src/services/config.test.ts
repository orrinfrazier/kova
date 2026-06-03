import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { PlaywrightConfig } from '../types/index.js';
import { PlaywrightConfigSchema } from '../types/index.js';
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

  it('loads config with ab_test field', async () => {
    const yaml = `
repos:
  ab-repo:
    path: /tmp/ab-repo
    prompts_dir: ./custom-prompts
    ab_test:
      assess:
        - v1
        - v2
      spec:
        - control
        - experiment
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['ab-repo'];
    expect(repo).toBeDefined();
    expect(repo?.ab_test).toBeDefined();
    expect(repo?.ab_test?.assess).toEqual(['v1', 'v2']);
    expect(repo?.ab_test?.spec).toEqual(['control', 'experiment']);
  });

  it('rejects ab_test with fewer than 2 variants', async () => {
    const yaml = `
repos:
  bad-ab:
    path: /tmp/bad-ab
    ab_test:
      assess:
        - v1
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow();
  });

  it('loads config without ab_test (backward compat)', async () => {
    const yaml = `repos:\n  simple:\n    path: /tmp/simple\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos.simple;
    expect(repo).toBeDefined();
    expect(repo?.ab_test).toBeUndefined();
  });

  it('loads config with isolation: none for copilot mode', async () => {
    const yaml = `
repos:
  copilot-repo:
    path: /tmp/copilot
    isolation: none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['copilot-repo'];
    expect(repo).toBeDefined();
    expect(repo?.isolation).toBe('none');
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
        rules: {
          coverage: 80,
          auto_merge: false,
          max_issues_per_run: 10,
          ci_merge: 'require' as const,
          review_merge: 'require' as const,
          concurrency: 1,
        },
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
        runtime: 'pi' as const,
      },
      kova: {
        path: '/home/user/dev/kova',
        rules: {
          coverage: 80,
          auto_merge: false,
          max_issues_per_run: 10,
          ci_merge: 'require' as const,
          review_merge: 'require' as const,
          concurrency: 1,
        },
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
        runtime: 'pi' as const,
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
/*  providers.ollama config                                            */
/* ------------------------------------------------------------------ */

describe('providers.ollama config', () => {
  it('loads config with ollama provider and models', async () => {
    const yaml = `
repos:
  local-repo:
    path: /tmp/local
    providers:
      ollama:
        host: http://localhost:11434
        models:
          - id: llama3
          - id: codellama
            name: Code Llama 13B
            contextWindow: 16384
            maxTokens: 4096
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['local-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.providers?.ollama).toBeDefined();
    expect(repo.providers?.ollama?.host).toBe('http://localhost:11434');
    expect(repo.providers?.ollama?.models).toHaveLength(2);
    expect(repo.providers?.ollama?.models[0]?.id).toBe('llama3');
    expect(repo.providers?.ollama?.models[1]?.name).toBe('Code Llama 13B');
    expect(repo.providers?.ollama?.models[1]?.contextWindow).toBe(16384);
  });

  it('applies defaults for ollama model fields', async () => {
    const yaml = `
repos:
  defaults-repo:
    path: /tmp/defaults
    providers:
      ollama:
        models:
          - id: llama3
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['defaults-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    const ollama = repo.providers?.ollama;
    expect(ollama?.host).toBe('http://localhost:11434');
    expect(ollama?.models[0]?.contextWindow).toBe(128000);
    expect(ollama?.models[0]?.maxTokens).toBe(32000);
  });

  it('providers section is optional', async () => {
    const yaml = `
repos:
  no-providers:
    path: /tmp/none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-providers'];
    expect(repo?.providers).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  per-wave provider+model overrides (#27)                            */
/* ------------------------------------------------------------------ */

describe('per-wave provider+model overrides', () => {
  it('accepts provider+model object for a wave', async () => {
    const yaml = `
repos:
  local-repo:
    path: /tmp/local
    model:
      impl:
        provider: ollama
        model: qwen2.5-coder:32b
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['local-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.impl).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
    // Other waves keep tier defaults
    expect(repo.model.assess).toBe('large');
    expect(repo.model.spec).toBe('large');
  });

  it('accepts mixed tier and provider+model overrides', async () => {
    const yaml = `
repos:
  mixed-repo:
    path: /tmp/mixed
    model:
      assess: large
      spec: large
      test:
        provider: ollama
        model: qwen2.5-coder:32b
      impl:
        provider: ollama
        model: qwen2.5-coder:32b
      quality: small
      review: large
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['mixed-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.assess).toBe('large');
    expect(repo.model.test).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
    expect(repo.model.impl).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
    expect(repo.model.quality).toBe('small');
  });

  it('rejects provider+model without required fields', async () => {
    const yaml = `
repos:
  bad-repo:
    path: /tmp/bad
    model:
      impl:
        provider: ollama
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });
});

/* ------------------------------------------------------------------ */
/*  bare model string config (issue #40)                               */
/* ------------------------------------------------------------------ */

describe('bare model string config', () => {
  it('accepts bare model string for a wave', async () => {
    const yaml = `
repos:
  model-repo:
    path: /tmp/model
    model:
      assess: claude-opus-4-6
      spec: claude-sonnet-4-6
      impl: gemini-2.5-flash
      quality: claude-haiku-4-5-20251001
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['model-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.assess).toBe('claude-opus-4-6');
    expect(repo.model.spec).toBe('claude-sonnet-4-6');
    expect(repo.model.impl).toBe('gemini-2.5-flash');
    expect(repo.model.quality).toBe('claude-haiku-4-5-20251001');
    // Tier defaults preserved for unspecified waves
    expect(repo.model.test).toBe('medium');
    expect(repo.model.review).toBe('large');
  });

  it('accepts mixed tiers, bare model strings, and provider overrides', async () => {
    const yaml = `
repos:
  mixed-repo:
    path: /tmp/mixed
    model:
      assess: large
      spec: claude-sonnet-4-6
      test:
        provider: ollama
        model: qwen2.5-coder:32b
      impl: gemini-2.5-flash
      quality: small
      review: claude-opus-4-6
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['mixed-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.assess).toBe('large');
    expect(repo.model.spec).toBe('claude-sonnet-4-6');
    expect(repo.model.test).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
    expect(repo.model.impl).toBe('gemini-2.5-flash');
    expect(repo.model.quality).toBe('small');
    expect(repo.model.review).toBe('claude-opus-4-6');
  });

  it('accepts fallback model in model config', async () => {
    const yaml = `
repos:
  fallback-repo:
    path: /tmp/fallback
    model:
      assess: claude-opus-4-6
      fallback: claude-sonnet-4-6
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['fallback-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.fallback).toBe('claude-sonnet-4-6');
  });

  it('fallback is optional and defaults to undefined', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.model.fallback).toBeUndefined();
  });

  it('accepts fallback: false to disable API fallback', async () => {
    const yaml = `
repos:
  no-fallback-repo:
    path: /tmp/no-fallback
    model:
      assess: claude-opus-4-6
      fallback: false
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-fallback-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.model.fallback).toBe(false);
  });

  it('accepts fallback: "none" string sentinel to disable API fallback', async () => {
    const yaml = `
repos:
  none-fallback-repo:
    path: /tmp/none-fallback
    model:
      assess: claude-opus-4-6
      fallback: none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['none-fallback-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    // 'none' is normalized to false during parsing
    expect(repo.model.fallback).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  vectordb config                                                    */
/* ------------------------------------------------------------------ */

describe('vectordb config', () => {
  it('loads config with vectordb enabled', async () => {
    const yaml = `
repos:
  vdb-repo:
    path: /tmp/vdb
    vectordb:
      enabled: true
      endpoint: http://localhost:8100/query
      top_k: 5
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['vdb-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.vectordb?.enabled).toBe(true);
    expect(repo.vectordb?.endpoint).toBe('http://localhost:8100/query');
    expect(repo.vectordb?.top_k).toBe(5);
  });

  it('applies defaults for top_k when not specified', async () => {
    const yaml = `
repos:
  vdb-defaults:
    path: /tmp/vdb
    vectordb:
      enabled: true
      endpoint: http://localhost:8100/query
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['vdb-defaults'];
    expect(repo?.vectordb?.top_k).toBe(10);
  });

  it('vectordb section is optional', async () => {
    const yaml = `
repos:
  no-vdb:
    path: /tmp/none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-vdb'];
    expect(repo?.vectordb).toBeUndefined();
  });

  it('rejects vectordb with missing endpoint when enabled', async () => {
    const yaml = `
repos:
  bad-vdb:
    path: /tmp/bad
    vectordb:
      enabled: true
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });

  it('allows vectordb disabled without endpoint', async () => {
    const yaml = `
repos:
  disabled-vdb:
    path: /tmp/disabled
    vectordb:
      enabled: false
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['disabled-vdb'];
    expect(repo?.vectordb?.enabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  repo_intel config                                                  */
/* ------------------------------------------------------------------ */

describe('repo_intel config', () => {
  it('loads config with repo_intel enabled', async () => {
    const yaml = `
repos:
  intel-repo:
    path: /tmp/intel
    repo_intel:
      enabled: true
      endpoint: http://localhost:9999/repo-intel
      limit: 10
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['intel-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.repo_intel?.enabled).toBe(true);
    expect(repo.repo_intel?.endpoint).toBe('http://localhost:9999/repo-intel');
    expect(repo.repo_intel?.limit).toBe(10);
  });

  it('applies default limit when not specified', async () => {
    const yaml = `
repos:
  intel-defaults:
    path: /tmp/intel
    repo_intel:
      enabled: true
      endpoint: http://localhost:9999/repo-intel
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['intel-defaults'];
    expect(repo?.repo_intel?.limit).toBe(5);
  });

  it('repo_intel section is optional', async () => {
    const yaml = `
repos:
  no-intel:
    path: /tmp/none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-intel'];
    expect(repo?.repo_intel).toBeUndefined();
  });

  it('rejects repo_intel with missing endpoint when enabled', async () => {
    const yaml = `
repos:
  bad-intel:
    path: /tmp/bad
    repo_intel:
      enabled: true
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });

  it('allows repo_intel disabled without endpoint', async () => {
    const yaml = `
repos:
  disabled-intel:
    path: /tmp/disabled
    repo_intel:
      enabled: false
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['disabled-intel'];
    expect(repo?.repo_intel?.enabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  sandbox resource limits config                                     */
/* ------------------------------------------------------------------ */

describe('sandbox resource limits config', () => {
  it('loads sandbox config with resource limits', async () => {
    const yaml = `
repos:
  sandbox-repo:
    path: /tmp/sandbox
    isolation: docker
    sandbox:
      image: node:20-bookworm
      cpus: 4
      memory: 8g
      timeout: 1h
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['sandbox-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.sandbox?.cpus).toBe(4);
    expect(repo.sandbox?.memory).toBe('8g');
    expect(repo.sandbox?.timeout).toBe('1h');
  });

  it('applies default resource limits when not specified', async () => {
    const yaml = `
repos:
  default-sandbox:
    path: /tmp/sandbox
    isolation: docker
    sandbox:
      image: ubuntu:22.04
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['default-sandbox'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.sandbox?.cpus).toBe(2);
    expect(repo.sandbox?.memory).toBe('4g');
    expect(repo.sandbox?.timeout).toBe('30m');
  });

  it('rejects non-positive cpus', async () => {
    const yaml = `
repos:
  bad-sandbox:
    path: /tmp/bad
    sandbox:
      cpus: 0
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
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

/* ------------------------------------------------------------------ */
/*  mcp config                                                         */
/* ------------------------------------------------------------------ */

describe('mcp config', () => {
  it('loads config with MCP servers', async () => {
    const yaml = `
repos:
  mcp-repo:
    path: /tmp/mcp
    mcp:
      servers:
        repo-intel:
          command: npx
          args:
            - "-y"
            - "@anthropic-ai/repo-intel-mcp"
        shadcn:
          command: npx
          args:
            - "-y"
            - "@anthropic-ai/shadcn-mcp"
          env:
            SHADCN_KEY: test123
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['mcp-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.mcp).toBeDefined();
    expect(repo.mcp?.servers['repo-intel']).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic-ai/repo-intel-mcp'],
    });
    expect(repo.mcp?.servers.shadcn?.env).toEqual({ SHADCN_KEY: 'test123' });
  });

  it('loads config with per-wave MCP server assignments', async () => {
    const yaml = `
repos:
  wave-mcp:
    path: /tmp/wave-mcp
    mcp:
      servers:
        repo-intel:
          command: npx
          args: ["-y", "repo-intel"]
      waves:
        spec:
          - repo-intel
        impl:
          - repo-intel
          - shadcn
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['wave-mcp'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.mcp?.waves?.spec).toEqual(['repo-intel']);
    expect(repo.mcp?.waves?.impl).toEqual(['repo-intel', 'shadcn']);
    expect(repo.mcp?.waves?.assess).toBeUndefined();
  });

  it('mcp section is optional', async () => {
    const yaml = `
repos:
  no-mcp:
    path: /tmp/none
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-mcp'];
    expect(repo?.mcp).toBeUndefined();
  });

  it('mcp servers default to empty object', async () => {
    const yaml = `
repos:
  empty-mcp:
    path: /tmp/empty
    mcp:
      waves:
        spec:
          - repo-intel
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['empty-mcp'];
    expect(repo?.mcp?.servers).toEqual({});
  });

  it('rejects MCP server config missing command', async () => {
    const yaml = `
repos:
  bad-mcp:
    path: /tmp/bad
    mcp:
      servers:
        broken:
          args: ["--help"]
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });
});

/* ------------------------------------------------------------------ */
/*  playwright MCP config                                              */
/* ------------------------------------------------------------------ */

describe('playwright config', () => {
  it('PlaywrightConfigSchema validates a full config', () => {
    const result = PlaywrightConfigSchema.parse({
      enabled: true,
      screenshots_dir: '.kova/screenshots',
      baseline_dir: '.kova/baselines',
    });

    expect(result.enabled).toBe(true);
    expect(result.screenshots_dir).toBe('.kova/screenshots');
    expect(result.baseline_dir).toBe('.kova/baselines');
  });

  it('PlaywrightConfigSchema applies default screenshots_dir', () => {
    const result = PlaywrightConfigSchema.parse({
      enabled: true,
    });

    expect(result.screenshots_dir).toBe('.kova/screenshots');
  });

  it('baseline_dir is optional and defaults to undefined', () => {
    const result = PlaywrightConfigSchema.parse({
      enabled: true,
    });

    expect(result.baseline_dir).toBeUndefined();
  });

  it('rejects enabled with non-boolean type', () => {
    expect(() =>
      PlaywrightConfigSchema.parse({
        enabled: 'yes',
      }),
    ).toThrow(ZodError);
  });

  it('rejects screenshots_dir with non-string type', () => {
    expect(() =>
      PlaywrightConfigSchema.parse({
        enabled: true,
        screenshots_dir: 123,
      }),
    ).toThrow(ZodError);
  });

  it('PlaywrightConfig type is usable', () => {
    const config: PlaywrightConfig = {
      enabled: true,
      screenshots_dir: '.kova/screenshots',
    };
    expect(config.enabled).toBe(true);
  });

  it('loads config from repos.yaml with playwright section', async () => {
    const yaml = `
repos:
  pw-repo:
    path: /tmp/pw
    playwright:
      enabled: true
      screenshots_dir: custom/shots
      baseline_dir: custom/baselines
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['pw-repo'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.playwright?.enabled).toBe(true);
    expect(repo.playwright?.screenshots_dir).toBe('custom/shots');
    expect(repo.playwright?.baseline_dir).toBe('custom/baselines');
  });

  it('playwright section is optional (existing configs still work)', async () => {
    const yaml = `
repos:
  no-pw:
    path: /tmp/no-pw
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['no-pw'];
    expect(repo).toBeDefined();
    expect(repo?.playwright).toBeUndefined();
  });

  it('applies default screenshots_dir when loading from yaml', async () => {
    const yaml = `
repos:
  defaults-pw:
    path: /tmp/defaults-pw
    playwright:
      enabled: true
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['defaults-pw'];
    expect(repo).toBeDefined();
    if (!repo) return;

    expect(repo.playwright?.enabled).toBe(true);
    expect(repo.playwright?.screenshots_dir).toBe('.kova/screenshots');
  });

  it('rejects invalid playwright config in yaml (enabled not boolean)', async () => {
    const yaml = `
repos:
  bad-pw:
    path: /tmp/bad-pw
    playwright:
      enabled: "not-a-bool"
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });

  it('resolveRepoConfig has no playwright by default', () => {
    const config = resolveRepoConfig('/tmp/repo');
    expect(config.playwright).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  ci_merge config field                                              */
/* ------------------------------------------------------------------ */

describe('ci_merge config field', () => {
  it('parses ci_merge: warn correctly', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    rules:\n      ci_merge: warn\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['my-repo'];
    expect(repo).toBeDefined();
    expect(repo?.rules.ci_merge).toBe('warn');
  });

  it('defaults ci_merge to require when not specified', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['my-repo'];
    expect(repo).toBeDefined();
    expect(repo?.rules.ci_merge).toBe('require');
  });

  it('throws ZodError when ci_merge is invalid', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    rules:\n      ci_merge: invalid\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });
});

/* ------------------------------------------------------------------ */
/*  prompts_dir config field                                            */
/* ------------------------------------------------------------------ */

describe('prompts_dir config', () => {
  it('accepts prompts_dir as optional string', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    prompts_dir: ./kova-prompts/\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['my-repo'];
    expect(repo).toBeDefined();
    expect(repo?.prompts_dir).toBe('./kova-prompts/');
  });

  it('defaults prompts_dir to undefined when not specified', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['my-repo'];
    expect(repo).toBeDefined();
    expect(repo?.prompts_dir).toBeUndefined();
  });

  it('rejects non-string prompts_dir', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    prompts_dir:\n      - a\n      - b\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });
});

/* ------------------------------------------------------------------ */
/*  schedule block (issue #303 — cron scheduler)                       */
/* ------------------------------------------------------------------ */

describe('loadConfig schedule block', () => {
  it('accepts a valid schedule with one or more cron jobs', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    schedule:\n      backlog_sweep: '0 2 * * *'\n      weekly_audit: '0 0 * * 1'\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    const repo = config.repos['my-repo'];
    expect(repo?.schedule?.backlog_sweep).toBe('0 2 * * *');
    expect(repo?.schedule?.weekly_audit).toBe('0 0 * * 1');
  });

  it('omits schedule when not provided', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    expect(config.repos['my-repo']?.schedule).toBeUndefined();
  });

  it('rejects invalid cron expressions at config-load time', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    schedule:\n      bad_job: 'not a cron'\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });

  it('rejects empty job names', async () => {
    const yaml = `repos:\n  my-repo:\n    path: /tmp/my-repo\n    schedule:\n      '': '0 2 * * *'\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);

    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow(ZodError);
  });
});
