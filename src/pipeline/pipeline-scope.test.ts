import { describe, expect, it } from 'vitest';
import type { Issue } from '../types/index.js';
import { detectScope, isWaveSkippedByScope, type PipelineScope, WAVES_SKIPPED_BY_SCOPE } from './pipeline-scope.js';

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    number: 1,
    title: 'feat: add a thing',
    body: 'Add a thing.',
    labels: [],
    url: 'https://github.com/example/repo/issues/1',
    ...overrides,
  };
}

describe('PipelineScope constants', () => {
  it('lists waves dropped by each scope per issue spec', () => {
    expect(WAVES_SKIPPED_BY_SCOPE.FULL).toEqual([]);
    expect(WAVES_SKIPPED_BY_SCOPE.TEST_ONLY).toEqual(['impl', 'quality', 'review', 'ship']);
    expect(WAVES_SKIPPED_BY_SCOPE.IMPL_ONLY).toEqual(['test']);
    expect(WAVES_SKIPPED_BY_SCOPE.REFACTOR).toEqual(['test']);
    expect(WAVES_SKIPPED_BY_SCOPE.REVIEW_ONLY).toEqual(['assess', 'spec', 'test', 'impl', 'quality']);
  });
});

describe('isWaveSkippedByScope', () => {
  it('FULL skips no waves', () => {
    expect(isWaveSkippedByScope('FULL', 'assess')).toBe(false);
    expect(isWaveSkippedByScope('FULL', 'test')).toBe(false);
    expect(isWaveSkippedByScope('FULL', 'ship')).toBe(false);
  });

  it('TEST_ONLY skips impl/quality/review/ship but keeps assess/spec/test', () => {
    expect(isWaveSkippedByScope('TEST_ONLY', 'assess')).toBe(false);
    expect(isWaveSkippedByScope('TEST_ONLY', 'spec')).toBe(false);
    expect(isWaveSkippedByScope('TEST_ONLY', 'test')).toBe(false);
    expect(isWaveSkippedByScope('TEST_ONLY', 'impl')).toBe(true);
    expect(isWaveSkippedByScope('TEST_ONLY', 'quality')).toBe(true);
    expect(isWaveSkippedByScope('TEST_ONLY', 'review')).toBe(true);
    expect(isWaveSkippedByScope('TEST_ONLY', 'ship')).toBe(true);
  });

  it('IMPL_ONLY skips test wave only', () => {
    expect(isWaveSkippedByScope('IMPL_ONLY', 'test')).toBe(true);
    expect(isWaveSkippedByScope('IMPL_ONLY', 'impl')).toBe(false);
    expect(isWaveSkippedByScope('IMPL_ONLY', 'assess')).toBe(false);
  });

  it('REFACTOR skips test wave only', () => {
    expect(isWaveSkippedByScope('REFACTOR', 'test')).toBe(true);
    expect(isWaveSkippedByScope('REFACTOR', 'impl')).toBe(false);
  });

  it('REVIEW_ONLY skips all but review and ship', () => {
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'assess')).toBe(true);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'spec')).toBe(true);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'test')).toBe(true);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'impl')).toBe(true);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'quality')).toBe(true);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'review')).toBe(false);
    expect(isWaveSkippedByScope('REVIEW_ONLY', 'ship')).toBe(false);
  });
});

describe('detectScope', () => {
  it('returns FULL when no labels match and no test probe provided', async () => {
    const result = await detectScope({
      issue: makeIssue(),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe<PipelineScope>('FULL');
    expect(result.reason).toMatch(/no special signals/i);
  });

  it('returns TEST_ONLY when the issue has a test-only label', async () => {
    const result = await detectScope({
      issue: makeIssue({ labels: ['test-only'] }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('TEST_ONLY');
    expect(result.reason.toLowerCase()).toContain('test-only');
  });

  it('returns TEST_ONLY when the title says "write tests"', async () => {
    const result = await detectScope({
      issue: makeIssue({ title: 'test: write tests for billing flow' }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('TEST_ONLY');
  });

  it('returns TEST_ONLY when the body says "add tests"', async () => {
    const result = await detectScope({
      issue: makeIssue({ body: 'Please add tests for the new endpoint.' }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('TEST_ONLY');
  });

  it('returns REFACTOR when the issue has a refactor label', async () => {
    const result = await detectScope({
      issue: makeIssue({ labels: ['refactor'] }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('REFACTOR');
    expect(result.reason.toLowerCase()).toContain('refactor');
  });

  it('returns REFACTOR when the issue has a refactor-only label', async () => {
    const result = await detectScope({
      issue: makeIssue({ labels: ['refactor-only'] }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('REFACTOR');
  });

  it('returns REVIEW_ONLY when the issue has a review-only label', async () => {
    const result = await detectScope({
      issue: makeIssue({ labels: ['review-only'] }),
      workDir: '/tmp/example',
    });
    expect(result.scope).toBe('REVIEW_ONLY');
  });

  it('returns IMPL_ONLY when runTests probe reports existing red tests', async () => {
    const result = await detectScope({
      issue: makeIssue(),
      workDir: '/tmp/example',
      runTests: async () => ({ hasFailures: true }),
    });
    expect(result.scope).toBe('IMPL_ONLY');
    expect(result.reason.toLowerCase()).toContain('existing failing tests');
  });

  it('returns FULL when runTests probe reports no failures', async () => {
    const result = await detectScope({
      issue: makeIssue(),
      workDir: '/tmp/example',
      runTests: async () => ({ hasFailures: false }),
    });
    expect(result.scope).toBe('FULL');
  });

  it('label-driven scopes take precedence over the runTests probe', async () => {
    // review-only beats an "existing failures" probe
    const result = await detectScope({
      issue: makeIssue({ labels: ['review-only'] }),
      workDir: '/tmp/example',
      runTests: async () => ({ hasFailures: true }),
    });
    expect(result.scope).toBe('REVIEW_ONLY');
  });

  it('swallows runTests errors and falls through to FULL', async () => {
    const result = await detectScope({
      issue: makeIssue(),
      workDir: '/tmp/example',
      runTests: async () => {
        throw new Error('test runner not configured');
      },
    });
    expect(result.scope).toBe('FULL');
  });
});
