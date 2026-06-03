// Tests for ReviewFeedbackStore — sqlite-vec-backed record + query.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewFeedbackRecord } from '../../types/memory.js';
import { ReviewFeedbackStore } from './review-feedback-store.js';

function makeRecord(overrides: Partial<ReviewFeedbackRecord> = {}): ReviewFeedbackRecord {
  return {
    repo: 'org/repo',
    pr_number: 1,
    feedback_type: 'logic_error',
    comment_text: 'this branch is incorrect',
    file_path: 'src/foo.ts',
    author: 'reviewer',
    ...overrides,
  };
}

describe('ReviewFeedbackStore', () => {
  let tmp: string;
  let store: ReviewFeedbackStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-review-feedback-store-'));
    store = new ReviewFeedbackStore(join(tmp, 'review-feedback-vec.db'));
  });

  afterEach(() => {
    store.close();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('records and queries feedback', () => {
    store.recordFeedback([
      makeRecord({ pr_number: 10, comment_text: 'database connection leak' }),
      makeRecord({ pr_number: 11, comment_text: 'react hook dependency missing' }),
    ]);

    const results = store.queryFeedback('database connection', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.comment_text).toMatch(/database/i);
  });

  it('returns empty array on empty store', () => {
    expect(store.queryFeedback('anything', 5)).toEqual([]);
  });

  it('returns empty array on empty query', () => {
    store.recordFeedback([makeRecord()]);
    expect(store.queryFeedback('', 5)).toEqual([]);
  });

  it('filters by repo when given', () => {
    store.recordFeedback([
      makeRecord({ repo: 'org/a', pr_number: 1, comment_text: 'shared concern' }),
      makeRecord({ repo: 'org/b', pr_number: 2, comment_text: 'shared concern' }),
    ]);

    const aOnly = store.queryFeedback('shared concern', 5, 'org/a');
    expect(aOnly.length).toBe(1);
    expect(aOnly[0]?.pr_number).toBe(1);
  });

  it('honors top_k', () => {
    for (let i = 1; i <= 5; i++) {
      store.recordFeedback([makeRecord({ pr_number: i, comment_text: `concern ${i}` })]);
    }
    const results = store.queryFeedback('concern', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('queryFeedback after close returns []', () => {
    store.recordFeedback([makeRecord()]);
    store.close();
    expect(store.queryFeedback('anything', 5)).toEqual([]);
  });

  it('preserves feedback_type and file_path on roundtrip', () => {
    store.recordFeedback([
      makeRecord({
        pr_number: 1,
        feedback_type: 'security_concern',
        file_path: 'src/auth.ts',
        comment_text: 'sql injection vector',
      }),
    ]);

    const results = store.queryFeedback('sql injection', 5);
    expect(results[0]?.feedback_type).toBe('security_concern');
    expect(results[0]?.file_path).toBe('src/auth.ts');
  });
});
