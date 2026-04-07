import { describe, expect, it } from 'vitest';
import { CodeEmbeddingInsertSchema, EpisodeInsertSchema, PatternInsertSchema } from '../types/vectordb.js';

/* ------------------------------------------------------------------ */
/*  CodeEmbeddingInsertSchema                                          */
/* ------------------------------------------------------------------ */

describe('CodeEmbeddingInsertSchema', () => {
  it('validates a valid code embedding insert', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/services/config.ts',
      chunk_text: 'export function loadConfig(path: string) {}',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
      updated_at: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing file_path', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      chunk_text: 'some code',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing chunk_text', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/index.ts',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing repo', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/index.ts',
      chunk_text: 'some code',
      embedding: new Array(1536).fill(0.1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing embedding', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/index.ts',
      chunk_text: 'some code',
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects embedding with wrong dimensions (not 1536)', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/index.ts',
      chunk_text: 'some code',
      embedding: new Array(512).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-array embedding', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 'src/index.ts',
      chunk_text: 'some code',
      embedding: 'not-an-array',
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects file_path as non-string', () => {
    const result = CodeEmbeddingInsertSchema.safeParse({
      file_path: 42,
      chunk_text: 'some code',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  EpisodeInsertSchema                                                */
/* ------------------------------------------------------------------ */

describe('EpisodeInsertSchema', () => {
  it('validates a valid episode insert with outcome success', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 42,
      approach: 'Refactor the service layer',
      outcome: 'success',
      files_changed: ['src/services/config.ts', 'src/types/index.ts'],
      embedding: new Array(1536).fill(0.2),
      repo: 'kova',
      created_at: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('validates a valid episode insert with outcome fail', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 7,
      approach: 'Tried to use pgvector',
      outcome: 'fail',
      files_changed: [],
      embedding: new Array(1536).fill(0.3),
      repo: 'kova',
    });
    expect(result.success).toBe(true);
  });

  it('rejects outcome value other than success or fail', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: 'partial',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects outcome value of true (wrong type)', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: true,
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing issue_number', () => {
    const result = EpisodeInsertSchema.safeParse({
      approach: 'some approach',
      outcome: 'success',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing approach', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      outcome: 'success',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing outcome', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing files_changed', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: 'success',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects files_changed as non-array', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: 'success',
      files_changed: 'not-an-array',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects issue_number as non-integer', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 'forty-two',
      approach: 'some approach',
      outcome: 'success',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing embedding', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: 'success',
      files_changed: [],
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing repo', () => {
    const result = EpisodeInsertSchema.safeParse({
      issue_number: 1,
      approach: 'some approach',
      outcome: 'success',
      files_changed: [],
      embedding: new Array(1536).fill(0.1),
    });
    expect(result.success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  PatternInsertSchema                                                */
/* ------------------------------------------------------------------ */

describe('PatternInsertSchema', () => {
  it('validates a valid pattern insert', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'Use Zod for schema validation at boundaries',
      frequency: 12,
      success_rate: 0.92,
      embedding: new Array(1536).fill(0.05),
      repo: 'kova',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing pattern_description', () => {
    const result = PatternInsertSchema.safeParse({
      frequency: 5,
      success_rate: 0.8,
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing frequency', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      success_rate: 0.8,
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing success_rate', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 3,
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing embedding', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 3,
      success_rate: 0.75,
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing repo', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 3,
      success_rate: 0.75,
      embedding: new Array(1536).fill(0.1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects frequency as non-integer', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 'five',
      success_rate: 0.75,
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects success_rate as non-number', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 5,
      success_rate: 'high',
      embedding: new Array(1536).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });

  it('rejects embedding with wrong dimensions', () => {
    const result = PatternInsertSchema.safeParse({
      pattern_description: 'some pattern',
      frequency: 5,
      success_rate: 0.9,
      embedding: new Array(128).fill(0.1),
      repo: 'kova',
    });
    expect(result.success).toBe(false);
  });
});
