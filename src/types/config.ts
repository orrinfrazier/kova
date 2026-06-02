import { z } from 'zod';

export const ModelTierSchema = z.enum(['small', 'medium', 'large']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/**
 * Per-run pipeline mode (issue #282).
 *
 *  - `simple`: minimal pipeline for trivial changes; same model tiers as the
 *    configured defaults, but `/fix` (the orchestrator) collapses agent spawning
 *    to inline execution upstream. Wire-level behavior here is identity.
 *  - `standard`: opt-back-up; uses the configured per-wave tiers exactly as
 *    specified in repos.yaml. The default when no mode is selected.
 *  - `economy`: routes test/impl/quality to the `small` tier without editing
 *    repos.yaml. Spec/assess/review stay on their configured tiers — per
 *    CLAUDE.md's phase-level model policy, reasoning waves never economize.
 *  - `explore`: routes test/impl to `large` and increases the per-piece impl
 *    retry budget so the review wave has more candidates to choose from.
 *    Tracked as phase-1 implementation; full parallel-impl + review-as-judge
 *    is a follow-up.
 */
export const PipelineModeSchema = z.enum(['simple', 'standard', 'economy', 'explore']);
export type PipelineMode = z.infer<typeof PipelineModeSchema>;

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

/** A single-model wave config: tier, override object, or bare model string.
 *  Mirrors the original pre-pool wave model shape; kept as a named export so the pool
 *  members can be typed without re-encoding the union inline. */
export const WaveSingleModelConfigSchema = z.union([ModelTierSchema, WaveModelOverrideSchema, z.string()]);
export type WaveSingleModelConfig = z.infer<typeof WaveSingleModelConfigSchema>;

/** Consensus pool: 2-5 wave model configs + an optional adjudicator (defaults to `large`).
 *  When a wave is assigned a pool, the wave runner is expected to fan out to every
 *  pool member in parallel and route the results through the adjudicator. See
 *  `resolveConsensusPool` / `isConsensusPool` in src/ai/models.ts for resolution. */
export const WaveConsensusConfigSchema = z.object({
  pool: z.array(WaveSingleModelConfigSchema).min(2).max(5),
  adjudicator: WaveSingleModelConfigSchema.default('large'),
});
export type WaveConsensusConfig = z.infer<typeof WaveConsensusConfigSchema>;

/** A wave's model config: either a single model (tier/override/string) or a consensus pool.
 *  Pool variant is listed first so the union tries the object-with-`pool` shape before
 *  the bare override object. */
export const WaveModelConfigSchema = z.union([
  WaveConsensusConfigSchema,
  ModelTierSchema,
  WaveModelOverrideSchema,
  z.string(),
]);
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

/**
 * Playbooks config (#299) — synthesize reusable Markdown procedures from
 * repeated successful episodes. Default off; triggers synthesis only when at
 * least `min_episodes` form a coherent cluster (shared labels + language +
 * file overlap). The `endpoint` is the REST sink used by both
 * `queryPlaybook` (POST with a query, returns one matching playbook) and
 * `recordPlaybook` (PUT: persists a synthesised PlaybookRecord). Synthesis
 * failures are logged and swallowed — they never block a fix.
 */
export const PlaybooksConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().optional(),
    min_episodes: z.number().int().positive().default(3),
  })
  .refine((cfg) => !cfg.enabled || cfg.endpoint != null, {
    message: 'endpoint is required when playbooks is enabled',
    path: ['endpoint'],
  });

export type PlaybooksConfig = z.infer<typeof PlaybooksConfigSchema>;

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

/**
 * A/B test selection policy. Drives adaptive variant selection in
 * `selectVariants`. Optional — when omitted, selection uses the built-in
 * defaults (DEFAULT_EPSILON, no force-random).
 *
 * - `epsilon`: exploration probability, clamped to [0, 1]. When at least one
 *   sufficient variant exists for a wave, selection exploits the best one
 *   with probability `1 - epsilon` and explores uniformly otherwise.
 * - `force_random`: opt back into pure uniform-random selection regardless
 *   of history (use as a `--explore` / debugging escape hatch).
 */
