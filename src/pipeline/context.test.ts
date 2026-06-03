import { describe, expect, it } from 'vitest';
import type { SymbolHit } from '../ai/codegraph.js';
import type { CodeChunk } from '../services/vectordb.js';
import type {
  AssessResult,
  Issue,
  QualityRemediation,
  QualityResult,
  ReviewResult,
  SpecPiece,
  SpecResult,
  WaveResult,
} from '../types/index.js';
import {
  buildPieceContext,
  buildWaveContext,
  estimateTokens,
  extractCandidateSymbols,
  formatGraphContext,
  mergeGraphAndVectorContext,
  queryCodeGraphContext,
  truncateToTokenBudget,
} from './context.js';

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

  describe('impl wave — escalation hint', () => {
    it('includes escalation hint when provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, {
        escalationHint: 'Previous approach failed. Try a different algorithm.',
      });

      expect(ctx).toContain('Escalation');
      expect(ctx).toContain('Previous approach failed. Try a different algorithm.');
    });

    it('does NOT include escalation section when hint is absent', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs);

      expect(ctx).not.toContain('Escalation');
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

  describe('codebase context (vector DB)', () => {
    it('injects codebase context into spec wave when provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const codebaseContext =
        '## Relevant code from the codebase\n\n### src/auth/token.ts\n```\nfunction validate() {}\n```';
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { codebaseContext });

      expect(ctx).toContain('Relevant code from the codebase');
      expect(ctx).toContain('src/auth/token.ts');
    });

    it('injects codebase context into impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const codebaseContext = '## Relevant code from the codebase\n\n### src/utils.ts\n```\nconst x = 1;\n```';
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { codebaseContext });

      expect(ctx).toContain('Relevant code from the codebase');
    });

    it('does NOT inject codebase context into quality wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {};
      const codebaseContext = '## Relevant code from the codebase\n\ncontent';
      const ctx = buildWaveContext('quality', makeIssue(), handoffs, { codebaseContext });

      expect(ctx).not.toContain('Relevant code from the codebase');
    });

    it('does NOT inject codebase context into review wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const codebaseContext = '## Relevant code from the codebase\n\ncontent';
      const ctx = buildWaveContext('review', makeIssue(), handoffs, { codebaseContext });

      expect(ctx).not.toContain('Relevant code from the codebase');
    });

    it('omits codebase section when not provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);

      expect(ctx).not.toContain('Relevant code from the codebase');
    });
  });

  // ---- Issue #273 — codegraphContext injection -----------------------------

  describe('codegraph context (issue #273)', () => {
    const codegraphContext =
      '## Code graph context\n\n### formatCodeChunks (function)\n`src/services/vectordb.ts:L76-L89` — function formatCodeChunks(chunks)\n\n**Callers:** queryCodeContext (src/services/vectordb.ts:L34)\n**Callees:** none\n';
    const codebaseContext = '## Relevant code from the codebase\n\n### src/services/vectordb.ts\n```\n// chunk\n```';

    it('injects codegraph context into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { codegraphContext });
      expect(ctx).toContain('## Code graph context');
      expect(ctx).toContain('formatCodeChunks');
    });

    it('injects codegraph context into impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { codegraphContext });
      expect(ctx).toContain('## Code graph context');
    });

    it('places codegraph context ABOVE the fuzzy codebase context in spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { codegraphContext, codebaseContext });
      const codegraphIdx = ctx.indexOf('## Code graph context');
      const codebaseIdx = ctx.indexOf('## Relevant code from the codebase');
      expect(codegraphIdx).toBeGreaterThanOrEqual(0);
      expect(codebaseIdx).toBeGreaterThanOrEqual(0);
      expect(codegraphIdx).toBeLessThan(codebaseIdx);
    });

    it('places codegraph context ABOVE the fuzzy codebase context in impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { codegraphContext, codebaseContext });
      const codegraphIdx = ctx.indexOf('## Code graph context');
      const codebaseIdx = ctx.indexOf('## Relevant code from the codebase');
      expect(codegraphIdx).toBeGreaterThanOrEqual(0);
      expect(codebaseIdx).toBeGreaterThanOrEqual(0);
      expect(codegraphIdx).toBeLessThan(codebaseIdx);
    });

    it('omits codegraph section when not provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);
      expect(ctx).not.toContain('## Code graph context');
    });

    it('does NOT inject codegraph context into quality wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {};
      const ctx = buildWaveContext('quality', makeIssue(), handoffs, { codegraphContext });
      expect(ctx).not.toContain('## Code graph context');
    });

    it('does NOT inject codegraph context into review wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs, { codegraphContext });
      expect(ctx).not.toContain('## Code graph context');
    });
  });

  // ---- Issue #275 — callPathContext injection ------------------------------

  describe('framework call-path context (issue #275)', () => {
    const callPathContext =
      '## Framework call paths\n\n### GET /users → listUsers\n`src/api/users.ts:L42-L60` — function listUsers(req, res)\n\n**Callers:** registerRoutes (src/api/index.ts:L8)\n**Callees:** queryUsers (src/services/users.ts:L12)\n';
    const codegraphContext =
      '## Code graph context\n\n### formatCodeChunks (function)\n`src/services/vectordb.ts:L76-L89` — function formatCodeChunks(chunks)\n';
    const codebaseContext = '## Relevant code from the codebase\n\n### src/services/vectordb.ts\n```\n// chunk\n```';

    it('injects call-path context into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { callPathContext });
      expect(ctx).toContain('## Framework call paths');
      expect(ctx).toContain('GET /users');
    });

    it('injects call-path context into impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { callPathContext });
      expect(ctx).toContain('## Framework call paths');
    });

    it('orders sections codegraph -> call-path -> codebase in spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, {
        callPathContext,
        codegraphContext,
        codebaseContext,
      });
      const codegraphIdx = ctx.indexOf('## Code graph context');
      const callPathIdx = ctx.indexOf('## Framework call paths');
      const codebaseIdx = ctx.indexOf('## Relevant code from the codebase');
      expect(codegraphIdx).toBeGreaterThanOrEqual(0);
      expect(callPathIdx).toBeGreaterThanOrEqual(0);
      expect(codebaseIdx).toBeGreaterThanOrEqual(0);
      expect(codegraphIdx).toBeLessThan(callPathIdx);
      expect(callPathIdx).toBeLessThan(codebaseIdx);
    });

    it('orders sections codegraph -> call-path -> codebase in impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, {
        callPathContext,
        codegraphContext,
        codebaseContext,
      });
      const codegraphIdx = ctx.indexOf('## Code graph context');
      const callPathIdx = ctx.indexOf('## Framework call paths');
      const codebaseIdx = ctx.indexOf('## Relevant code from the codebase');
      expect(codegraphIdx).toBeLessThan(callPathIdx);
      expect(callPathIdx).toBeLessThan(codebaseIdx);
    });

    it('omits call-path section when not provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);
      expect(ctx).not.toContain('## Framework call paths');
    });

    it('does NOT inject call-path context into assess wave', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { callPathContext });
      expect(ctx).not.toContain('## Framework call paths');
    });

    it('does NOT inject call-path context into test wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('test', makeIssue(), handoffs, { callPathContext });
      expect(ctx).not.toContain('## Framework call paths');
    });

    it('does NOT inject call-path context into quality wave', () => {
      const ctx = buildWaveContext('quality', makeIssue(), {}, { callPathContext });
      expect(ctx).not.toContain('## Framework call paths');
    });

    it('does NOT inject call-path context into review wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs, { callPathContext });
      expect(ctx).not.toContain('## Framework call paths');
    });
  });

  describe('episodic context (past learnings)', () => {
    const episodicContext =
      '## Learnings from similar past issues\n\n### #10: Fix token expiry handling\n- **Approach:** Added TTL check\n- **Outcome:** success\n- **Learning:** Token refresh must happen before the API call';

    it('injects episodic context into assess wave', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { episodicContext });
      expect(ctx).toContain('Learnings from similar past issues');
      expect(ctx).toContain('#10: Fix token expiry handling');
    });

    it('injects episodic context into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { episodicContext });
      expect(ctx).toContain('Learnings from similar past issues');
    });

    it('does NOT inject episodic context into test wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('test', makeIssue(), handoffs, { episodicContext });
      expect(ctx).not.toContain('Learnings from similar past issues');
    });

    it('does NOT inject episodic context into impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { episodicContext });
      expect(ctx).not.toContain('Learnings from similar past issues');
    });

    it('does NOT inject episodic context into quality wave', () => {
      const ctx = buildWaveContext('quality', makeIssue(), {}, { episodicContext });
      expect(ctx).not.toContain('Learnings from similar past issues');
    });

    it('does NOT inject episodic context into review wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs, { episodicContext });
      expect(ctx).not.toContain('Learnings from similar past issues');
    });

    it('omits episodic section when not provided', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {});
      expect(ctx).not.toContain('Learnings from similar past issues');
    });
  });

  describe('playbook context (#299 — synthesized procedural knowledge)', () => {
    const playbookContext =
      '## Playbook: Auth middleware fixes\n\n**Trigger:** labels=bug,auth; language=typescript\n\n### Steps\n1. Check token expiry before API call\n2. Add a mutex around refresh\n\n### Gotchas\n- Refresh order matters\n\n### Files to touch\n- src/auth/middleware.ts';

    it('injects playbook context into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { playbookContext });
      expect(ctx).toContain('Playbook: Auth middleware fixes');
      expect(ctx).toContain('Check token expiry before API call');
      expect(ctx).toContain('Refresh order matters');
    });

    it('does NOT inject playbook context into test wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('test', makeIssue(), handoffs, { playbookContext });
      expect(ctx).not.toContain('Playbook: Auth middleware fixes');
    });

    it('does NOT inject playbook context into impl wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
      };
      const ctx = buildWaveContext('impl', makeIssue(), handoffs, { playbookContext });
      expect(ctx).not.toContain('Playbook: Auth middleware fixes');
    });

    it('does NOT inject playbook context into assess wave (spec only)', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { playbookContext });
      expect(ctx).not.toContain('Playbook: Auth middleware fixes');
    });

    it('omits playbook section when not provided', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs);
      expect(ctx).not.toContain('Playbook:');
    });
  });

  describe('assess wave', () => {
    it('includes issue title and body', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {});
      expect(ctx).toContain('Issue #42: Fix the login bug');
      expect(ctx).toContain('Users get 500 when token expires');
    });

    it('includes labels', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {});
      expect(ctx).toContain('bug');
      expect(ctx).toContain('auth');
    });
  });

  describe('repo-intel context injection', () => {
    const repoContextText = '## Repository context\n\nMonorepo with src/api and src/auth modules.';
    const repoSearchText = '## Similar implementations\n\nfunction validateToken() {}';
    const repoStandardsText = '## Project standards\n\nVitest for testing, Biome for linting';

    it('injects repo context into assess wave', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { repoContextText });
      expect(ctx).toContain('Repository context');
      expect(ctx).toContain('Monorepo with src/api and src/auth modules.');
    });

    it('does NOT inject repo context into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { repoContextText });
      expect(ctx).not.toContain('Repository context');
    });

    it('injects repo search into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { repoSearchText });
      expect(ctx).toContain('Similar implementations');
      expect(ctx).toContain('validateToken');
    });

    it('does NOT inject repo search into assess wave', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { repoSearchText });
      expect(ctx).not.toContain('Similar implementations');
    });

    it('does NOT inject repo search into quality wave', () => {
      const ctx = buildWaveContext('quality', makeIssue(), {}, { repoSearchText });
      expect(ctx).not.toContain('Similar implementations');
    });

    it('injects repo standards into quality wave', () => {
      const ctx = buildWaveContext('quality', makeIssue(), {}, { repoStandardsText });
      expect(ctx).toContain('Project standards');
      expect(ctx).toContain('Vitest for testing');
    });

    it('does NOT inject repo standards into assess wave', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {}, { repoStandardsText });
      expect(ctx).not.toContain('Project standards');
    });

    it('does NOT inject repo standards into spec wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        assess: makeWaveResult('assess', assessArtifact),
      };
      const ctx = buildWaveContext('spec', makeIssue(), handoffs, { repoStandardsText });
      expect(ctx).not.toContain('Project standards');
    });

    it('does NOT inject repo standards into review wave', () => {
      const handoffs: Partial<Record<string, WaveResult>> = {
        spec: makeWaveResult('spec', specArtifact),
        quality: makeWaveResult('quality', qualityArtifact),
      };
      const ctx = buildWaveContext('review', makeIssue(), handoffs, { repoStandardsText });
      expect(ctx).not.toContain('Project standards');
    });

    it('omits all repo-intel sections when not provided', () => {
      const ctx = buildWaveContext('assess', makeIssue(), {});
      expect(ctx).not.toContain('Repository context');
      expect(ctx).not.toContain('Similar implementations');
      expect(ctx).not.toContain('Project standards');
    });
  });
});

