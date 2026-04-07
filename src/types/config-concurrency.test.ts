import { describe, expect, it } from 'vitest';
import type { RepoConfig } from './config.js';
import { RepoConfigSchema } from './config.js';

/* ------------------------------------------------------------------ */
/*  RepoConfigSchema — rules.concurrency field                         */
/* ------------------------------------------------------------------ */

describe('RepoConfigSchema — rules.concurrency', () => {
  it('parses config with rules.concurrency: 3', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: 3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules.concurrency).toBe(3);
    }
  });

  it('defaults concurrency to 1 when omitted', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules.concurrency).toBe(1);
    }
  });

  it('defaults concurrency to 1 when rules block is provided without concurrency', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { coverage: 90 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules.concurrency).toBe(1);
    }
  });

  it('rejects concurrency: 0 (must be positive)', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects concurrency: -1 (must be positive)', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects concurrency: 1.5 (must be integer)', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('preserves existing rules defaults when concurrency is provided', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules.coverage).toBe(80);
      expect(result.data.rules.auto_merge).toBe(false);
      expect(result.data.rules.max_issues_per_run).toBe(10);
      expect(result.data.rules.concurrency).toBe(5);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  RepoConfig type — rules.concurrency is typed as number             */
/* ------------------------------------------------------------------ */

describe('RepoConfig type — rules.concurrency', () => {
  it('RepoConfig type includes rules.concurrency as number', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      rules: { concurrency: 2 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const config: RepoConfig = result.data;
      // This line would cause a compile-time error if rules.concurrency
      // is not part of the RepoConfig type
      const concurrency: number = config.rules.concurrency;
      expect(concurrency).toBe(2);
    }
  });
});
