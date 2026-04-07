import { describe, expect, it } from 'vitest';
import type { AssessResult, Issue, QualityResult, ReviewResult, SpecResult, WaveResult } from '../types/index.js';
import { buildWaveContext, truncateToTokenBudget } from './context.js';

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    number: 42,
    title: 'Fix the login bug',
    body: 'Users get 500 when token expires',
    labels: ['bug', 'auth'],
    url: 'https://github.com/test/repo/issues/42',
    ...overrides,
  };
}

function makeWaveResult(wave: string, artifact: unknown): WaveResult {
  return {
    wave: wave as WaveResult['wave'],
    success: true,
    artifact,
    duration: 100,
    cost: 0.01,
    turns: 1,
  };
}

const assessArtifact: AssessResult = {
  grade: 'B',
  surface_area: {
    files: ['src/auth/token.ts', 'src/api/login.ts'],
    estimated_lines: 120,
    modules_affected: ['auth', 'api'],
  },
  risk: 'medium',
  reasoning: 'Token validation logic needs updating in 2 modules',
  should_proceed: true,
};

const specArtifact: SpecResult = {
  summary: 'Add token expiry check before API call',
  pieces: [
    {
      name: 'Token expiry validation',
      description: 'Check token TTL before making API request',
      files: ['src/auth/token.ts'],
      acceptance_criteria: ['Returns 401 when token expired', 'Refreshes token if within grace period'],
      wiring: ['Export from auth/index.ts'],
    },
  ],
  dependency_order: [],
  constraints: ['Must not break existing session flow'],
};

const qualityArtifact: QualityResult = {
  lint: 'pass',
  typecheck: 'pass',
  tests: 'pass',
  coverage: 85,
  audit: 'pass',
  all_passing: true,
};

const reviewArtifact: ReviewResult = {
  verdict: 'needs_fixes',
  findings: [
    {
      category: 'mechanical_fix',
      file: 'src/auth/token.ts',
      line: 42,
      description: 'Missing error handling for network timeout',
      severity: 'medium',
    },
  ],
  summary: 'One mechanical fix needed',
};

describe('buildWaveContext', () => {
  describe('spec wave', () => {
    it('includes issue title, body, and assessment summary', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);

      expect(ctx).toContain('Issue #42: Fix the login bug');
      expect(ctx).toContain('Users get 500 when token expires');
      expect(ctx).toContain('**Grade:** B');
      expect(ctx).toContain('**Risk:** medium');
      expect(ctx).toContain('src/auth/token.ts');
      expect(ctx).toContain('Token validation logic needs updating');
    });

    it('does NOT include raw JSON dump', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);

      expect(ctx).not.toContain('"grade":');
      expect(ctx).not.toContain('"surface_area":');
      expect(ctx).not.toContain('"should_proceed":');
    });
  });

  describe('test wave', () => {
    it('includes spec summary and acceptance criteria', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('test', makeIssue(), handoffs);

      expect(ctx).toContain('Add token expiry check before API call');
      expect(ctx).toContain('Token expiry validation');
      expect(ctx).toContain('Returns 401 when token expired');
      expect(ctx).toContain('Refreshes token if within grace period');
      expect(ctx).toContain('src/auth/token.ts');
    });

    it('does NOT include assess details', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('test', makeIssue(), handoffs);

      expect(ctx).not.toContain('**Grade:**');
      expect(ctx).not.toContain('should_proceed');
    });
  });

  describe('impl wave', () => {
    it('includes spec pieces and test file list', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        test: makeWaveResult('test', {
          test_files_created: ['src/auth/__tests__/token.test.ts'],
          test_count: 5,
          all_failing: true,
        }),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs);

      expect(ctx).toContain('Token expiry validation');
      expect(ctx).toContain('src/auth/__tests__/token.test.ts');
      expect(ctx).toContain('5 tests');
    });

    it('does NOT include assess details', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
        spec: makeWaveResult('spec', specArtifact),
        test: makeWaveResult('test', { test_files_created: [], test_count: 0, all_failing: true }),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs);

      expect(ctx).not.toContain('**Grade:**');
    });
  });

  describe('quality wave', () => {
    it('includes coverage threshold only — minimal context', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        impl: makeWaveResult('impl', {
          files_modified: ['src/auth/token.ts'],
          files_created: [],
          tests_passing: true,
          approach_notes: 'Added TTL check',
        }),
      };
      const ctx = buildWaveContext('quality', makeIssue(), handoffs, { coverageThreshold: 80 });

      expect(ctx).toContain('80%');
      // Quality wave should not get spec details — it just runs gates
      expect(ctx).not.toContain('Token expiry validation');
    });
  });

  describe('review wave', () => {
    it('includes spec summary and quality gate results', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs);

      expect(ctx).toContain('Add token expiry check before API call');
      expect(ctx).toContain('lint: pass');
      expect(ctx).toContain('coverage: 85%');
    });

    it('does NOT include assess details', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs);

      expect(ctx).not.toContain('**Grade:**');
      expect(ctx).not.toContain('should_proceed');
    });
  });

  describe('re-impl wave (review findings)', () => {
    it('includes review findings when passed', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        review: makeWaveResult('review', reviewArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { isReimpl: true });

      expect(ctx).toContain('Review findings');
      expect(ctx).toContain('Missing error handling for network timeout');
      expect(ctx).toContain('src/auth/token.ts');
      expect(ctx).toContain('line 42');
    });
  });

  describe('missing handoffs', () => {
    it('handles missing assess gracefully for spec wave', () => {
      const ctx = buildWaveContext('spec', makeIssue(), {});

      expect(ctx).toContain('Issue #42');
      expect(ctx).not.toContain('undefined');
      expect(ctx).not.toContain('null');
    });

    it('handles missing spec gracefully for test wave', () => {
      const ctx = buildWaveContext('test', makeIssue(), {});

      expect(ctx).not.toContain('undefined');
      expect(ctx).not.toContain('null');
    });
  });

  describe('PR context', () => {
    it('appends PR context when provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const prContext = '\n\n## Pending PRs (avoid conflicts)\n- #41: fix auth middleware (src/auth/middleware.ts)';
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { prContext });

      expect(ctx).toContain('Pending PRs');
      expect(ctx).toContain('#41');
    });

    it('does NOT append PR context to waves that do not need it', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const prContext = '\n\n## Pending PRs\n- #41: fix auth';
      const ctx = buildWaveContext('quality', makeIssue(), handoffs, { prContext });

      expect(ctx).not.toContain('Pending PRs');
    });
  });
});

describe('truncateToTokenBudget', () => {
  it('returns text unchanged when under budget', () => {
    const text = 'Short text';
    expect(truncateToTokenBudget(text, 1000)).toBe(text);
  });

  it('truncates text that exceeds budget', () => {
    // ~4 chars per token, 100 token budget = ~400 chars
    const longText = 'x'.repeat(2000);
    const result = truncateToTokenBudget(longText, 100);

    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain('[truncated');
  });

  it('preserves beginning of text when truncating', () => {
    const text = 'IMPORTANT_START ' + 'x'.repeat(2000);
    const result = truncateToTokenBudget(text, 100);

    expect(result).toContain('IMPORTANT_START');
  });
});
