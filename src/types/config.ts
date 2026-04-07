import { z } from 'zod';

export const ModelTierSchema = z.enum(['small', 'medium', 'large']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const IsolationModeSchema = z.enum(['worktree', 'docker', 'none']);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

export const SandboxConfigSchema = z.object({
  image: z.string().default('node:20-bookworm'),
  extra_packages: z.array(z.string()).default([]),
  restrict_network: z.boolean().default(false),
  cpus: z.number().positive().default(2),
  memory: z.string().default('4g'),
  timeout: z.string().default('30m'),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

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

export const MCPServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const MCPConfigSchema = z.object({
  servers: z.record(z.string(), MCPServerConfigSchema).default({}),
  waves: z
    .object({
      assess: z.array(z.string()).optional(),
      spec: z.array(z.string()).optional(),
      test: z.array(z.string()).optional(),
      impl: z.array(z.string()).optional(),
      quality: z.array(z.string()).optional(),
      review: z.array(z.string()).optional(),
      brainstorm: z.array(z.string()).optional(),
    })
    .optional(),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;

export const WaveModelOverrideSchema = z.object({
  provider: z.string(),
  model: z.string(),
});
export type WaveModelOverride = z.infer<typeof WaveModelOverrideSchema>;

export const WaveModelConfigSchema = z.union([ModelTierSchema, WaveModelOverrideSchema, z.string()]);
export type WaveModelConfig = z.infer<typeof WaveModelConfigSchema>;

export const VectorDBConfigSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().optional(),
    reindex_endpoint: z.string().optional(),
    top_k: z.number().default(10),
  })
  .refine((cfg) => !cfg.enabled || cfg.endpoint != null, {
    message: 'endpoint is required when vectordb is enabled',
    path: ['endpoint'],
  });

export type VectorDBConfig = z.infer<typeof VectorDBConfigSchema>;

export const EpisodicMemoryConfigSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().optional(),
    max_episodes: z.number().int().positive().default(3),
    cross_repo: z.boolean().default(true),
    same_repo_weight: z.number().default(1.5),
    language_filter: z.boolean().default(true),
  })
  .refine((cfg) => !cfg.enabled || cfg.endpoint != null, {
    message: 'endpoint is required when episodes is enabled',
    path: ['endpoint'],
  });

export type EpisodicMemoryConfig = z.infer<typeof EpisodicMemoryConfigSchema>;

export const CustomToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'Tool name must be lowercase alphanumeric with hyphens/underscores'),
  description: z.string().min(1),
  command: z.string().min(1),
});

export type CustomTool = z.infer<typeof CustomToolSchema>;

export const RepoIntelConfigSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().optional(),
    limit: z.number().int().positive().default(5),
  })
  .refine((cfg) => !cfg.enabled || cfg.endpoint != null, {
    message: 'endpoint is required when repo_intel is enabled',
    path: ['endpoint'],
  });

export type RepoIntelConfig = z.infer<typeof RepoIntelConfigSchema>;

export const MetricsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  prometheus: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
  otlp: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().optional(),
      interval_ms: z.number().default(15000),
    })
    .refine((cfg) => !cfg.enabled || cfg.endpoint != null, {
      message: 'endpoint is required when otlp is enabled',
      path: ['endpoint'],
    })
    .optional(),
});

export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

/** screenshots_dir is optional for construction; Zod applies the default during parsing via transform. */
export interface PlaywrightConfig {
  enabled: boolean;
  screenshots_dir?: string | undefined;
  baseline_dir?: string | undefined;
}

export const PlaywrightConfigSchema = z
  .object({
    enabled: z.boolean(),
    screenshots_dir: z.string().optional(),
    baseline_dir: z.string().optional(),
  })
  .transform(
    (val): PlaywrightConfig => ({
      enabled: val.enabled,
      screenshots_dir: val.screenshots_dir ?? '.kova/screenshots',
      baseline_dir: val.baseline_dir,
    }),
  );

export const GitHubConfigSchema = z
  .object({
    progress_comments: z.boolean().default(false),
  })
  .default(() => ({ progress_comments: false }));

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

export const CiMergePolicySchema = z.enum(['require', 'warn']);
export type CiMergePolicy = z.infer<typeof CiMergePolicySchema>;

export const ABTestWaveNames = ['assess', 'spec', 'test', 'impl', 'quality', 'review'] as const;

/** A/B test config: map wave names to arrays of variant names (at least 2 per wave). */
export const ABTestConfigSchema = z
  .object({
    assess: z.array(z.string().min(1)).min(2).optional(),
    spec: z.array(z.string().min(1)).min(2).optional(),
    test: z.array(z.string().min(1)).min(2).optional(),
    impl: z.array(z.string().min(1)).min(2).optional(),
    quality: z.array(z.string().min(1)).min(2).optional(),
    review: z.array(z.string().min(1)).min(2).optional(),
  })
  .refine((obj) => Object.values(obj).some((v) => v != null), {
    message: 'At least one wave must have A/B test variants configured',
  });
export type ABTestConfig = z.infer<typeof ABTestConfigSchema>;

export const RepoConfigSchema = z.object({
  path: z.string(),
  prompts_dir: z.string().optional(),
  ab_test: ABTestConfigSchema.optional(),
  vectordb: VectorDBConfigSchema.optional(),
  episodes: EpisodicMemoryConfigSchema.optional(),
  repo_intel: RepoIntelConfigSchema.optional(),
  metrics: MetricsConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  playwright: PlaywrightConfigSchema.optional(),
  tools: z.array(CustomToolSchema).optional(),
  github: GitHubConfigSchema.optional(),
  rules: z
    .object({
      coverage: z.number().default(80),
      auto_merge: z.boolean().default(false),
      max_issues_per_run: z.number().default(10),
      budget_usd: z.number().optional(),
      wave_cost_cap_usd: z.number().optional(),
      focus: z.array(z.string()).optional(),
      ci_merge: z.enum(['require', 'warn']).default('require'),
      concurrency: z.number().int().positive().default(1),
    })
    .default(() => ({
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      concurrency: 1,
    })),
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
      assess: WaveModelConfigSchema.default('large'),
      spec: WaveModelConfigSchema.default('large'),
      test: WaveModelConfigSchema.default('medium'),
      impl: WaveModelConfigSchema.default('medium'),
      quality: WaveModelConfigSchema.default('small'),
      review: WaveModelConfigSchema.default('large'),
      brainstorm: WaveModelConfigSchema.default('large'),
      fallback: z.string().optional(),
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
  mcp: MCPConfigSchema.optional(),
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
  provider?: string | undefined;
  fallback_used?: boolean | undefined;
  local_attempt_cost?: number | undefined;
  promptHash?: string | undefined;
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

export interface SandboxResourceUsage {
  peakMemoryMB: number;
  cpuSeconds: number;
  wallTimeMs: number;
  containerName: string;
  limitsApplied: { cpus: number; memory: string; timeout: string };
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
  sandboxResourceUsage?: SandboxResourceUsage | undefined;
}
