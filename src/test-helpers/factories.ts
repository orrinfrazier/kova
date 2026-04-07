/**
 * Factory functions for test data — Issues, RepoConfig, FixState.
 *
 * Usage:
 *   import { makeIssue, makeConfig } from '../test-helpers/factories.js';
 *   const issue = makeIssue(42);
 *   const config = makeConfig({ isolation: 'none' });
 */

import type { FixState, Issue, RepoConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Issue factory
// ---------------------------------------------------------------------------

export function makeIssue(n: number, overrides?: Partial<Issue>): Issue {
  return {
    number: n,
    title: `Test issue ${n}`,
    body: 'Fix the broken handler',
    labels: ['bug'],
    url: `https://github.com/test/repo/issues/${n}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RepoConfig factory
// ---------------------------------------------------------------------------

export function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: '/tmp/test-repo',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
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
    isolation: 'none',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FixState factory
// ---------------------------------------------------------------------------

export function makeFixState(issueNumber: number, overrides?: Partial<FixState>): FixState {
  return {
    issue: makeIssue(issueNumber),
    repo: 'test-repo',
    repoPath: '/tmp/test-repo',
    startedAt: new Date().toISOString(),
    completedWaves: [],
    waveResults: {},
    status: 'running',
    ...overrides,
  };
}
