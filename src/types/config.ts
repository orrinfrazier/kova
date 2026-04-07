import { z } from 'zod';

export const ModelTierSchema = z.enum(['small', 'medium', 'large']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const IsolationModeSchema = z.enum(['worktree', 'docker', 'none']);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

export const OllamaModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().default(128000),
  maxTokens: z.number().default(32000),
});

export type OllamaModel = z.infer<typeof OllamaModelSchema>;

export const OllamaProviderSchema = z.object({
  host: z.string().default('http://localhost:11434'),
  models: z.array(OllamaModelSchema).default([]),
});

export type OllamaProvider = z.infer<typeof OllamaProviderSchema>;

export const ProvidersSchema = z
  .object({
    ollama: OllamaProviderSchema.optional(),
  })
  .optional();

export type Providers = z.infer<typeof ProvidersSchema>;

export const RepoConfigSchema = z.object({
  path: z.string(),
  rules: z
    .object({
      coverage: z.number().default(80),
      auto_merge: z.boolean().default(false),
      max_issues_per_run: z.number().default(10),
      budget_usd: z.number().optional(),
      wave_cost_cap_usd: z.number().optional(),
      focus: z.array(z.string()).optional(),
    })
    .default(() => ({ coverage: 80, auto_merge: false, max_issues_per_run: 10 })),
  auto: z
    .object({
      source: z.enum(['open_issues', 'labeled']).default('open_issues'),
      filter: z.string().optional(),
      max_per_run: z.number().default(10),
      schedule: z.string().optional(),
    })
    .optional(),
  model: z
    .object({
      assess: ModelTierSchema.default('large'),
      spec: ModelTierSchema.default('large'),
      test: ModelTierSchema.default('medium'),
      impl: ModelTierSchema.default('medium'),
      quality: ModelTierSchema.default('small'),
      review: ModelTierSchema.default('large'),
      brainstorm: ModelTierSchema.default('large'),
      thinking: z
        .object({
          assess: ThinkingLevelSchema.optional(),
          spec: ThinkingLevelSchema.optional(),
          test: ThinkingLevelSchema.optional(),
          impl: ThinkingLevelSchema.optional(),
          quality: ThinkingLevelSchema.optional(),
          review: ThinkingLevelSchema.optional(),
          brainstorm: ThinkingLevelSchema.optional(),
        })
        .optional(),
    })
    .default(() => ({
      assess: 'large' as const,
      spec: 'large' as const,
      test: 'medium' as const,
      impl: 'medium' as const,
      quality: 'small' as const,
      review: 'large' as const,
      brainstorm: 'large' as const,
    })),
  isolation: IsolationModeSchema.default('worktree'),
  providers: ProvidersSchema,
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const KovaConfigSchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
});

export type KovaConfig = z.infer<typeof KovaConfigSchema>;

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export type WaveName = 'assess' | 'spec' | 'test' | 'impl' | 'quality' | 'review' | 'ship' | 'brainstorm';

export interface WaveResult {
  wave: WaveName;
  success: boolean;
  artifact: unknown;
  duration: number;
  cost: number;
  turns: number;
  model?: string | undefined;
}

export interface FailedPiece {
  pieceName: string;
  diagnosis: {
    category: string;
    theory: string;
    tests_still_failing: string[];
  };
}

export interface ReviewKnownIssue {
  category: string;
  file: string;
  description: string;
  severity: string;
}

export interface FixState {
  issue: Issue;
  repo: string;
  repoPath: string;
  worktree?: string | undefined;
  startedAt: string;
  completedWaves: WaveName[];
  waveResults: Partial<Record<WaveName, WaveResult>>;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  error?: string | undefined;
  failedPieces?: FailedPiece[] | undefined;
  reviewKnownIssues?: ReviewKnownIssue[] | undefined;
}
