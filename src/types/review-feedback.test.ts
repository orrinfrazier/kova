import { describe, expect, it } from 'vitest';
import type { FeedbackType, ReviewFeedbackInsert } from './index.js';
import {
  FeedbackTypeSchema as ReExportedFeedbackTypeSchema,
  ReviewFeedbackInsertSchema as ReExportedReviewFeedbackInsertSchema,
} from './index.js';
import { FeedbackTypeSchema, ReviewFeedbackInsertSchema } from './vectordb.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeValidFeedback(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    repo: 'my-org/my-repo',
    pr_number: 42,
    feedback_type: 'logic_error',
    comment_text: 'This condition is always true due to short-circuit evaluation.',
    author: 'reviewer-bot',
    file_path: 'src/auth.ts',
    line: 55,
    embedding: Array.from({ length: 1536 }, () => 0.1),
    ...overrides,
  };
}

/**
 * Helper to ensure a schema is actually defined (not undefined from a missing export).
 * This prevents false positives in rejection tests where undefined.parse() throws TypeError.
 */
function assertSchemaDefined(schema: unknown, name: string): asserts schema is { parse: (...args: never) => unknown } {
  expect(schema, `${name} should be exported and defined`).toBeDefined();
  expect(schema, `${name} should be an object with a parse method`).toHaveProperty('parse');
}

/* ------------------------------------------------------------------ */
/*  FeedbackTypeSchema                                                 */
/* ------------------------------------------------------------------ */

describe('FeedbackTypeSchema', () => {
  const VALID_TYPES = [
    'style_issue',
    'logic_error',
    'missing_test',
    'security_concern',
    'performance',
    'naming',
    'architecture',
    'documentation',
  ] as const;

  it('is exported and defined', () => {
    assertSchemaDefined(FeedbackTypeSchema, 'FeedbackTypeSchema');
  });

  for (const t of VALID_TYPES) {
    it(`accepts valid type: ${t}`, () => {
      assertSchemaDefined(FeedbackTypeSchema, 'FeedbackTypeSchema');
      expect(FeedbackTypeSchema.parse(t)).toBe(t);
    });
  }

  it('rejects invalid feedback type', () => {
    assertSchemaDefined(FeedbackTypeSchema, 'FeedbackTypeSchema');
    expect(() => FeedbackTypeSchema.parse('invalid_type')).toThrow();
  });

  it('rejects empty string', () => {
    assertSchemaDefined(FeedbackTypeSchema, 'FeedbackTypeSchema');
    expect(() => FeedbackTypeSchema.parse('')).toThrow();
  });

  it('rejects number', () => {
    assertSchemaDefined(FeedbackTypeSchema, 'FeedbackTypeSchema');
    expect(() => FeedbackTypeSchema.parse(42)).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  ReviewFeedbackInsertSchema — valid inputs                          */
/* ------------------------------------------------------------------ */

describe('ReviewFeedbackInsertSchema', () => {
  it('is exported and defined', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
  });

  it('accepts a valid complete feedback record', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    const result = ReviewFeedbackInsertSchema.parse(input);
    expect(result.repo).toBe('my-org/my-repo');
    expect(result.pr_number).toBe(42);
    expect(result.feedback_type).toBe('logic_error');
    expect(result.comment_text).toBe('This condition is always true due to short-circuit evaluation.');
    expect(result.author).toBe('reviewer-bot');
    expect(result.file_path).toBe('src/auth.ts');
    expect(result.line).toBe(55);
    expect(result.embedding).toHaveLength(1536);
  });

  /* ---------------------------------------------------------------- */
  /*  Optional fields                                                  */
  /* ---------------------------------------------------------------- */

  it('accepts record without optional file_path', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.file_path;
    const result = ReviewFeedbackInsertSchema.parse(input);
    expect(result.file_path).toBeUndefined();
  });

  it('accepts record without optional line', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.line;
    const result = ReviewFeedbackInsertSchema.parse(input);
    expect(result.line).toBeUndefined();
  });

  it('accepts record with both optional fields omitted', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.file_path;
    delete input.line;
    const result = ReviewFeedbackInsertSchema.parse(input);
    expect(result.file_path).toBeUndefined();
    expect(result.line).toBeUndefined();
  });

  /* ---------------------------------------------------------------- */
  /*  Required field validation                                        */
  /* ---------------------------------------------------------------- */

  it('rejects missing repo', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.repo;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects missing pr_number', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.pr_number;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects missing feedback_type', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.feedback_type;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects missing comment_text', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.comment_text;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects missing author', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.author;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects missing embedding', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    delete input.embedding;
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  /* ---------------------------------------------------------------- */
  /*  Embedding dimension validation                                   */
  /* ---------------------------------------------------------------- */

  it('rejects embedding with fewer than 1536 elements', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ embedding: Array.from({ length: 100 }, () => 0.1) });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects embedding with more than 1536 elements', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ embedding: Array.from({ length: 2000 }, () => 0.1) });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects empty embedding array', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ embedding: [] });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  /* ---------------------------------------------------------------- */
  /*  Field type validation                                            */
  /* ---------------------------------------------------------------- */

  it('rejects non-integer pr_number', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ pr_number: 42.5 });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects invalid feedback_type value', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ feedback_type: 'nonexistent_category' });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  it('rejects non-string comment_text', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback({ comment_text: 123 });
    expect(() => ReviewFeedbackInsertSchema.parse(input)).toThrow();
  });

  /* ---------------------------------------------------------------- */
  /*  Type inference                                                   */
  /* ---------------------------------------------------------------- */

  it('inferred type matches ReviewFeedbackInsert', () => {
    assertSchemaDefined(ReviewFeedbackInsertSchema, 'ReviewFeedbackInsertSchema');
    const input = makeValidFeedback();
    const result = ReviewFeedbackInsertSchema.parse(input);
    // Type-level check: if this compiles, the types align
    const typed: ReviewFeedbackInsert = result;
    expect(typed.repo).toBe('my-org/my-repo');
  });
});

/* ------------------------------------------------------------------ */
/*  Re-exports from index.ts                                           */
/* ------------------------------------------------------------------ */

describe('re-exports from types/index.ts', () => {
  it('re-exports ReviewFeedbackInsertSchema as a defined Zod schema', () => {
    assertSchemaDefined(ReExportedReviewFeedbackInsertSchema, 'ReExportedReviewFeedbackInsertSchema');
    // Also verify it's the same reference as the direct import
    expect(ReExportedReviewFeedbackInsertSchema).toBe(ReviewFeedbackInsertSchema);
  });

  it('re-exports FeedbackTypeSchema as a defined Zod schema', () => {
    assertSchemaDefined(ReExportedFeedbackTypeSchema, 'ReExportedFeedbackTypeSchema');
    expect(ReExportedFeedbackTypeSchema).toBe(FeedbackTypeSchema);
  });

  it('ReviewFeedbackInsert type is usable from index', () => {
    assertSchemaDefined(ReExportedReviewFeedbackInsertSchema, 'ReExportedReviewFeedbackInsertSchema');
    const data = makeValidFeedback();
    const result: ReviewFeedbackInsert = ReExportedReviewFeedbackInsertSchema.parse(data);
    expect(result.feedback_type).toBe('logic_error');
  });

  it('FeedbackType type is usable from index', () => {
    assertSchemaDefined(ReExportedFeedbackTypeSchema, 'ReExportedFeedbackTypeSchema');
    const value: FeedbackType = ReExportedFeedbackTypeSchema.parse('style_issue');
    expect(value).toBe('style_issue');
  });
});