describe('estimateTokens', () => {
  it('estimates code content with ~3.5 chars/token ratio', () => {
    const code = `function parseArgs(argv: string[]): Config {
  const config: Config = { verbose: false };
  for (const arg of argv) {
    if (arg === '--verbose') {
      config.verbose = true;
    } else if (arg.startsWith('--output=')) {
      config.output = arg.slice(9);
    }
  }
  return config;
}`;
    const tokens = estimateTokens(code);
    const oldEstimate = Math.ceil(code.length / 4);
    expect(tokens).toBeGreaterThan(oldEstimate);
  });

  it('estimates prose content with ~4.5 chars/token ratio', () => {
    const prose =
      'The authentication system validates user credentials against the database. ' +
      'When a token expires, the system should gracefully redirect the user to the login page. ' +
      'This ensures a smooth user experience while maintaining security best practices.';
    const tokens = estimateTokens(prose);
    const oldEstimate = Math.ceil(prose.length / 4);
    expect(tokens).toBeLessThan(oldEstimate);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles mixed content (code + prose)', () => {
    const mixed = `## Overview
This module handles token validation for the auth layer.

\`\`\`typescript
export function validateToken(token: string): boolean {
  if (!token || token.length === 0) {
    return false;
  }
  const decoded = decodeJwt(token);
  return decoded.exp > Date.now() / 1000;
}
\`\`\`

The function checks expiration before allowing access.`;
    const tokens = estimateTokens(mixed);
    expect(tokens).toBeGreaterThan(0);
    const impliedRatio = mixed.length / tokens;
    expect(impliedRatio).toBeGreaterThanOrEqual(3.5);
    expect(impliedRatio).toBeLessThanOrEqual(4.5);
  });
});

