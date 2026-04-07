import { z } from 'zod';

const embedding1536 = z.array(z.number()).length(1536);

export const CodeEmbeddingInsertSchema = z.object({
  file_path: z.string(),
  chunk_text: z.string(),
  embedding: embedding1536,
  repo: z.string(),
  updated_at: z.string().optional(),
});

export type CodeEmbeddingInsert = z.infer<typeof CodeEmbeddingInsertSchema>;

export const EpisodeInsertSchema = z.object({
  issue_number: z.number().int(),
  approach: z.string(),
  outcome: z.enum(['success', 'fail']),
  files_changed: z.array(z.string()),
  embedding: embedding1536,
  repo: z.string(),
  language: z.string().optional(),
  created_at: z.string().optional(),
});

export type EpisodeInsert = z.infer<typeof EpisodeInsertSchema>;

export const PatternInsertSchema = z.object({
  pattern_description: z.string(),
  frequency: z.number().int(),
  success_rate: z.number(),
  embedding: embedding1536,
  repo: z.string(),
});

export type PatternInsert = z.infer<typeof PatternInsertSchema>;
