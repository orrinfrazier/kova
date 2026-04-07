import { describe, expect, it } from 'vitest';
import { BrainstormIssueSchema, BrainstormResultSchema } from './waves.js';

describe('BrainstormIssueSchema', () => {
  it('validates a well-formed brainstorm issue', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Add rate limiting to API',
      body: 'The API has no rate limiting, exposing it to abuse.',
      labels: ['security', 'enhancement'],
      priority: 'high',
      category: 'security',
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = BrainstormIssueSchema.safeParse({
      body: 'Some body',
      labels: [],
      priority: 'medium',
      category: 'bug',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'super-high',
      category: 'bug',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid category', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'low',
      category: 'unknown-category',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional dependencies array', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'enhancement',
      confidence: 0.8,
      dependencies: ['Other issue title'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toEqual(['Other issue title']);
    }
  });

  it('requires confidence field as number between 0 and 1', () => {
    const valid = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
      confidence: 0.85,
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.confidence).toBe(0.85);
    }
  });

  it('rejects confidence below 0', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence above 1', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects issue missing confidence field', () => {
    const result = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
    });
    expect(result.success).toBe(false);
  });

  it('accepts confidence at boundary values 0 and 1', () => {
    const zero = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
      confidence: 0,
    });
    expect(zero.success).toBe(true);

    const one = BrainstormIssueSchema.safeParse({
      title: 'Test',
      body: 'Body',
      labels: [],
      priority: 'medium',
      category: 'bug',
      confidence: 1,
    });
    expect(one.success).toBe(true);
  });
});

describe('BrainstormResultSchema', () => {
  it('validates a complete brainstorm result', () => {
    const result = BrainstormResultSchema.safeParse({
      issues: [
        {
          title: 'Fix auth bug',
          body: 'Authentication fails on expired tokens.',
          labels: ['bug'],
          priority: 'high',
          category: 'bug',
          confidence: 0.8,
        },
      ],
      summary: 'Found 1 issue',
    });
    expect(result.success).toBe(true);
  });

  it('validates empty issues array', () => {
    const result = BrainstormResultSchema.safeParse({
      issues: [],
      summary: 'No issues found',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing summary', () => {
    const result = BrainstormResultSchema.safeParse({
      issues: [],
    });
    expect(result.success).toBe(false);
  });
});