describe('truncateToTokenBudget', () => {
  it('returns text unchanged when under budget', () => {
    const text = 'Short text';
    expect(truncateToTokenBudget(text, 1000)).toBe(text);
  });

  it('truncates text that exceeds budget', () => {
    const longText = 'x'.repeat(2000);
    const result = truncateToTokenBudget(longText, 100);

    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain('[truncated');
  });

  it('preserves beginning of text when truncating', () => {
    const text = `IMPORTANT_START ${'x'.repeat(2000)}`;
    const result = truncateToTokenBudget(text, 100);

    expect(result).toContain('IMPORTANT_START');
  });

  it('uses content-aware estimation for code content', () => {
    const code = 'const x = 1;\n'.repeat(200);
    const result = truncateToTokenBudget(code, 100);
    expect(result).toContain('[truncated');
    const truncatedContent = result.split('\n\n[truncated')[0];
    expect(truncatedContent).toBeDefined();
    expect(truncatedContent?.length).toBeLessThan(400);
  });

  it('uses content-aware estimation for prose content', () => {
    const word = 'authentication ';
    const prose = word.repeat(200);
    const result = truncateToTokenBudget(prose, 100);
    expect(result).toContain('[truncated');
    const truncatedContent = result.split('\n\n[truncated')[0];
    expect(truncatedContent).toBeDefined();
    expect(truncatedContent?.length).toBeGreaterThan(400);
  });
});

