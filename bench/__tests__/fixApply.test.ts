// Unit tests for bench/fixApply.ts — focuses on the default RepoConfig
// builder added for issue #373. The real `fix()` call path is exercised
// by `npm run bench` (opt-in) and is intentionally NOT mocked here.

import { describe, expect, it } from 'vitest';
import { buildDefaultBenchConfig } from '../fixApply.js';

describe('buildDefaultBenchConfig', () => {
  it('returns a valid RepoConfig for a workdir without repos.yaml', () => {
    // The default config must parse cleanly with no filesystem access —
    // fixture seed repos under bench/fixtures/<id>/repo/ do not ship a
    // repos.yaml, so resolveRepoConfig must not be required.
    const config = buildDefaultBenchConfig('/tmp/some-bench-workdir');
    expect(config.path).toBe('/tmp/some-bench-workdir');
    // RepoConfigSchema fills these via Zod defaults — assert the shape
    // we depend on for fix() invocation.
    expect(config.rules).toBeDefined();
    expect(config.rules.coverage).toBe(80);
    expect(config.rules.concurrency).toBe(1);
    expect(config.model).toBeDefined();
    expect(config.model.assess).toBeDefined();
    expect(config.isolation).toBe('worktree');
  });

  it('applies an override on top of the default config (shallow merge)', () => {
    const config = buildDefaultBenchConfig('/tmp/wd', {
      rules: {
        coverage: 50,
        auto_merge: false,
        max_issues_per_run: 10,
        ci_merge: 'require',
        review_merge: 'require',
        concurrency: 2,
      },
    });
    expect(config.rules.coverage).toBe(50);
    expect(config.rules.concurrency).toBe(2);
    // path comes from the workdir argument even when override is supplied
    expect(config.path).toBe('/tmp/wd');
  });

  it('override path takes precedence when explicitly set', () => {
    const config = buildDefaultBenchConfig('/tmp/wd', { path: '/override/path' });
    expect(config.path).toBe('/override/path');
  });

  it('returns a config that does not require a real repos.yaml on disk', () => {
    // Pointing at a path that definitely has no repos.yaml — the builder
    // must not throw and must not attempt to read the filesystem.
    const config = buildDefaultBenchConfig('/this/path/does/not/exist');
    expect(config.path).toBe('/this/path/does/not/exist');
    expect(config.providers).toBeUndefined();
  });
});
