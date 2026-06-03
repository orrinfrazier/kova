// Test helpers for context-provider smoke tests (issue #431).
//
// All providers consume a `ContextProviderInput`. These helpers build the
// minimum-viable inputs needed for negative-path tests (provider disabled in
// config → resolves to undefined) without dragging in real services.

import type { AssessResult, Issue, RepoConfig } from '../../types/index.js';
import type { ContextProviderInput } from './types.js';

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Body for tests.',
    state: 'OPEN',
    author: 'tester',
    labels: [],
    url: 'https://github.com/owner/repo/issues/1',
    ...overrides,
  } as Issue;
}

export function makeConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  // RepoConfigSchema gives sensible defaults; we cast since the smoke tests
  // only consult the `*.enabled` gates and skip the actual zod parse.
  return {
    path: '/tmp/repo',
    isolation: 'worktree',
    ...overrides,
  } as RepoConfig;
}

export function makeCtx(overrides: Partial<ContextProviderInput> = {}): ContextProviderInput {
  return {
    issue: makeIssue(),
    config: makeConfig(),
    ownerRepo: 'owner/repo',
    repoName: 'owner/repo',
    repoPath: '/tmp/repo',
    workDir: '/tmp/wt',
    language: 'typescript',
    assessResult: undefined,
    logger: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

export function makeAssessResult(files: string[] = []): AssessResult {
  return {
    grade: 'A',
    risk: 'low',
    surface_area: {
      files,
      modules_affected: [],
      estimated_lines: 0,
    },
    reasoning: 'test',
    should_proceed: true,
  } as AssessResult;
}