// --- buildPieceContext ---

describe('buildPieceContext', () => {
  const piece: SpecPiece = {
    name: 'Token expiry validation',
    description: 'Check token TTL before making API request',
    files: ['src/auth/token.ts', 'src/auth/refresh.ts'],
    acceptance_criteria: ['Returns 401 when token expired', 'Refreshes token if within grace period'],
    wiring: ['Export from auth/index.ts'],
  };

  it('includes piece name and description', () => {
    const ctx = buildPieceContext('test', piece);
    expect(ctx).toContain('Token expiry validation');
    expect(ctx).toContain('Check token TTL before making API request');
  });

  it('includes files with "ONLY modify these" restriction', () => {
    const ctx = buildPieceContext('test', piece);
    expect(ctx).toContain('ONLY modify these');
    expect(ctx).toContain('src/auth/token.ts');
    expect(ctx).toContain('src/auth/refresh.ts');
  });

  it('includes acceptance criteria', () => {
    const ctx = buildPieceContext('test', piece);
    expect(ctx).toContain('Acceptance Criteria');
    expect(ctx).toContain('Returns 401 when token expired');
    expect(ctx).toContain('Refreshes token if within grace period');
  });

  it('includes wiring when present', () => {
    const ctx = buildPieceContext('test', piece);
    expect(ctx).toContain('Wiring');
    expect(ctx).toContain('Export from auth/index.ts');
  });

  it('omits wiring section when empty', () => {
    const noWiring = { ...piece, wiring: [] };
    const ctx = buildPieceContext('test', noWiring);
    expect(ctx).not.toContain('Wiring');
  });

  it('does NOT include full spec fields', () => {
    const ctx = buildPieceContext('test', piece);
    // Should not contain spec-level fields like summary or dependency_order
    expect(ctx).not.toContain('dependency_order');
    expect(ctx).not.toContain('constraints');
  });

  it('includes escalation hint for impl wave when provided', () => {
    const ctx = buildPieceContext('impl', piece, {
      escalationHint: 'Try a different algorithm',
    });
    expect(ctx).toContain('Escalation');
    expect(ctx).toContain('Try a different algorithm');
  });

  it('does NOT include escalation for test wave', () => {
    const ctx = buildPieceContext('test', piece, {
      escalationHint: 'Try a different algorithm',
    });
    expect(ctx).not.toContain('Escalation');
  });

  it('includes last failure output for impl wave when provided', () => {
    const ctx = buildPieceContext('impl', piece, {
      lastFailureOutput: 'Error: cannot find module',
    });
    expect(ctx).toContain('Previous Test Failure Output');
    expect(ctx).toContain('Error: cannot find module');
  });

  it('truncates to token budget', () => {
    const longPiece: SpecPiece = {
      ...piece,
      description: 'x'.repeat(100_000),
    };
    const ctx = buildPieceContext('test', longPiece, { tokenBudget: 100 });
    expect(ctx).toContain('truncated');
  });
});

