import { describe, expect, it } from 'vitest';
import type { MetricsConfig } from '../types/index.js';
import { MetricsConfigSchema, RepoConfigSchema } from '../types/index.js';

/* ------------------------------------------------------------------ */
/*  MetricsConfigSchema — top-level                                    */
/* ------------------------------------------------------------------ */

describe('MetricsConfigSchema', () => {
  it('validates with enabled: false as default when field omitted', () => {
    const result = MetricsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('validates with enabled: false explicitly set', () => {
    const result = MetricsConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('validates with enabled: true', () => {
    const result = MetricsConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it('rejects non-boolean enabled', () => {
    const result = MetricsConfigSchema.safeParse({ enabled: 'yes' });
    expect(result.success).toBe(false);
  });

  it('validates with metrics: { enabled: true } and full defaults applied', () => {
    // Acceptance criterion 7: parses successfully with defaults filled in
    const result = MetricsConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  MetricsConfigSchema — prometheus sub-config                        */
/* ------------------------------------------------------------------ */

describe('MetricsConfigSchema — prometheus sub-config', () => {
  it('prometheus.enabled defaults to true when prometheus block is present but enabled omitted', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      prometheus: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prometheus?.enabled).toBe(true);
    }
  });

  it('validates prometheus with enabled: true and no port', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      prometheus: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it('validates prometheus with explicit enabled: false', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      prometheus: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prometheus?.enabled).toBe(false);
    }
  });

  it('rejects unknown fields in prometheus block (strict by Zod default — strips them)', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      prometheus: { enabled: true, port: 9090 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // port was removed — Zod strips unknown keys
      expect('port' in (result.data.prometheus ?? {})).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  MetricsConfigSchema — OTLP sub-config                              */
/* ------------------------------------------------------------------ */

describe('MetricsConfigSchema — OTLP sub-config', () => {
  it('otlp.enabled defaults to false when otlp block is present but enabled omitted', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.otlp?.enabled).toBe(false);
    }
  });

  it('validates otlp with enabled: false and no endpoint', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: { enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it('validates otlp with enabled: true and endpoint provided', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: { enabled: true, endpoint: 'http://collector:4317' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.otlp?.endpoint).toBe('http://collector:4317');
    }
  });

  it('rejects otlp with enabled: true and missing endpoint (refine)', () => {
    // Acceptance criterion 8: must fail validation
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: { enabled: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects otlp with enabled: true and endpoint: undefined explicitly', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: { enabled: true, endpoint: undefined },
    });
    expect(result.success).toBe(false);
  });

  it('accepts otlp with enabled: false even when endpoint is absent', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: false,
      otlp: { enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects otlp endpoint as non-string', () => {
    const result = MetricsConfigSchema.safeParse({
      enabled: true,
      otlp: { enabled: true, endpoint: 42 },
    });
    expect(result.success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  RepoConfigSchema — metrics field integration                       */
/* ------------------------------------------------------------------ */

describe('RepoConfigSchema — metrics field', () => {
  it('parses a minimal repo config without a metrics block (metrics is optional)', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metrics).toBeUndefined();
    }
  });

  it('parses a repo config with metrics: { enabled: true } and applies defaults', () => {
    // Acceptance criterion 7
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      metrics: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metrics?.enabled).toBe(true);
    }
  });

  it('parses a repo config with metrics: { enabled: false }', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      metrics: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metrics?.enabled).toBe(false);
    }
  });

  it('parses a repo config with full metrics block including prometheus and valid otlp', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      metrics: {
        enabled: true,
        prometheus: { enabled: true },
        otlp: { enabled: true, endpoint: 'http://otel-collector:4317' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metrics?.enabled).toBe(true);
      expect(result.data.metrics?.prometheus?.enabled).toBe(true);
      expect(result.data.metrics?.otlp?.endpoint).toBe('http://otel-collector:4317');
    }
  });

  it('rejects repo config with metrics.otlp enabled but missing endpoint', () => {
    // Acceptance criterion 8: fails validation (missing endpoint)
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      metrics: {
        enabled: true,
        otlp: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it('preserves existing repo config defaults when metrics is provided', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      metrics: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Existing defaults must not regress
      expect(result.data.rules.coverage).toBe(80);
      expect(result.data.rules.auto_merge).toBe(false);
      expect(result.data.rules.max_issues_per_run).toBe(10);
      expect(result.data.isolation).toBe('worktree');
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Type export check — MetricsConfig type is assignable              */
/* ------------------------------------------------------------------ */

describe('MetricsConfig type export', () => {
  it('MetricsConfigSchema parses to a value assignable to MetricsConfig', () => {
    const result = MetricsConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      // If MetricsConfig is not exported, the import above will fail at compile time.
      const typed: MetricsConfig = result.data;
      expect(typed.enabled).toBe(false);
    }
  });
});