export const ABTestPolicySchema = z.object({
  epsilon: z.number().min(0).max(1).optional(),
  force_random: z.boolean().optional(),
});
export type ABTestPolicyConfig = z.infer<typeof ABTestPolicySchema>;

/** Wave names valid in the `skills.enabled_waves` list (issue #298).
 *  Includes 'ship' for loss-less user intent — at runtime the ship wave does
 *  not spawn an AI agent, so listing it has no effect, but the schema accepts
 *  it rather than surprising the user with a validation error. */
export const SkillWaveNameSchema = z.enum([
  'assess',
  'spec',
  'test',
  'impl',
  'quality',
  'review',
  'brainstorm',
  'ship',
]);
export type SkillWaveName = z.infer<typeof SkillWaveNameSchema>;

/** Skills block (issue #298).
 *  Controls which directories kova scans for SKILL.md skills and which waves
 *  receive the formatted skill list in their system prompt. Defaults mirror
 *  the issue's "default ~/.claude/skills + per-repo .kova/skills" guidance
 *  and enable the reasoning + impl/quality waves. */
export const SkillsConfigSchema = z.object({
  /** Directories to scan for SKILL.md skills. Order matters — first dir wins
   *  on name collisions. Supports `~` (expanded to $HOME) and relative paths
   *  (resolved against the repo root). Empty array → no skills loaded. */
  dirs: z.array(z.string().min(1)).default(['~/.claude/skills', '.kova/skills']),
  /** Waves whose system prompt receives the skills block. The `test` wave is
   *  excluded by default — TDD red phase is mechanical and benefits little
   *  from skill discovery. Users can opt the test wave in explicitly. */
  enabled_waves: z.array(SkillWaveNameSchema).default(['assess', 'spec', 'impl', 'quality', 'review', 'brainstorm']),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/**
 * Eval-harness config (issue #278). When `context_arm` is set, every fix run
 * in this repo is tagged as part of that arm of the retrieval-quality eval and
 * the tag is persisted into `history.jsonl` so `kova eval context` can compute
 * the on-vs-off delta.
 */
export const EvalConfigSchema = z.object({
  /** Which arm of the retrieval-quality eval this repo is running. */
  context_arm: z.enum(['on', 'off']).optional(),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export const RepoConfigSchema = z.object({
  path: z.string(),
  prompts_dir: z.string().optional(),
  ab_test: ABTestConfigSchema.optional(),
  ab_test_policy: ABTestPolicySchema.optional(),
  eval: EvalConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  vectordb: VectorDBConfigSchema.optional(),
  episodes: EpisodicMemoryConfigSchema.optional(),
  playbooks: PlaybooksConfigSchema.optional(),
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
      /**
       * Issue #288 — `gh issue list --limit`. Decoupled from
       * `max_issues_per_run` (the processing cap) so the loop can fetch a
       * wider window, record every fetched issue in the coverage ledger,
       * and report "N not attempted" rather than silently dropping them.
       * Defaults to undefined → DEFAULT_FETCH_LIMIT (50) in github.ts.
       */
      gh_fetch_limit: z.number().int().positive().optional(),
      budget_usd: z.number().optional(),
      wave_cost_cap_usd: z.number().optional(),
      focus: z.array(z.string()).optional(),
      ci_merge: z.enum(['require', 'warn']).default('require'),
      review_merge: z.enum(['require', 'warn']).default('require'),
      concurrency: z.number().int().positive().default(1),
      // Per-wave wall-clock timeout overrides (seconds, positive integers).
      // Issue #244 — large workspaces with local models need 30+ min for T/I.
      // Defaults live in DEFAULT_WAVE_TIMEOUTS (src/ai/wave-executor.ts).
      wave_timeout: z
        .object({
          assess: z.number().int().positive().optional(),
          spec: z.number().int().positive().optional(),
          test: z.number().int().positive().optional(),
          impl: z.number().int().positive().optional(),
          quality: z.number().int().positive().optional(),
          review: z.number().int().positive().optional(),
          brainstorm: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .default(() => ({
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
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
      // fallback model for local-only setups:
      //  - string  → use as the fallback model name (e.g. "claude-sonnet-4-6")
      //  - false   → disable API fallback entirely (pure local mode, issue #242)
      //  - "none"  → string sentinel, normalized to false during parsing
      //  - omitted → preserve historical default (API tier fallback for local models)
      fallback: z
        .union([z.literal(false), z.string()])
        .transform((v) => (v === 'none' ? (false as const) : v))
        .optional(),
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
  /**
   * Milestone title the issue is assigned to, or `null` when unset.
   * `undefined` is reserved for "field not requested" (legacy code paths) — production
   * fetchers always populate `string | null` so consumers can distinguish "no milestone"
   * from "milestone not loaded".
   */
  milestone?: string | null;
  /**
   * ISO 8601 timestamp when the issue was opened.
   * `undefined` is reserved for legacy/test code paths — production fetchers
   * (`fetchIssues` / `fetchIssue`) always populate it so the freshness factor
   * in `scoreIssue` can compute staleness (issue #286).
   */
  createdAt?: string;
  /**
   * ISO 8601 timestamp of the last activity on the issue (edit, comment, label
   * change). Used by `scoreIssue` to award `freshness_bonus` when an issue has
   * gone ≥30 days without activity (issue #286). Same `undefined`-is-legacy
   * convention as `createdAt`.
   */
  updatedAt?: string;
}

export type WaveName = 'assess' | 'spec' | 'test' | 'impl' | 'quality' | 'review' | 'ship' | 'brainstorm';

/**
 * Per-wave structured-output extraction telemetry (issue #247).
 *
 * Mirrors `StructuredOutputMetricsSchema` in `types/handoffs.ts`. Duplicated
 * here as a plain interface to keep `config.ts` zod-free (it's imported by
 * places that don't want the zod runtime cost).
 */
export type ParseMethod =
  | 'json-tag'
  | 'json-tag-repaired'
  | 'markdown-fence'
  | 'markdown-fence-repaired'
  | 'direct-parse'
  | 'direct-parse-repaired';

export interface StructuredOutputMetrics {
  parse_method?: ParseMethod | null | undefined;
  attempts: number;
  success: boolean;
  repair_attempts: number;
  zod_validation_failed?: boolean | undefined;
}

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
  /**
   * Per-wave structured-output telemetry (issue #247). Populated when the
   * wave was invoked with an `outputFormat`; omitted otherwise.
   */
  structured_output_metrics?: StructuredOutputMetrics | undefined;
  /**
   * Per-wave tool-call counts (issue #278). Populated by `spawnWaveAgent`.
   * Aggregated across waves into the run-level `toolCallCounts` field in
   * `history.jsonl` so the retrieval-quality eval harness can compute the
   * context-on vs context-off delta.
   */
  toolCallCounts?: { total: number; reads: number; byTool: Record<string, number> } | undefined;
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

/**
 * Pipeline scope, persisted on `FixState` by the orchestrator after the
 * scope-detection probe (issue #283). The orchestrator gates each wave on
 * `pipelineScope` so test-only / refactor / review-only issues don't waste
 * waves on irrelevant phases.
 *
 * Mirrored as a string-union here to keep `config.ts` free of cross-module
 * value imports; the canonical type + value exports live in
 * `services/pipeline-scope.ts` and are re-exported from `types/index.ts`.
 */
export type PipelineScope = 'FULL' | 'TEST_ONLY' | 'IMPL_ONLY' | 'REFACTOR' | 'REVIEW_ONLY';

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
  diagnosis?: 'SPEC_WRONG' | 'APPROACH_WRONG' | 'MISSING_CONTEXT' | 'STUCK' | undefined;
  thrashingSignal?: 'SAME_FILES' | 'DIFFERENT_FILES' | 'NORMAL' | 'INSUFFICIENT_DATA' | undefined;
  retryAttempts?: number | undefined;
  mergeDependencies?: number[] | undefined;
  /**
   * Pipeline scope detected at startup (issue #283). Drives which waves the
   * orchestrator runs. Persisted across checkpoint resumes so a paused
   * REVIEW_ONLY fix doesn't suddenly run assess/spec on resume.
   */
  pipelineScope?: PipelineScope | undefined;
  /** Human-readable reason for the chosen `pipelineScope` (for logs + audit). */
  pipelineScopeReason?: string | undefined;
}