// --- Review feedback context (Piece 5 of #48) ---

describe('review wave — past feedback injection', () => {
  const reviewFeedbackContext =
    '## Past Reviewer Feedback\n\n' +
    '### PR #38: Token refresh logic\n' +
    '- Reviewer flagged missing error boundary around refresh call\n' +
    '- Suggestion: add retry with exponential backoff\n' +
    '### PR #35: Auth middleware\n' +
    '- Reviewer requested integration test coverage for edge cases';

  it('includes reviewFeedbackContext in review wave when provided', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { reviewFeedbackContext });

    expect(ctx).toContain('Past Reviewer Feedback');
    expect(ctx).toContain('PR #38: Token refresh logic');
    expect(ctx).toContain('missing error boundary around refresh call');
    expect(ctx).toContain('PR #35: Auth middleware');
  });

  it('omits feedback section when reviewFeedbackContext is undefined', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, {});

    expect(ctx).not.toContain('Past Reviewer Feedback');
  });

  it('omits feedback section when reviewFeedbackContext is empty string', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { reviewFeedbackContext: '' });

    expect(ctx).not.toContain('Past Reviewer Feedback');
  });

  it('still includes spec summary and quality gates alongside feedback', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { reviewFeedbackContext });

    // Existing review context sections must still be present
    expect(ctx).toContain('Spec Summary');
    expect(ctx).toContain('Add token expiry check before API call');
    expect(ctx).toContain('Quality Gates');
    expect(ctx).toContain('lint: pass');
    expect(ctx).toContain('coverage: 85%');

    // And the feedback section is also present
    expect(ctx).toContain('Past Reviewer Feedback');
  });
});

// --- Structured quality remediation output (Issue #218) ---

describe('review wave — QualityRemediation structured output', () => {
  const remediationArtifact: QualityRemediation = {
    gates: [
      {
        gate: 'lint',
        status: 'passed',
        auto_fixable: true,
        fix_applied: true,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'typecheck',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'tests',
        status: 'failed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: ['test/auth.test.ts: assertion failed at line 42'],
        suggested_action: 'retry_impl',
      },
      {
        gate: 'coverage',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'audit',
        status: 'skipped',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'secrets',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
    ],
    all_passing: false,
    coverage_percent: 82,
    auto_fixes_applied: ['Fixed trailing comma in src/index.ts'],
    files_modified: ['src/index.ts'],
  };

  it('formats QualityRemediation in review wave context', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', remediationArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs);

    expect(ctx).toContain('Quality Gates');
    // Should include per-gate status
    expect(ctx).toContain('lint: passed');
    expect(ctx).toContain('typecheck: passed');
    expect(ctx).toContain('tests: failed');
    expect(ctx).toContain('audit: skipped');
    expect(ctx).toContain('coverage: 82%');
  });

  it('includes remaining errors for failed gates', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', remediationArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs);

    expect(ctx).toContain('assertion failed at line 42');
  });

  it('includes suggested actions for failed gates', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', remediationArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs);

    expect(ctx).toContain('retry_impl');
  });

  it('still formats legacy QualityResult correctly', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs);

    expect(ctx).toContain('Quality Gates');
    expect(ctx).toContain('lint: pass');
    expect(ctx).toContain('coverage: 85%');
    expect(ctx).toContain('all passing: true');
  });
});

