import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetectedTooling } from '../core/language-detect.js';
import type { RepoConfig } from '../types/index.js';
import { ensureScreenshotsDir, isPlaywrightEnabled, resolvePlaywrightEnv } from './playwright.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeTooling(overrides: Partial<DetectedTooling> = {}): DetectedTooling {
  return {
    language: 'typescript',
    testRunner: 'vitest',
    linter: 'biome',
    formatter: 'biome',
    packageManager: 'npm',
    repoType: 'frontend',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    path: '/tmp/repo',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
      concurrency: 1,
    },
    model: {
      assess: 'large',
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
      brainstorm: 'large',
    },
    isolation: 'worktree',
    runtime: 'pi',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  isPlaywrightEnabled                                                */
/* ------------------------------------------------------------------ */

describe('isPlaywrightEnabled', () => {
  it('returns true for frontend repos with playwright.enabled=true', () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'frontend' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(true);
  });

  it('returns false when playwright.enabled=false', () => {
    const config = makeConfig({
      playwright: { enabled: false, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'frontend' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(false);
  });

  it('returns false when repoType is not frontend even if playwright.enabled=true', () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'backend' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(false);
  });

  it('returns false when repoType is unknown even if playwright.enabled=true', () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'unknown' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(false);
  });

  it('returns false when config has no playwright section', () => {
    const config = makeConfig();
    const tooling = makeTooling({ repoType: 'frontend' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(false);
  });

  it('returns false when config has no playwright section and repoType is backend', () => {
    const config = makeConfig();
    const tooling = makeTooling({ repoType: 'backend' });

    expect(isPlaywrightEnabled(config, tooling)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  resolvePlaywrightEnv                                               */
/* ------------------------------------------------------------------ */

describe('resolvePlaywrightEnv', () => {
  it('returns PLAYWRIGHT_MCP_ENABLED and PLAYWRIGHT_SCREENSHOTS_DIR when enabled', () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'frontend' });

    const env = resolvePlaywrightEnv(config, tooling);

    expect(env).toEqual({
      PLAYWRIGHT_MCP_ENABLED: 'true',
      PLAYWRIGHT_SCREENSHOTS_DIR: '.kova/screenshots',
    });
  });

  it('returns empty object when not enabled (enabled=false)', () => {
    const config = makeConfig({
      playwright: { enabled: false, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'frontend' });

    const env = resolvePlaywrightEnv(config, tooling);

    expect(env).toEqual({});
  });

  it('returns empty object when repoType is not frontend', () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });
    const tooling = makeTooling({ repoType: 'backend' });

    const env = resolvePlaywrightEnv(config, tooling);

    expect(env).toEqual({});
  });

  it('returns empty object when config has no playwright section', () => {
    const config = makeConfig();
    const tooling = makeTooling({ repoType: 'frontend' });

    const env = resolvePlaywrightEnv(config, tooling);

    expect(env).toEqual({});
  });

  it('uses default screenshots_dir when not specified in config', () => {
    const config = makeConfig({
      playwright: { enabled: true },
    });
    const tooling = makeTooling({ repoType: 'frontend' });

    const env = resolvePlaywrightEnv(config, tooling);

    expect(env.PLAYWRIGHT_MCP_ENABLED).toBe('true');
    expect(env.PLAYWRIGHT_SCREENSHOTS_DIR).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  ensureScreenshotsDir                                               */
/* ------------------------------------------------------------------ */

describe('ensureScreenshotsDir', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `kova-pw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates .kova/screenshots/ directory', async () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });

    const dir = await ensureScreenshotsDir(workDir, config);

    expect(dir).toBe(join(workDir, '.kova/screenshots'));
    const entries = await readdir(join(workDir, '.kova'));
    expect(entries).toContain('screenshots');
  });

  it('uses custom screenshots_dir from config when specified', async () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: 'custom/shots' },
    });

    const dir = await ensureScreenshotsDir(workDir, config);

    expect(dir).toBe(join(workDir, 'custom/shots'));
    const entries = await readdir(join(workDir, 'custom'));
    expect(entries).toContain('shots');
  });

  it('uses default .kova/screenshots when config has no playwright section', async () => {
    const config = makeConfig();

    const dir = await ensureScreenshotsDir(workDir, config);

    expect(dir).toBe(join(workDir, '.kova/screenshots'));
    const entries = await readdir(join(workDir, '.kova'));
    expect(entries).toContain('screenshots');
  });

  it('is idempotent — calling twice does not throw', async () => {
    const config = makeConfig({
      playwright: { enabled: true, screenshots_dir: '.kova/screenshots' },
    });

    await ensureScreenshotsDir(workDir, config);
    const dir = await ensureScreenshotsDir(workDir, config);

    expect(dir).toBe(join(workDir, '.kova/screenshots'));
  });
});
