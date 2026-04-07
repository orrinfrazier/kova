import { describe, expect, it } from 'vitest';
import { resolveIsolationDefault, validateIsolation } from './isolation.js';

/* ------------------------------------------------------------------ */
/*  resolveIsolationDefault — OSS vs internal detection                */
/* ------------------------------------------------------------------ */

describe('resolveIsolationDefault', () => {
  // OSS repos on well-known public hosts → docker
  it('returns docker for github.com HTTPS', () => {
    expect(resolveIsolationDefault('https://github.com/user/repo')).toBe('docker');
  });

  it('returns docker for github.com SSH', () => {
    expect(resolveIsolationDefault('git@github.com:user/repo.git')).toBe('docker');
  });

  it('returns docker for gitlab.com HTTPS', () => {
    expect(resolveIsolationDefault('https://gitlab.com/org/repo')).toBe('docker');
  });

  it('returns docker for gitlab.com SSH', () => {
    expect(resolveIsolationDefault('git@gitlab.com:org/repo.git')).toBe('docker');
  });

  it('returns docker for bitbucket.org', () => {
    expect(resolveIsolationDefault('git@bitbucket.org:team/repo.git')).toBe('docker');
  });

  it('returns docker for codeberg.org', () => {
    expect(resolveIsolationDefault('https://codeberg.org/user/repo')).toBe('docker');
  });

  it('returns docker for sr.ht', () => {
    expect(resolveIsolationDefault('git@git.sr.ht:~user/repo')).toBe('docker');
  });

  // Internal/enterprise hosts → worktree
  it('returns worktree for enterprise GitHub (github.mycompany.com)', () => {
    expect(resolveIsolationDefault('https://github.mycompany.com/org/repo')).toBe('worktree');
  });

  it('returns worktree for private GitLab (gitlab.internal.net)', () => {
    expect(resolveIsolationDefault('https://gitlab.internal.net/team/repo')).toBe('worktree');
  });

  it('returns worktree for custom SSH host', () => {
    expect(resolveIsolationDefault('git@internal.corp:team/repo.git')).toBe('worktree');
  });

  // Edge cases → worktree (safe fallback)
  it('returns worktree for empty string', () => {
    expect(resolveIsolationDefault('')).toBe('worktree');
  });

  it('returns worktree for unparseable URL', () => {
    expect(resolveIsolationDefault('not-a-url')).toBe('worktree');
  });

  // Pure function check — no side effects
  it('is a pure function (same input → same output)', () => {
    const url = 'https://github.com/user/repo';
    expect(resolveIsolationDefault(url)).toBe(resolveIsolationDefault(url));
  });
});

/* ------------------------------------------------------------------ */
/*  validateIsolation — pre-flight check                               */
/* ------------------------------------------------------------------ */

describe('validateIsolation', () => {
  it('worktree is always valid', async () => {
    const result = await validateIsolation('worktree');
    expect(result).toEqual({ valid: true });
  });

  it('none is always valid', async () => {
    const result = await validateIsolation('none');
    expect(result).toEqual({ valid: true });
  });

  it('docker with missing binary returns invalid', async () => {
    const result = await validateIsolation('docker', 'docker-nonexistent-binary');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Docker/i);
  });

  it('docker error message includes actionable guidance', async () => {
    const result = await validateIsolation('docker', 'docker-nonexistent-binary');
    expect(result.error).toMatch(/install|running/i);
  });
});