// --- Hybrid graph+vector retrieval (Issue #274) ---

describe('extractCandidateSymbols', () => {
  it('extracts CamelCase identifiers', () => {
    const symbols = extractCandidateSymbols('UserService and AuthMiddleware should be refactored');
    expect(symbols).toContain('UserService');
    expect(symbols).toContain('AuthMiddleware');
  });

  it('extracts camelCase function-style identifiers', () => {
    const symbols = extractCandidateSymbols('Fix queryCodeContext and refactor formatCodeChunks');
    expect(symbols).toContain('queryCodeContext');
    expect(symbols).toContain('formatCodeChunks');
  });

  it('extracts identifiers from inline code snippets (backticks)', () => {
    const symbols = extractCandidateSymbols('See `findRelevantContext` (context/index.ts:394)');
    expect(symbols).toContain('findRelevantContext');
  });

  it('does NOT pick up plain English words (lowercase singletons)', () => {
    const symbols = extractCandidateSymbols('the issue describes a bug in the login flow');
    expect(symbols).not.toContain('the');
    expect(symbols).not.toContain('issue');
    expect(symbols).not.toContain('bug');
  });

  it('filters known common-word false-positives (Issue, Should, This, etc.)', () => {
    const symbols = extractCandidateSymbols('Issue should not match. This either. Add new symbol.');
    expect(symbols).not.toContain('Issue');
    expect(symbols).not.toContain('Should');
    expect(symbols).not.toContain('This');
  });

  it('deduplicates repeated identifiers', () => {
    const symbols = extractCandidateSymbols('queryCodeContext queryCodeContext queryCodeContext');
    const occurrences = symbols.filter((s) => s === 'queryCodeContext').length;
    expect(occurrences).toBe(1);
  });

  it('returns an empty array for empty input', () => {
    expect(extractCandidateSymbols('')).toEqual([]);
    expect(extractCandidateSymbols('   ')).toEqual([]);
  });

  it('caps the number of returned symbols (avoids unbounded growth)', () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Symbol${i}Name`).join(' ');
    const symbols = extractCandidateSymbols(longText);
    expect(symbols.length).toBeLessThanOrEqual(50);
  });
});

describe('queryCodeGraphContext', () => {
  type ExecResult = { stdout: string; stderr: string; code: number };
  const makeExec = (map: Record<string, ExecResult | Error>) => {
    return async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`.trim();
      const v = map[key];
      if (v === undefined) {
        throw Object.assign(new Error(`command not found: ${cmd}`), { code: 'ENOENT' });
      }
      if (v instanceof Error) throw v;
      if (v.code !== 0) {
        throw Object.assign(new Error(`exit ${v.code}: ${v.stderr || v.stdout}`), {
          code: v.code,
          stdout: v.stdout,
          stderr: v.stderr,
        });
      }
      return v;
    };
  };

  it('returns empty result when no candidate symbols in issue text', async () => {
    const exec = makeExec({});
    const result = await queryCodeGraphContext('/work', 'fix the bug please', { exec });
    expect(result.resolvedSymbols).toEqual([]);
    expect(result.unresolvedQueries).toEqual([]);
  });

  it('resolves a single symbol via find-symbol + adds 1-hop callers', async () => {
    const exec = makeExec({
      'codegraph find-symbol queryCodeContext --json --cwd /work': {
        stdout: JSON.stringify([
          {
            symbol: 'queryCodeContext',
            file: 'src/services/vectordb.ts',
            startLine: 34,
            endLine: 70,
            kind: 'function',
          },
        ]),
        stderr: '',
        code: 0,
      },
      'codegraph callers queryCodeContext --json --cwd /work': {
        stdout: JSON.stringify([
          { symbol: 'fix', file: 'src/pipeline/fix.ts', startLine: 901, endLine: 901, kind: 'caller' },
        ]),
        stderr: '',
        code: 0,
      },
    });

    const result = await queryCodeGraphContext('/work', 'Add queryCodeContext hybrid mode', { exec });
    expect(result.resolvedSymbols).toHaveLength(2);
    expect(result.resolvedSymbols.map((s) => s.symbol)).toContain('queryCodeContext');
    expect(result.resolvedSymbols.map((s) => s.symbol)).toContain('fix');
    expect(result.unresolvedQueries).toEqual([]);
  });

  it('tracks unresolved symbols (no definition AND no callers found)', async () => {
    const exec = makeExec({
      'codegraph find-symbol NeverDefined --json --cwd /work': {
        stdout: JSON.stringify([]),
        stderr: '',
        code: 0,
      },
    });
    const result = await queryCodeGraphContext('/work', 'investigate NeverDefined function', { exec });
    expect(result.resolvedSymbols).toEqual([]);
    expect(result.unresolvedQueries).toContain('NeverDefined');
  });

  it('degrades to empty result when codegraph is not on path (graceful)', async () => {
    const exec = makeExec({});
    const result = await queryCodeGraphContext('/work', 'lookup someFunc here', { exec });
    expect(result.resolvedSymbols).toEqual([]);
    // Symbols still extracted but all unresolved — caller (fix.ts) will fall back to pure-vector.
    expect(result.unresolvedQueries).toContain('someFunc');
  });

  it('deduplicates hits across definitions and callers by file:startLine', async () => {
    const exec = makeExec({
      'codegraph find-symbol fooBar --json --cwd /work': {
        stdout: JSON.stringify([{ symbol: 'fooBar', file: 'a.ts', startLine: 10, endLine: 20, kind: 'function' }]),
        stderr: '',
        code: 0,
      },
      'codegraph callers fooBar --json --cwd /work': {
        stdout: JSON.stringify([
          // Same file:startLine as above — should be deduped
          { symbol: 'fooBar', file: 'a.ts', startLine: 10, endLine: 20, kind: 'caller' },
          { symbol: 'fooBar', file: 'b.ts', startLine: 5, endLine: 8, kind: 'caller' },
        ]),
        stderr: '',
        code: 0,
      },
    });
    const result = await queryCodeGraphContext('/work', 'check fooBar behavior', { exec });
    expect(result.resolvedSymbols).toHaveLength(2);
    const keys = result.resolvedSymbols.map((s) => `${s.file}:${s.startLine}`);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('formatGraphContext', () => {
  it('renders a markdown section with file:line headers and kinds', () => {
    const hits: SymbolHit[] = [
      { symbol: 'queryCodeContext', file: 'src/services/vectordb.ts', startLine: 34, endLine: 70, kind: 'function' },
      { symbol: 'fix', file: 'src/pipeline/fix.ts', startLine: 901, endLine: 901, kind: 'caller' },
    ];
    const out = formatGraphContext(hits);
    expect(out).toContain('Graph');
    expect(out).toContain('queryCodeContext');
    expect(out).toContain('src/services/vectordb.ts');
    expect(out).toContain('L34');
    expect(out).toContain('function');
    expect(out).toContain('caller');
  });

  it('returns empty string when no hits', () => {
    expect(formatGraphContext([])).toBe('');
  });
});

describe('mergeGraphAndVectorContext', () => {
  it('returns graph context first, then vector context for unresolved-only symbols', () => {
    const graphResult = {
      resolvedSymbols: [
        {
          symbol: 'foo',
          file: 'src/foo.ts',
          startLine: 10,
          endLine: 20,
          kind: 'function' as const,
        } satisfies SymbolHit,
      ],
      unresolvedQueries: ['BarMissing'],
    };
    const vectorChunks: CodeChunk[] = [
      { file: 'src/bar.ts', content: 'BarMissing definition', score: 0.8, startLine: 1, endLine: 5 },
    ];

    const merged = mergeGraphAndVectorContext(graphResult, vectorChunks);
    expect(merged).toContain('Graph');
    expect(merged).toContain('foo');
    expect(merged).toContain('BarMissing definition');
    // Graph section must precede vector section
    const graphIdx = merged.indexOf('Graph');
    const vectorIdx = merged.indexOf('BarMissing definition');
    expect(graphIdx).toBeGreaterThanOrEqual(0);
    expect(vectorIdx).toBeGreaterThan(graphIdx);
  });

  it('dedupes vector chunks that overlap a resolved graph hit (file:startLine match)', () => {
    const graphResult = {
      resolvedSymbols: [
        {
          symbol: 'foo',
          file: 'src/foo.ts',
          startLine: 10,
          endLine: 20,
          kind: 'function' as const,
        } satisfies SymbolHit,
      ],
      unresolvedQueries: [],
    };
    const vectorChunks: CodeChunk[] = [
      // This chunk overlaps the graph hit (same file, startLine inside [10,20])
      { file: 'src/foo.ts', content: 'redundant chunk text', score: 0.9, startLine: 12, endLine: 18 },
      // This one is independent — should pass through
      { file: 'src/baz.ts', content: 'unique chunk', score: 0.7, startLine: 1, endLine: 5 },
    ];

    const merged = mergeGraphAndVectorContext(graphResult, vectorChunks);
    expect(merged).not.toContain('redundant chunk text');
    expect(merged).toContain('unique chunk');
  });

  it('degrades to pure vector context when graph has no resolved symbols', () => {
    const graphResult = { resolvedSymbols: [], unresolvedQueries: ['Missing'] };
    const vectorChunks: CodeChunk[] = [
      { file: 'src/a.ts', content: 'fallback chunk', score: 0.5, startLine: 1, endLine: 5 },
    ];

    const merged = mergeGraphAndVectorContext(graphResult, vectorChunks);
    expect(merged).not.toContain('## Graph');
    expect(merged).toContain('fallback chunk');
  });

  it('returns empty string when both graph and vector are empty', () => {
    expect(mergeGraphAndVectorContext({ resolvedSymbols: [], unresolvedQueries: [] }, [])).toBe('');
  });

  it('dedupes vector chunks against themselves by file:startLine-endLine', () => {
    const graphResult = { resolvedSymbols: [], unresolvedQueries: [] };
    const vectorChunks: CodeChunk[] = [
      { file: 'src/a.ts', content: 'first', score: 0.9, startLine: 1, endLine: 10 },
      { file: 'src/a.ts', content: 'duplicate by key', score: 0.5, startLine: 1, endLine: 10 },
    ];
    const merged = mergeGraphAndVectorContext(graphResult, vectorChunks);
    expect(merged).toContain('first');
    expect(merged).not.toContain('duplicate by key');
  });
});

// --- Regression-surface context (#276) ---

describe('review wave — regression-surface injection', () => {
  const regressionSurfaceContext =
    '## Regression Surface (affected dependents)\n\n' +
    'Symbols and files that depend on the changes below.\n\n' +
    '### `src/auth.ts`\n' +
    'Changed symbols: `verifyToken`\n\n' +
    '- `loginHandler` in `src/routes/login.ts` calls `verifyToken`';

  it('includes regressionSurfaceContext in review wave when provided', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { regressionSurfaceContext });

    expect(ctx).toContain('Regression Surface');
    expect(ctx).toContain('verifyToken');
    expect(ctx).toContain('loginHandler');
    expect(ctx).toContain('src/routes/login.ts');
  });

  it('omits regression-surface section when regressionSurfaceContext is undefined', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, {});

    expect(ctx).not.toContain('Regression Surface');
  });

  it('omits regression-surface section when regressionSurfaceContext is empty string', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { regressionSurfaceContext: '' });

    expect(ctx).not.toContain('Regression Surface');
  });

  it('does NOT inject regression-surface into non-review waves', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
    };
    const specCtx = buildWaveContext('spec', makeIssue(), handoffs, { regressionSurfaceContext });
    const implCtx = buildWaveContext('impl', makeIssue(), handoffs, { regressionSurfaceContext });
    const qualityCtx = buildWaveContext('quality', makeIssue(), handoffs, { regressionSurfaceContext });

    expect(specCtx).not.toContain('Regression Surface');
    expect(implCtx).not.toContain('Regression Surface');
    expect(qualityCtx).not.toContain('Regression Surface');
  });

  it('renders quality gates BEFORE the regression-surface section', () => {
    const handoffs: Partial<Record<string, WaveResult>> = {
      spec: makeWaveResult('spec', specArtifact),
      quality: makeWaveResult('quality', qualityArtifact),
    };
    const ctx = buildWaveContext('review', makeIssue(), handoffs, { regressionSurfaceContext });

    const qualityIdx = ctx.indexOf('Quality Gates');
    const surfaceIdx = ctx.indexOf('Regression Surface');

    expect(qualityIdx).toBeGreaterThanOrEqual(0);
    expect(surfaceIdx).toBeGreaterThanOrEqual(0);
    expect(qualityIdx).toBeLessThan(surfaceIdx);
  });
});
