// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship
// Uses spawnWaveAgent() for standalone waves, runTILoop() for test+impl,
// and runReviewLoop() for review. Handoffs persist after every wave.

import { join as joinPath } from 'node:path';
import { z } from 'zod';
import { $ } from 'zx';
import {
  buildWaveSessionId,
  type FixAIWaveName,
  getApiFallbackModelString,
  getMCPToolsForWave,
  getModelString,
  getWaveTools,
  isConsensusPool,
  isLocalModel,
  type MCPServerHandle,
  type OutputFormat,
  resolveMCPServers,
  resolveThinkingLevel,
  resolveWaveModel,
  startAllMCPServers,
  stopAllMCPServers,
} from '../ai/index.js';
import { getSandboxBackend, type SandboxBackend } from '../sandbox/backend.js';
import { dispatchSpawnWave, type SandboxContext } from '../sandbox/dispatch.js';
import { selectVariants, type VariantSelection } from '../services/ab-test.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '../services/checkpoint.js';
import { checkForConflicts } from '../services/conflict-check.js';
import { resolveConflicts } from '../services/conflict-resolver.js';
import { type EpisodeFTSRecord, EpisodeFTSStore } from '../services/episode-fts.js';
import { collectPRFeedback } from '../services/feedback-collector.js';
import { commentOnIssue, createPR, listOpenPRs } from '../services/github.js';
import { appendHistoryEntry, readHistory } from '../services/history.js';
import { validateIsolation } from '../services/isolation.js';
import { detectTooling } from '../services/language-detect.js';
import * as metrics from '../services/metrics.js';
import { formatPatterns, PatternStore, upsertPatternFromEpisode } from '../services/pattern-store.js';
import { applyScopeToState, detectScope, formatScopeLogLine } from '../services/pipeline-scope.js';
import { ensureScreenshotsDir, isPlaywrightEnabled, resolvePlaywrightEnv } from '../services/playwright.js';
import { formatPRContext, type OpenPR } from '../services/pr-context.js';
import { ProgressTracker } from '../services/progress.js';
import { loadProjectContext, type ProjectContext } from '../services/project-context.js';
import { type ABTestVariantStats, correlateByABTestVariant } from '../services/prompt-correlation.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../services/prompt-versions.js';
import {
  formatRepoContext,
  formatRepoSearch,
  formatRepoStandards,
  queryRepoContext,
  queryRepoSearch,
  queryRepoStandards,
} from '../services/repo-intel.js';
import {
  buildSandboxImage,
  DEFAULT_SANDBOX_LIMITS,
  getContainerStats,
  killContainer,
  parseTimeout,
  startSandboxContainer,
} from '../services/sandbox.js';
import { scanForSecrets } from '../services/secrets-scan.js';
import { shutdownRequested } from '../services/shutdown.js';
import type { EpisodeContext, EpisodeRecord } from '../services/vectordb.js';
import {
  buildEpisodeRecord,
  formatCodeChunks,
  formatEpisodes,
  formatFailedEpisodes,
  formatPlaybook,
  formatReviewFeedback,
  queryCodeContext,
  queryEpisodeContext,
  queryPlaybook,
  queryReviewFeedbackContext,
  recordEpisode,
} from '../services/vectordb.js';
import {
  commitAndPush,
  createWorktree,
  detectDefaultBranch,
  getChangedFiles,
  worktreePath as getWorktreePath,
  rebaseOnDefault,
  removeWorktree,
  worktreeExists,
} from '../services/worktree.js';
import type { EpisodicMemoryConfig } from '../types/config.js';
import type {
  FailedPiece,
  FixState,
  Issue,
  PipelineMode,
  RepoConfig,
  SpecResult,
  WaveHandoff,
  WaveModelConfig,
  WaveName,
  WaveResult,
} from '../types/index.js';
import {
  type AssessResult,
  AssessResultSchema,
  loadAllHandoffs,
  loadHandoff,
  QualityRemediationSchema,
  SpecResultSchema,
  saveHandoff,
} from '../types/index.js';
import { closeFileLogger, initFileLogger, type Logger, log } from '../utils/logger.js';
import { buildWaveContext } from './context.js';
import { buildCostReport, printRunSummary, writeCostReport } from './cost-report.js';
import {
  detectThrashing,
  runParallelPieceTILoop,
  runQualityRetryLoop,
  runReviewLoop,
  type TestRunner,
} from './loops.js';
import { applyPipelineMode, autoSelectMode, describeAutoSelection, MODE_EXTRA_IMPL_ATTEMPTS } from './mode.js';
import { loadPrompt, resolvePromptsDir } from './prompts.js';
import { loadWaveSkills } from './skills-loader.js';
import {
  formatOverlapFeedback,
  formatPendingPRConflictFeedback,
  validatePieceFileOwnership,
} from './spec-validator.js';

function toOutputFormat(schema: z.ZodType): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: schema,
  };
}

export interface FixOptions {
  issue: Issue;
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  fresh?: boolean | undefined;
  noComment?: boolean | undefined;
  pendingPRs?: OpenPR[] | undefined;
  testRunner?: TestRunner | undefined;
  /**
   * Per-run pipeline mode (issue #282). When `undefined`, fix() auto-selects
   * after WAVE A from the feasibility grade + surface-area file count and
   * logs the decision. Explicit values override auto-selection — the only
   * mode never auto-selected is `explore`, which is opt-in only.
   */
  mode?: PipelineMode | undefined;
}

export interface FixResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  state: FixState;
}

// --- Helpers ---

/** Extract provider name from a wave's model config.
 *  For consensus pools the "provider" concept doesn't fit (multi-provider by design);
 *  we return the first pool member's provider for telemetry-tagging purposes only. */
function waveProvider(config: RepoConfig, wave: FixAIWaveName): string {
  const waveModel = config.model[wave];
  if (isConsensusPool(waveModel)) {
    const first = waveModel.pool[0];
    // `first` is guaranteed defined: pool min length is 2 via WaveConsensusConfigSchema.
    if (first === undefined) throw new Error(`Empty consensus pool for wave ${wave}`);
    if (typeof first === 'string') return resolveWaveModel(first).provider;
    return first.provider;
  }
  if (typeof waveModel !== 'string') return waveModel.provider;
  return resolveWaveModel(waveModel).provider;
}

/** Determine the fallback model string for a wave config, if applicable.
 *  Uses the configured fallback model when set, otherwise falls back to
 *  the tier-default API model for local-only models.
 *
 *  `configFallback === false` (issue #242) disables API fallback entirely —
 *  intended for pure-local setups with no API key. In that mode we skip both
 *  the configured-fallback path and the local-tier default.
 *
 *  Consensus pools are not supported by this single-model fallback path —
 *  pool wave runners handle their own per-member fallback.
 *
 *  Exported for unit testing — callers in this module use it directly. */
export function waveFallbackModel(
  waveConfig: WaveModelConfig,
  modelString: string,
  configFallback?: string | false,
): string | undefined {
  // Explicit opt-out: `false` disables ALL fallback paths (issue #242).
  if (configFallback === false) return undefined;
  // Configured fallback takes priority — only use if different from primary
  if (configFallback && configFallback !== modelString) return configFallback;
  // Default behavior: local models fall back to API tier defaults
  if (!isLocalModel(modelString)) return undefined;
  if (isConsensusPool(waveConfig)) {
    // Pool wave runners own their own fallback per member; nothing to do here.
    return undefined;
  }
  if (typeof waveConfig === 'string') {
    if (waveConfig === 'small' || waveConfig === 'medium' || waveConfig === 'large') {
      return getApiFallbackModelString(waveConfig);
    }
    // Bare model string with local prefix — fall back to medium tier
    return getApiFallbackModelString('medium');
  }
  // Object override with a local provider — fall back to medium tier
  return getApiFallbackModelString('medium');
}

/** Spawn a wave agent with automatic local-to-API fallback. Returns handoff + prompt hash.
 *
 * When `sandbox` is provided, the wave is dispatched into the sandbox container via
 * `dispatchSpawnWave` — the AI runs on `/workspace` inside the container, not on the
 * host filesystem. Without `sandbox`, the wave runs in-process on the host (the
 * worktree/none isolation modes).
 *
 * Issue #297: when `cacheContext` is provided, builds a deterministic
 * `sessionId` of the form `kova-<repo>-<issue>-<wave>` and forwards it to the
 * underlying spawn so providers that key prompt caching off session affinity
 * can keep the cache hot across the multi-turn run. The per-wave cache
 * retention default (long for impl/test) is applied inside spawnWaveAgent.
 */
/** Cached per-run skills + the configured enabledWaves list. Loaded once at the
 *  top of `fix()` and threaded through `spawnWave` so each wave's loadPrompt
 *  call gets the same skill set without re-scanning the filesystem (issue #298). */
interface FixRunSkills {
  skills: readonly import('@earendil-works/pi-coding-agent').Skill[];
  enabledWaves: readonly import('../types/index.js').SkillWaveName[];
}

async function spawnWave<T>(
  wave: FixAIWaveName,
  workDir: string,
  repoPath: string,
  config: RepoConfig,
  userMessage: string,
  outputFormat?: OutputFormat,
  mcpHandles?: Map<string, MCPServerHandle>,
  playwright?: { enabled: boolean },
  promptsDir?: string,
  projectContext?: ProjectContext,
  abTestVariant?: string,
  sandbox?: SandboxContext | undefined,
  runSkills?: FixRunSkills | undefined,
  cacheContext?: { repo: string; issue: string | number },
): Promise<{ handoff: WaveHandoff<T>; promptHash: string }> {
  const model = resolveWaveModel(config.model[wave]);
  const mcpTools =
    mcpHandles && mcpHandles.size > 0
      ? getMCPToolsForWave(wave, mcpHandles, config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined)
      : undefined;
  const tools = getWaveTools(wave, workDir, { customTools: config.tools, mcpTools, playwright });
  const systemPrompt = await loadPrompt(wave, config.tools, projectContext, promptsDir, {
    abTestVariant,
    ...(runSkills != null && {
      skills: { skills: runSkills.skills, enabledWaves: runSkills.enabledWaves },
    }),
  });
  const promptHash = hashPrompt(systemPrompt);

  // Prompt versioning: detect changes and record version
  const change = await detectPromptChange(repoPath, wave, systemPrompt).catch(() => null);
  if (change) {
    log.info(`Prompt changed for ${wave}: ${change.previousHash} → ${change.currentHash}`);
  }
  await recordPromptVersion(repoPath, wave, systemPrompt).catch(() => {});
  const thinkingLevel = resolveThinkingLevel(config, wave);
  const modelString = getModelString(model);
  const fallbackModel = waveFallbackModel(config.model[wave], modelString, config.model.fallback);
  // Issue #244: per-repo wave_timeout override (seconds) → ms.
  // Falls back to DEFAULT_WAVE_TIMEOUTS in spawnWaveAgent when undefined.
  const timeoutSeconds = config.rules.wave_timeout?.[wave];
  const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;
  // Issue #297: build a deterministic session id when caller supplied the
  // cache context. Forwarded to dispatchSpawnWave → spawnWaveAgent →
  // runtime, where pi-mono Agent threads it into the provider call as the
  // cache-affinity key. Cache retention defaults (long for impl/test) are
  // applied inside spawnWaveAgent and do not need to be set here.
  const sessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave }) : undefined;
  const handoff = await dispatchSpawnWave<T>(
    {
      wave,
      model: modelString,
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd: workDir,
      thinkingLevel,
      fallbackModel,
      ...(outputFormat != null && { outputFormat }),
      ...(timeoutMs != null && { timeoutMs }),
      ...(sessionId != null ? { sessionId } : {}),
    },
    sandbox,
  );
  return { handoff, promptHash };
}

/** Convert a WaveHandoff to WaveResult for checkpoint/cost-report compatibility. */
function handoffToResult(handoff: WaveHandoff, provider?: string, promptHash?: string): WaveResult {
  return {
    wave: handoff.wave,
    success: true,
    artifact: handoff.artifact,
    duration: 0,
    cost: handoff.cost,
    turns: handoff.turns,
    model: handoff.model,
    provider,
    fallback_used: handoff.fallback_used || undefined,
    local_attempt_cost: handoff.local_attempt_cost,
    promptHash,
    structured_output_metrics: handoff.structured_output_metrics,
    toolCallCounts: handoff.toolCallCounts,
  };
}

/** Convert a WaveResult to WaveHandoff for persistence. */
function waveResultToHandoff(result: WaveResult): WaveHandoff {
  // Infer `parsed` from the artifact shape: structured artifacts are objects;
  // raw model output that fell back to string fails the discriminator. See issue #308.
  const parsed = typeof result.artifact !== 'string' && result.artifact != null;
  return {
    wave: result.wave,
    timestamp: new Date().toISOString(),
    model: result.model ?? 'unknown',
    cost: result.cost,
    turns: result.turns,
    confidence: 'medium',
    parsed,
    artifact: result.artifact,
    approach_notes: '',
  };
}

// --- Active fix counter (for gauge) ---
let _activeFixes = 0;

// --- Main ---

export async function fix(options: FixOptions): Promise<FixResult> {
  const { issue, repoPath, repoName, fresh, noComment, pendingPRs, testRunner } = options;
  // `config` is reassignable in this function so we can swap in the
  // mode-overridden RepoConfig after WAVE A resolves `--mode`. Pre-WAVE-A
  // code paths (isolation check, sandbox startup, MCP wiring) see the input
  // config; WAVE T/I/Q see the mode-overridden config. Issue #282.
  let config: RepoConfig = options.config;
  let resolvedMode: PipelineMode | undefined = options.mode;
  // Extra impl attempts per piece, derived from the resolved mode. 0 for all
  // modes except `explore`. Plumbed into runParallelPieceTILoop below.
  let extraImplAttempts = 0;
  const fixStartTime = Date.now();
  _activeFixes++;
  metrics.setActiveFixes(_activeFixes);

  // Structured logging: create context-bound logger and init file output
  const runId = `fix-${issue.number}-${Date.now()}`;
  const flog: Logger = log.child({ issue: issue.number, repo: repoName });
  initFileLogger(repoPath, runId);

  // Pre-flight: validate isolation mode is available
  const isolationCheck = await validateIsolation(config.isolation);
  if (!isolationCheck.valid) {
    const errorMsg = isolationCheck.error ?? `Isolation mode "${config.isolation}" is not available`;
    const state = createInitialState(issue, repoName, repoPath);
    state.status = 'failed';
    state.error = errorMsg;
    metrics.recordIssueFailed();
    metrics.recordFixDuration(Date.now() - fixStartTime);
    metrics.recordFixCost(0);
    _activeFixes--;
    metrics.setActiveFixes(_activeFixes);
    closeFileLogger();
    return { success: false, error: errorMsg, state };
  }

  if (fresh) {
    if (config.isolation === 'worktree' && (await worktreeExists(repoPath, issue.number))) {
      await removeWorktree(repoPath, getWorktreePath(repoPath, issue.number));
      flog.info(`[fresh] Removed existing worktree for #${issue.number}`);
    }
  }

  const worktree =
    config.isolation === 'worktree'
      ? await createWorktree(repoPath, issue.number, {
          template: config.branch_name_template,
          issue: { number: issue.number, title: issue.title, labels: issue.labels },
        })
      : undefined;
  const workDir = worktree?.path ?? repoPath;
  const resolvedPromptsDir = resolvePromptsDir(repoPath, config.prompts_dir);
  // Issue #297: cache-affinity context. Stable across all waves of this fix
  // run so providers can keep the prompt cache hot per `<repo, issue, wave>`.
  // Threaded into every `spawnWave` call below; `buildWaveSessionId` adds the
  // wave suffix internally.
  const cacheContext = { repo: repoName, issue: issue.number };

  // Issue #298: load SKILL.md skills once per run. Resolved against `repoPath`
  // (not the worktree) so `.kova/skills` is found in the user's repo root, and
  // `~/.claude/skills` is expanded for user-global skills. When `config.skills`
  // is undefined, skip entirely — backward-compat with repos that don't opt in.
  const runSkills: FixRunSkills | undefined = await (async () => {
    if (!config.skills) return undefined;
    const skills = await loadWaveSkills({
      dirs: config.skills.dirs,
      cwd: repoPath,
    });
    if (skills.length === 0) return undefined;
    flog.info(`Loaded ${skills.length} skill(s) from ${config.skills.dirs.length} dir(s)`);
    return { skills, enabledWaves: config.skills.enabled_waves };
  })();

  // Sandbox: start the configured backend (docker by default, daytona for serverless persistence).
  // The backend abstraction (issue #301) lets repos.yaml swap docker for daytona/modal/fly without
  // touching pipeline code. The `docker` path preserves its legacy semantics (image build + timeout
  // kill) because they are docker-specific; non-docker backends manage hibernate/resume themselves.
  let sandboxContainerId: string | undefined;
  let sandboxContainerName: string | undefined;
  let sandboxContext: SandboxContext | undefined;
  let sandboxBackend: SandboxBackend | undefined;
  let sandboxTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let sandboxTimedOut = false;
  const sandboxStartTime = Date.now();

  if (config.isolation === 'docker') {
    // `sandbox.backend` defaults to 'docker' via Zod, but the optional sandbox block can be omitted
    // entirely — fall back to 'docker' explicitly so behavior matches pre-extraction default.
    const backendName = config.sandbox?.backend ?? 'docker';
    sandboxBackend = getSandboxBackend(backendName);

    if (backendName === 'docker') {
      // Legacy docker path: image build + direct container start. Behavior preserved bit-for-bit.
      const buildResult = await buildSandboxImage({ repoName, config: config.sandbox });
      if (!buildResult.success) {
        const state = createInitialState(issue, repoName, repoPath);
        state.status = 'failed';
        const errorMsg = buildResult.error ?? 'Docker image build failed';
        state.error = errorMsg;
        metrics.recordIssueFailed();
        metrics.recordFixDuration(Date.now() - fixStartTime);
        metrics.recordFixCost(0);
        _activeFixes--;
        metrics.setActiveFixes(_activeFixes);
        return { success: false, error: errorMsg, state };
      }

      const sandbox = await startSandboxContainer({
        repoName,
        issueNumber: issue.number,
        repoPath: workDir,
        config: config.sandbox,
      });
      sandboxContainerId = sandbox.containerId;
      sandboxContainerName = sandbox.containerName;
      // Build the SandboxContext that every wave-dispatch site below uses to
      // route into the container. Without this, the AI would run on the host
      // and the docker isolation would be a no-op (see issue #319).
      sandboxContext = { containerName: sandbox.containerName, repoPath: workDir };

      // Set up timeout kill
      const timeoutStr = config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout;
      const timeoutMs = parseTimeout(timeoutStr);
      sandboxTimeoutHandle = setTimeout(async () => {
        sandboxTimedOut = true;
        flog.warn(`[sandbox] Timeout (${timeoutStr}) exceeded — killing container ${sandboxContainerName}`);
        if (sandboxContainerId) await killContainer(sandboxContainerId);
      }, timeoutMs);
    } else {
      // Non-docker backend (daytona/modal/etc) — delegate fully to the SandboxBackend interface.
      // Credential errors surface here at start() rather than mid-wave, matching the
      // acceptance criterion "fail fast with a clear classified error during start".
      const handle = await sandboxBackend.start({
        repoName,
        issueNumber: issue.number,
        repoPath: workDir,
        config: config.sandbox,
      });
      sandboxContainerId = handle.containerId;
      sandboxContainerName = handle.containerName;
      // Non-docker backends own wave dispatch through `SandboxBackend.execWave()` — issue #379
      // generalized dispatch.ts to prefer `sandbox.backend` over the legacy docker-exec path
      // when present. The Docker branch above continues to pass only `containerName`+`repoPath`
      // so its behavior is bit-for-bit identical to the pre-extraction direct calls.
      sandboxContext = {
        containerName: handle.containerName,
        repoPath: workDir,
        backend: sandboxBackend,
      };
      flog.info(`[sandbox] Backend '${backendName}' started: ${handle.containerName} (dispatch via backend.execWave)`);
    }
  }

  // MCP server startup: resolve config and start servers for tool augmentation.
  // workDir threads through so per-fix path-sensitive servers (codegraph,
  // language servers) point at the worktree, not the orchestrator's cwd
  // (issue #270).
  let mcpHandles = new Map<string, MCPServerHandle>();
  try {
    const mcpServers = await resolveMCPServers(config.mcp);
    if (Object.keys(mcpServers).length > 0) {
      mcpHandles = await startAllMCPServers(mcpServers, workDir);
      flog.info(`[mcp] ${mcpHandles.size} MCP server(s) running (cwd=${workDir})`);
    }
  } catch (error) {
    flog.warn(`[mcp] Failed to start MCP servers: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (fresh) {
    await clearCheckpoint(workDir);
    flog.info(`[fresh] Cleared checkpoint — starting from scratch`);
  }

  const existing = await loadCheckpoint(workDir);
  let state: FixState;

  if (existing && existing.completedWaves.length > 0) {
    state = existing;
    // Restore waveResults from handoff files for any missing entries
    const handoffs = await loadAllHandoffs(workDir);
    for (const handoff of handoffs) {
      if (!state.waveResults[handoff.wave]) {
        state.waveResults[handoff.wave] = handoffToResult(handoff);
      }
    }
    flog.info(`Resuming — completed waves: [${state.completedWaves.join(', ')}]`);
  } else {
    state = createInitialState(issue, repoName, repoPath, worktree?.path);
  }

  // Smart phase detection (issue #283): decide pipeline scope, persist on
  // state, and mark scope-skipped waves as already-completed so `shouldSkip`
  // short-circuits them. Detection runs only on first entry (not on resume);
  // resumed state already carries `pipelineScope`.
  if (state.pipelineScope == null) {
    const scopeResult = await detectScope({ issue, workDir });
    applyScopeToState(state, scopeResult.scope, scopeResult.reason);
    flog.info(`[fix] ${formatScopeLogLine(scopeResult.scope, scopeResult.reason)}`);
    await saveCheckpoint(workDir, state);
  } else {
    flog.info(`[fix] ${formatScopeLogLine(state.pipelineScope, state.pipelineScopeReason ?? '(resumed)')}`);
  }
  const skipTestPhase = state.pipelineScope === 'IMPL_ONLY' || state.pipelineScope === 'REFACTOR';
  const skipImplPhase = state.pipelineScope === 'TEST_ONLY';

  const shouldSkip = (wave: WaveName): boolean => state.completedWaves.includes(wave);
  const prContext = formatPRContext(pendingPRs ?? []);

  // Derive owner/repo from issue URL for repo-intel calls
  const ownerRepo = extractOwnerRepo(issue.url);

  // Progress tracker: create/update a single GitHub comment as waves complete
  let progress: ProgressTracker | undefined;
  if (config.github?.progress_comments && ownerRepo) {
    progress = new ProgressTracker({ repoPath, ownerRepo, issue });
    await progress.start();
  }

  const interruptIfShutdown = async (): Promise<FixResult | undefined> => {
    if (!shutdownRequested()) return undefined;
    flog.info(`[shutdown] Interrupted after wave [${state.completedWaves.at(-1) ?? 'none'}]`);
    state.status = 'interrupted';
    await saveCheckpoint(workDir, state);
    return { success: false, error: 'Interrupted by signal', state };
  };

  // Track prompt hashes across waves for history correlation
  const promptHashes: Record<string, string> = {};

  // A/B test: select variants for configured waves. Consult historical
  // variant stats so we exploit known winners (epsilon-greedy), falling back
  // to uniform random when no sufficient data exists for a wave.
  let abTestVariants: VariantSelection | undefined;
  if (config.ab_test) {
    let abTestStats: ABTestVariantStats[] | undefined;
    try {
      const historyEntries = await readHistory(repoPath, { repo: repoName });
      abTestStats = correlateByABTestVariant(historyEntries);
    } catch (err) {
      flog.warn(
        `[ab-test] Failed to load history for adaptive selection — falling back to cold-start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let policy: { epsilon?: number; forceRandom?: boolean } | undefined;
    if (config.ab_test_policy) {
      policy = {};
      if (config.ab_test_policy.epsilon !== undefined) {
        policy.epsilon = config.ab_test_policy.epsilon;
      }
      if (config.ab_test_policy.force_random !== undefined) {
        policy.forceRandom = config.ab_test_policy.force_random;
      }
    }
    const selectOpts: Parameters<typeof selectVariants>[1] = {};
    if (abTestStats !== undefined) selectOpts.stats = abTestStats;
    if (policy !== undefined) selectOpts.policy = policy;
    abTestVariants = selectVariants(config.ab_test, selectOpts);
    flog.info(
      `A/B test variants selected: ${JSON.stringify(abTestVariants)} (stats: ${abTestStats?.length ?? 0} variants observed)`,
    );
  }

  try {
    // Load project context for prompt injection (CLAUDE.md, style config, CI config)
    const projectContext = await loadProjectContext(workDir);

    // Detect tooling and set up Playwright if applicable
    const tooling = await detectTooling(workDir);
    const playwrightEnabled = isPlaywrightEnabled(config, tooling);
    const playwrightOption = playwrightEnabled ? { enabled: true } : undefined;
    if (playwrightEnabled) {
      await ensureScreenshotsDir(workDir, config);
      const pwEnv = resolvePlaywrightEnv(config, tooling);
      for (const [key, val] of Object.entries(pwEnv)) {
        process.env[key] = val;
      }
      flog.info(`Playwright MCP enabled — screenshots dir: ${pwEnv.PLAYWRIGHT_SCREENSHOTS_DIR}`);
    }

    // Episodic memory: query for past learnings (before assess/spec waves)
    let episodicContext: string | undefined;
    let failedEpisodicContext: string | undefined;
    if (config.episodes?.enabled) {
      const query = `${issue.title}\n\n${issue.body}`;
      const vectorEpisodes = await queryEpisodeContext(config.episodes, query, {
        repo: repoName,
        language: tooling.language !== 'unknown' ? tooling.language : undefined,
      });

      // FTS5 keyword recall (#302): complements vector neighbors with exact
      // matches on error strings, symbols, paths. Local + optional — absent
      // DB returns []; disabled in config skips the path entirely.
      const ftsEpisodes = queryFTSEpisodes(workDir, config.episodes, query);
      const ftsAsContext = ftsEpisodes.map(ftsRecordToContext);

      // Merge: FTS hits first (exact tokens are higher-signal for recall),
      // then non-duplicate vector neighbors. Dedup key = `${repo}:${issue_number}`.
      const seenKeys = new Set<string>();
      const merged: typeof vectorEpisodes = [];
      for (const ep of ftsAsContext) {
        const key = `${ep.repo ?? ''}:${ep.issue_number}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        merged.push(ep);
      }
      for (const ep of vectorEpisodes) {
        const key = `${ep.repo ?? ''}:${ep.issue_number}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        merged.push(ep);
      }

      if (merged.length > 0) {
        episodicContext = formatEpisodes(merged, repoName);
        failedEpisodicContext = formatFailedEpisodes(merged, repoName) || undefined;
      }
    }

    // repo-intel: query for repository context (before assess wave)
    let repoContextText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoContext(config.repo_intel, ownerRepo, `${issue.title}\n\n${issue.body}`);
      if (raw.length > 0) {
        repoContextText = formatRepoContext(raw);
      }
    }

    // Pattern aggregation (#267): query top recurring (diagnosis × module) patterns
    // for this repo and inject into the assess/spec wave context. Best-effort —
    // disabled when episodes is off; absent DB returns no patterns silently.
    let patternContext: string | undefined;
    if (config.episodes?.enabled) {
      const patterns = queryPatternContext(workDir, config.episodes, repoName);
      if (patterns.length > 0) {
        patternContext = formatPatterns(patterns);
      }
    }

    // WAVE A: Assess
    if (!shouldSkip('assess')) {
      const waveStart = Date.now();
      const { handoff, promptHash } = await spawnWave<AssessResult>(
        'assess',
        workDir,
        repoPath,
        config,
        buildWaveContext(
          'assess',
          issue,
          {},
          {
            ...(episodicContext != null && { episodicContext }),
            ...(repoContextText != null && { repoContextText }),
            ...(patternContext != null && { patternContext }),
          },
        ),
        toOutputFormat(AssessResultSchema),
        mcpHandles,
        undefined,
        resolvedPromptsDir,
        projectContext,
        abTestVariants?.assess,
        sandboxContext,
        runSkills,
        cacheContext,
      );
      await saveHandoff(workDir, handoff);
      promptHashes.assess = promptHash;
      state.waveResults.assess = handoffToResult(handoff, waveProvider(config, 'assess'), promptHash);
      state.completedWaves.push('assess');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('assess', state);
      metrics.recordWaveCompleted('assess');
      metrics.recordWaveDuration('assess', Date.now() - waveStart);

      // Gate: only check when structured output parsed successfully
      if (handoff.confidence === 'high') {
        const assess = handoff.artifact;
        if (!assess.should_proceed) {
          flog.child({ wave: 'assess' }).warn(`Grade ${assess.grade} — not proceeding: ${assess.reasoning}`);
          if (!noComment) {
            await commentOnIssue(repoPath, issue.number, formatSkipComment(assess, issue));
          }
          state.status = 'completed';
          return { success: false, error: `Issue graded ${assess.grade}, skipped`, state };
        }
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Pipeline mode resolution (issue #282). Runs after WAVE A so auto-select
    // can read the feasibility grade + surface area. Explicit `options.mode`
    // overrides — auto-select only when no `--mode` was passed. Applies the
    // mode's per-wave tier overrides to `config` so every downstream wave
    // (test, impl, quality) routes through the mode-selected tiers without
    // editing repos.yaml.
    const assessArtifact = state.waveResults.assess?.artifact as AssessResult | undefined;
    if (resolvedMode != null) {
      flog.info(`Pipeline mode: ${resolvedMode} (explicit via --mode).`);
    } else if (assessArtifact != null) {
      const fileCount = assessArtifact.surface_area.files.length;
      resolvedMode = autoSelectMode(assessArtifact.grade, fileCount);
      flog.info(
        `Pipeline mode: ${resolvedMode} (auto-selected). ${describeAutoSelection(assessArtifact.grade, fileCount, resolvedMode)}`,
      );
    } else {
      // Assess artifact missing (e.g. confidence too low for structured output).
      // Fall back to standard — never economize when we can't see surface area.
      resolvedMode = 'standard';
      flog.info(`Pipeline mode: ${resolvedMode} (default — no assess artifact available).`);
    }
    config = applyPipelineMode(config, resolvedMode);
    extraImplAttempts = MODE_EXTRA_IMPL_ATTEMPTS[resolvedMode];
    if (extraImplAttempts > 0) {
      flog.info(
        `[mode] ${resolvedMode} — running up to ${3 + extraImplAttempts} impl attempts per piece (review selects winner).`,
      );
    }

    // Vector DB: query for relevant codebase context (before spec/impl waves)
    let codebaseContext: string | undefined;
    if (config.vectordb?.enabled) {
      const query = `${issue.title}\n\n${issue.body}`;
      const chunks = await queryCodeContext(config.vectordb, query);
      if (chunks.length > 0) {
        codebaseContext = formatCodeChunks(chunks);
      }
    }

    // repo-intel: query for similar implementations (before spec wave)
    let repoSearchText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoSearch(config.repo_intel, ownerRepo, `${issue.title}\n\n${issue.body}`);
      if (raw.length > 0) {
        repoSearchText = formatRepoSearch(raw);
      }
    }

    // Playbook synthesis (#299): query for a distilled playbook matching this
    // issue. Default off; gated by playbooks.enabled. Graceful degradation —
    // never blocks the fix on failure.
    let playbookContext: string | undefined;
    if (config.playbooks?.enabled) {
      const query = `${issue.title}\n\n${issue.body}`;
      const playbook = await queryPlaybook(config.playbooks, query, {
        repo: repoName,
        language: tooling.language !== 'unknown' ? tooling.language : undefined,
      });
      if (playbook) {
        playbookContext = formatPlaybook(playbook);
      }
    }

    // WAVE S: Spec
    if (!shouldSkip('spec')) {
      const waveStart = Date.now();
      const { handoff, promptHash } = await spawnWave(
        'spec',
        workDir,
        repoPath,
        config,
        buildWaveContext('spec', issue, state.waveResults, {
          prContext,
          ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
          ...(playbookContext != null && { playbookContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
          ...(patternContext != null && { patternContext }),
        }),
        toOutputFormat(SpecResultSchema),
        mcpHandles,
        undefined,
        resolvedPromptsDir,
        projectContext,
        abTestVariants?.spec,
        sandboxContext,
        runSkills,
        cacheContext,
      );
      await saveHandoff(workDir, handoff);
      promptHashes.spec = promptHash;
      state.waveResults.spec = handoffToResult(handoff, waveProvider(config, 'spec'), promptHash);
      state.completedWaves.push('spec');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('spec', state);
      metrics.recordWaveCompleted('spec');
      metrics.recordWaveDuration('spec', Date.now() - waveStart);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Gate: validate spec pieces have no overlapping files (between pieces or with pending PRs)
    let serialFallback = false;
    const pendingPRFileList = (pendingPRs ?? []).flatMap((pr) => pr.files);
    const specArtifact = state.waveResults.spec?.artifact as SpecResult | undefined;
    if (specArtifact?.pieces && specArtifact.pieces.length > 0) {
      const validation = validatePieceFileOwnership(
        specArtifact.pieces,
        specArtifact.dependency_order,
        pendingPRFileList,
      );

      // If a piece-to-piece merge occurred, persist the merged result back to state.
      // The TI loop reads from state.waveResults.spec.artifact, so the merge must
      // be visible there or downstream waves operate on stale, conflicting pieces.
      const existingSpecResult = state.waveResults.spec;
      if (validation.merged && existingSpecResult) {
        const mergedArtifact: SpecResult = {
          ...specArtifact,
          pieces: validation.pieces,
          dependency_order: validation.dependencyOrder,
        };
        state.waveResults.spec = {
          ...existingSpecResult,
          artifact: mergedArtifact,
        };
        await saveCheckpoint(workDir, state);
        log.info(
          `[fix] Persisted merged spec to state (${specArtifact.pieces.length} → ${validation.pieces.length} pieces)`,
        );
      }

      // Decide whether a spec retry is needed.
      // Retry is required only when merging cannot resolve the conflict on its own:
      //   - Pending-PR conflicts: the spec must restructure to avoid the PR files entirely.
      //   - Piece overlaps that did NOT result in a merge (defensive — shouldn't happen
      //     in practice since validator always merges what it can).
      const needsRetry =
        validation.pendingPRConflicts.length > 0 || (validation.overlaps.length > 0 && !validation.merged);

      if (needsRetry) {
        // Build combined feedback for both overlap types
        const feedbackParts: string[] = [];
        if (validation.overlaps.length > 0) {
          feedbackParts.push(formatOverlapFeedback(validation.overlaps));
        }
        if (validation.pendingPRConflicts.length > 0) {
          feedbackParts.push(formatPendingPRConflictFeedback(validation.pendingPRConflicts));
        }
        const feedback = feedbackParts.join('\n\n');

        log.warn(
          `[fix] Spec retry needed (${validation.overlaps.length} piece overlap(s), ${validation.pendingPRConflicts.length} pending PR conflict(s)), re-running spec with feedback`,
        );

        const specContext = buildWaveContext('spec', issue, state.waveResults, {
          prContext,
          ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
        });

        const { handoff: retryHandoff, promptHash: retryPromptHash } = await spawnWave(
          'spec',
          workDir,
          repoPath,
          config,
          `${specContext}\n\n${feedback}`,
          toOutputFormat(SpecResultSchema),
          mcpHandles,
          undefined,
          resolvedPromptsDir,
          projectContext,
          abTestVariants?.spec,
          sandboxContext,
          runSkills,
          cacheContext,
        );

        await saveHandoff(workDir, retryHandoff);
        promptHashes.spec = retryPromptHash;
        state.waveResults.spec = handoffToResult(retryHandoff, waveProvider(config, 'spec'), retryPromptHash);
        await saveCheckpoint(workDir, state);

        // Validate retry result
        const retryArtifact = state.waveResults.spec?.artifact as SpecResult | undefined;
        if (retryArtifact?.pieces && retryArtifact.pieces.length > 0) {
          const retryValidation = validatePieceFileOwnership(
            retryArtifact.pieces,
            retryArtifact.dependency_order,
            pendingPRFileList,
          );

          // Persist any merge from the retry as well — same reason as the first pass.
          const existingRetrySpec = state.waveResults.spec;
          if (retryValidation.merged && existingRetrySpec) {
            const mergedRetryArtifact: SpecResult = {
              ...retryArtifact,
              pieces: retryValidation.pieces,
              dependency_order: retryValidation.dependencyOrder,
            };
            state.waveResults.spec = {
              ...existingRetrySpec,
              artifact: mergedRetryArtifact,
            };
            await saveCheckpoint(workDir, state);
            log.info(
              `[fix] Persisted merged retry spec to state (${retryArtifact.pieces.length} → ${retryValidation.pieces.length} pieces)`,
            );
          }

          if (!retryValidation.valid) {
            if (retryValidation.overlaps.length > 0 && !retryValidation.merged) {
              log.warn(
                `[fix] Spec retry still has overlapping files — falling back to serial execution (maxConcurrent: 1)`,
              );
              serialFallback = true;
            }
            if (retryValidation.pendingPRConflicts.length > 0) {
              // Persistent pending PR conflicts — record merge dependencies
              const conflictingFiles = new Set(retryValidation.pendingPRConflicts.map((c) => c.file));
              const depPRNumbers = new Set<number>();
              for (const pr of pendingPRs ?? []) {
                if (pr.files.some((f) => conflictingFiles.has(f))) {
                  depPRNumbers.add(pr.number);
                }
              }
              if (depPRNumbers.size > 0) {
                state.mergeDependencies = [...depPRNumbers];
                log.warn(
                  `[fix] Pending PR conflicts persist — recording merge dependencies: [${[...depPRNumbers].map((n) => `#${n}`).join(', ')}]`,
                );
              }
            }
          }
        }
      }
    }

    // Gate: if spec produced no pieces OR fell back to the raw-string path,
    // retry once before falling through to the TI loop (which would throw without pieces).
    // See issue #243 — local models fail JSON parsing intermittently; a single retry
    // often succeeds since the failure is non-deterministic.
    // The `parsed === false` check (issue #308) is the explicit type-level signal that
    // structured output parsing failed; the pieces-length check is a defense-in-depth
    // guard for the case where the artifact parsed to an unexpected shape.
    // Skip this gate only when the test/impl waves themselves are skipped (e.g. REVIEW_ONLY).
    if (!(shouldSkip('test') && shouldSkip('impl'))) {
      const specHandoff = await loadHandoff<SpecResult>(workDir, 'spec');
      const specAfterValidation = state.waveResults.spec?.artifact as SpecResult | undefined;
      const specParseFailed = specHandoff?.parsed === false;
      if (specParseFailed || !specAfterValidation?.pieces || specAfterValidation.pieces.length === 0) {
        log.warn(
          `[fix] Spec produced no pieces (parsed=${specHandoff?.parsed ?? 'unknown'}, likely structured output parse failure), retrying once`,
        );

        const emptyRetryContext = buildWaveContext('spec', issue, state.waveResults, {
          prContext,
          ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
        });

        const { handoff: emptyRetryHandoff, promptHash: emptyRetryPromptHash } = await spawnWave(
          'spec',
          workDir,
          repoPath,
          config,
          emptyRetryContext,
          toOutputFormat(SpecResultSchema),
          mcpHandles,
          undefined,
          resolvedPromptsDir,
          projectContext,
          abTestVariants?.spec,
          sandboxContext,
          runSkills,
          cacheContext,
        );

        await saveHandoff(workDir, emptyRetryHandoff);
        promptHashes.spec = emptyRetryPromptHash;
        state.waveResults.spec = handoffToResult(emptyRetryHandoff, waveProvider(config, 'spec'), emptyRetryPromptHash);
        await saveCheckpoint(workDir, state);

        const specAfterRetry = state.waveResults.spec?.artifact as SpecResult | undefined;
        if (!specAfterRetry?.pieces || specAfterRetry.pieces.length === 0) {
          const errorMsg =
            'Spec wave produced no pieces after retry (likely structured output parse failure). ' +
            'This usually indicates the model could not produce a valid spec JSON. ' +
            'Try a different model, simplify the issue, or break it into smaller sub-issues.';
          flog.error(`[fix] ${errorMsg}`);
          state.status = 'failed';
          state.error = errorMsg;
          await saveCheckpoint(workDir, state);
          await progress?.failed(errorMsg);
          metrics.recordIssueFailed();
          return { success: false, error: errorMsg, state };
        }
      }
    }

    // WAVE T + I: Parallel Piece TI Loop (fan-out per piece, backward compat for 1 piece)
    if (!(shouldSkip('test') && shouldSkip('impl'))) {
      const tiWaveStart = Date.now();
      const tiResult = await runParallelPieceTILoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        prContext,
        codebaseContext,
        projectContext,
        ...(testRunner != null && { testRunner }),
        ...(serialFallback && { maxConcurrent: 1 }),
        ...(sandboxContext != null && { sandbox: sandboxContext }),
        cacheContext,
        ...(skipTestPhase && { skipTestPhase: true }),
        ...(skipImplPhase && { skipImplPhase: true }),
        ...(extraImplAttempts > 0 && { extraImplAttempts }),
      });

      // Save handoffs for test and impl
      await saveHandoff(workDir, waveResultToHandoff(tiResult.testWaveResult));
      state.waveResults.test = tiResult.testWaveResult;

      const implHandoff: WaveHandoff = {
        ...waveResultToHandoff(tiResult.implWaveResult),
        confidence: tiResult.testsPassing ? 'high' : 'low',
        approach_notes: tiResult.diagnosis ? `diagnosis: ${tiResult.diagnosis}` : '',
      };
      await saveHandoff(workDir, implHandoff);
      state.waveResults.impl = tiResult.implWaveResult;
      state.diagnosis = tiResult.diagnosis;
      state.thrashingSignal =
        tiResult.modifiedFilesPerAttempt.length >= 2 ? detectThrashing(tiResult.modifiedFilesPerAttempt) : undefined;
      state.retryAttempts = tiResult.attempts;

      if (!state.completedWaves.includes('test')) state.completedWaves.push('test');
      if (!state.completedWaves.includes('impl')) state.completedWaves.push('impl');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('impl', state);
      const tiDuration = Date.now() - tiWaveStart;
      metrics.recordWaveCompleted('test');
      metrics.recordWaveDuration('test', tiDuration);
      metrics.recordWaveCompleted('impl');
      metrics.recordWaveDuration('impl', tiDuration);

      // Escalation: shouldRespec → re-run spec + TI loop (max 1 re-spec)
      if (!tiResult.testsPassing && tiResult.shouldRespec) {
        flog.info(`[escalation] ${tiResult.diagnosis ?? 'SPEC_WRONG'} — re-running spec then TI loop`);
        const respecContext = `Previous spec led to ${tiResult.diagnosis ?? 'failure'} — the implementation could not pass the tests. Re-examine the requirements and produce a revised spec.`;
        const { handoff: specHandoff, promptHash: specPromptHash } = await spawnWave(
          'spec',
          workDir,
          repoPath,
          config,
          buildWaveContext('spec', issue, state.waveResults, {
            prContext,
            ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
            ...(codebaseContext != null && { codebaseContext }),
            ...(repoSearchText != null && { repoSearchText }),
            escalationHint: respecContext,
          }),
          toOutputFormat(SpecResultSchema),
          mcpHandles,
          undefined,
          resolvedPromptsDir,
          projectContext,
          abTestVariants?.spec,
          sandboxContext,
          runSkills,
          cacheContext,
        );
        await saveHandoff(workDir, specHandoff);
        promptHashes.spec = specPromptHash;
        state.waveResults.spec = handoffToResult(specHandoff, waveProvider(config, 'spec'), specPromptHash);

        const retryTI = await runParallelPieceTILoop({
          issue,
          workDir,
          repoConfig: config,
          waveResults: state.waveResults,
          prContext,
          codebaseContext,
          projectContext,
          ...(testRunner != null && { testRunner }),
          ...(sandboxContext != null && { sandbox: sandboxContext }),
          cacheContext,
          ...(skipTestPhase && { skipTestPhase: true }),
          ...(skipImplPhase && { skipImplPhase: true }),
          ...(extraImplAttempts > 0 && { extraImplAttempts }),
        });
        state.waveResults.test = retryTI.testWaveResult;
        state.waveResults.impl = retryTI.implWaveResult;
        await saveCheckpoint(workDir, state);

        if (!retryTI.testsPassing) {
          trackFailedPiece(state, retryTI.diagnosis);
        }
      } else if (!tiResult.testsPassing) {
        trackFailedPiece(state, tiResult.diagnosis);
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // repo-intel: query for project standards (before quality wave)
    let repoStandardsText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoStandards(config.repo_intel, ownerRepo);
      if (raw.length > 0) {
        repoStandardsText = formatRepoStandards(raw);
      }
    }

    // WAVE Q: Quality
    if (!shouldSkip('quality')) {
      const waveStart = Date.now();
      const { handoff, promptHash } = await spawnWave(
        'quality',
        workDir,
        repoPath,
        config,
        buildWaveContext('quality', issue, state.waveResults, {
          coverageThreshold: config.rules.coverage,
          ...(repoStandardsText != null && { repoStandardsText }),
        }),
        toOutputFormat(QualityRemediationSchema),
        mcpHandles,
        undefined,
        resolvedPromptsDir,
        projectContext,
        abTestVariants?.quality,
        sandboxContext,
        runSkills,
        cacheContext,
      );
      await saveHandoff(workDir, handoff);
      promptHashes.quality = promptHash;
      state.waveResults.quality = handoffToResult(handoff, waveProvider(config, 'quality'), promptHash);
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('quality', state);
      metrics.recordWaveCompleted('quality');
      metrics.recordWaveDuration('quality', Date.now() - waveStart);

      // Quality self-healing: retry impl if quality detects test failures
      const qualityRetry = await runQualityRetryLoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        ...(testRunner != null && { testRunner }),
        projectContext,
        ...(sandboxContext != null && { sandbox: sandboxContext }),
        cacheContext,
      });
      if (qualityRetry.retried) {
        state.waveResults.quality = qualityRetry.qualityWaveResult;
        await saveCheckpoint(workDir, state);
        log.info(`[fix] Quality self-healing completed (cost: $${qualityRetry.totalCost.toFixed(2)})`);
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE R: Review Loop
    if (!shouldSkip('review')) {
      const waveStart = Date.now();
      // Query past review feedback for injection into review wave
      let reviewFeedbackContext: string | undefined;
      if (config.episodes?.enabled) {
        const feedbackItems = await queryReviewFeedbackContext(
          config.episodes,
          `${issue.title}\n\n${issue.body}`,
          repoName,
        );
        if (feedbackItems.length > 0) {
          reviewFeedbackContext = formatReviewFeedback(feedbackItems);
        }
      }

      const reviewLoopResult = await runReviewLoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        prContext,
        projectContext,
        ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
        ...(testRunner != null && { testRunner }),
        playwright: playwrightOption,
        ...(sandboxContext != null && { sandbox: sandboxContext }),
        cacheContext,
      });

      // Save review handoff
      await saveHandoff(workDir, {
        wave: 'review' as WaveName,
        timestamp: new Date().toISOString(),
        model: reviewLoopResult.reviewWaveResult.model ?? 'unknown',
        cost: reviewLoopResult.totalCost,
        turns: reviewLoopResult.reviewWaveResult.turns,
        confidence: reviewLoopResult.knownIssues.length === 0 ? 'high' : 'medium',
        artifact: reviewLoopResult.reviewWaveResult.artifact,
        approach_notes: `${reviewLoopResult.iterations} iteration(s)`,
      });

      state.waveResults.review = reviewLoopResult.reviewWaveResult;
      if (reviewLoopResult.qualityWaveResult) {
        state.waveResults.quality = reviewLoopResult.qualityWaveResult;
      }
      state.completedWaves.push('review');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('review', state);
      metrics.recordWaveCompleted('review');
      metrics.recordWaveDuration('review', Date.now() - waveStart);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;

      // Thread known issues to PR body
      if (reviewLoopResult.knownIssues.length > 0) {
        state.reviewKnownIssues = reviewLoopResult.knownIssues.map((f) => ({
          category: f.category,
          file: f.file,
          description: f.description,
          severity: f.severity,
        }));
      }
    }

    // Ship — no AI wave, just git operations
    if (!shouldSkip('ship')) {
      const shipStart = Date.now();
      const branch = worktree?.branch ?? `kova/fix-${issue.number}`;

      // Pre-ship conflict detection via dry-run merge
      const specArtifactForShip = state.waveResults.spec?.artifact as SpecResult | undefined;
      const specFiles = specArtifactForShip?.pieces?.flatMap((p) => p.files) ?? [];
      const conflictCheck = await checkForConflicts(workDir, specFiles);

      if (conflictCheck.hasConflicts) {
        metrics.recordConflictDetected();
        flog.info(`Pre-ship conflict check: ${conflictCheck.conflictingFiles.join(', ')}`);

        // Non-overlapping conflicts (files we didn't touch) — accept upstream version
        if (conflictCheck.nonOverlapping.length > 0) {
          const defaultBranch = await detectDefaultBranch(workDir);
          flog.info(`Auto-resolving non-overlapping conflicts: ${conflictCheck.nonOverlapping.join(', ')}`);
          for (const file of conflictCheck.nonOverlapping) {
            try {
              await $`git -C ${workDir} checkout origin/${defaultBranch} -- ${file}`;
              await $`git -C ${workDir} add ${file}`;
            } catch {
              flog.warn(`Failed to checkout upstream version of ${file}`);
            }
          }
          // Commit the upstream file adoptions
          try {
            await $`git -C ${workDir} commit -m ${'chore: adopt upstream changes for non-overlapping files'}`;
          } catch {
            // Nothing to commit — that's fine
          }
        }

        // Overlapping conflicts (in our spec files) — retry impl once with conflict context
        if (conflictCheck.overlapping.length > 0) {
          flog.info(`Overlapping conflicts in spec files: ${conflictCheck.overlapping.join(', ')} — retrying impl`);
          const conflictHint = `Your changes conflict with upstream in: ${conflictCheck.overlapping.join(', ')}. Fetch the latest version of these files from the default branch and adapt your implementation to avoid merge conflicts.`;

          const retryTI = await runParallelPieceTILoop({
            issue,
            workDir,
            repoConfig: config,
            waveResults: state.waveResults,
            prContext,
            codebaseContext: [codebaseContext, conflictHint].filter(Boolean).join('\n\n'),
            projectContext,
            ...(testRunner != null && { testRunner }),
            ...(sandboxContext != null && { sandbox: sandboxContext }),
            cacheContext,
            ...(skipTestPhase && { skipTestPhase: true }),
            ...(skipImplPhase && { skipImplPhase: true }),
            ...(extraImplAttempts > 0 && { extraImplAttempts }),
          });

          state.waveResults.test = retryTI.testWaveResult;
          state.waveResults.impl = retryTI.implWaveResult;
          await saveCheckpoint(workDir, state);

          if (!retryTI.testsPassing) {
            flog.warn('Conflict retry: tests not passing after impl retry, proceeding with rebase');
          }
        }
      }

      // Rebase on default branch before shipping
      const rebaseResult = await rebaseOnDefault(workDir);
      metrics.recordRebaseAttempt();

      if (!rebaseResult.success && rebaseResult.conflicted) {
        metrics.recordConflictDetected();

        // Attempt auto-resolution — resolveConflicts completes the rebase if successful
        const defaultBranch = await detectDefaultBranch(workDir);
        const resolution = await resolveConflicts(workDir, defaultBranch);

        if (resolution.resolved) {
          metrics.recordConflictResolved();
          flog.info(`Conflicts auto-resolved in: ${resolution.filesResolved.join(', ')}`);
        } else {
          metrics.recordConflictFailed();
          const filesUnresolved = (resolution as { filesUnresolved?: string[] }).filesUnresolved ?? [];
          flog.error('Merge conflicts could not be resolved');
          state.status = 'failed';
          state.error = `Unresolvable merge conflicts in: ${filesUnresolved.join(', ')}`;
          await saveCheckpoint(workDir, state);
          metrics.recordIssueFailed();
          return { success: false, error: state.error, state };
        }
      }

      // Pre-commit secrets scan — deterministic orchestrator gate
      const changedFiles = await getChangedFiles(workDir);

      if (changedFiles.length > 0) {
        const secretsScan = await scanForSecrets(workDir, changedFiles);
        if (!secretsScan.clean) {
          flog.error(`Secrets detected before commit:\n${secretsScan.report}`);
          state.status = 'failed';
          state.error = `Secrets detected — commit blocked: ${secretsScan.findings.length} finding(s)\n${secretsScan.report}`;
          await saveCheckpoint(workDir, state);
          metrics.recordIssueFailed();
          return { success: false, error: state.error, state };
        }
      }

      const commitResult = await commitAndPush(workDir, branch, issue);
      if (!commitResult.committed) {
        flog.child({ wave: 'ship' }).warn('No changes to commit — skipping PR');
        state.waveResults.ship = {
          wave: 'ship',
          success: true,
          artifact: { noChanges: true },
          duration: 0,
          cost: 0,
          turns: 0,
        };
        state.completedWaves.push('ship');
        state.status = 'completed';
        await saveCheckpoint(workDir, state);
        metrics.recordWaveCompleted('ship');
        metrics.recordWaveDuration('ship', Date.now() - shipStart);
        metrics.recordIssueFixed();
        return { success: true, state };
      }

      const openPRs = await listOpenPRs(repoPath);
      const prTitle = `fix: ${issue.title} (#${issue.number})`;
      const prSections = [
        `## Summary`,
        `Fixes #${issue.number}`,
        ``,
        `## Context`,
        `${issue.title}`,
        ``,
        `## Open PRs (for merge ordering)`,
        ...openPRs.map((pr) => `- ${pr}`),
      ];

      if (state.mergeDependencies && state.mergeDependencies.length > 0) {
        prSections.push(``, `## Merge Dependencies`, ...state.mergeDependencies.map((n) => `depends on #${n}`));
      }

      if (state.reviewKnownIssues && state.reviewKnownIssues.length > 0) {
        prSections.push(
          ``,
          `## Known Issues`,
          `The following issues were identified during review but could not be resolved within the iteration limit:`,
          ``,
          ...state.reviewKnownIssues.map((i) => `- [${i.severity}] \`${i.file}\`: ${i.description}`),
        );
      }

      const prBody = prSections.join('\n');
      const prUrl = await createPR(workDir, branch, prTitle, prBody);

      state.waveResults.ship = {
        wave: 'ship',
        success: true,
        artifact: { prUrl, commitMessage: commitResult.commitMessage, filesStaged: commitResult.filesStaged },
        duration: 0,
        cost: 0,
        turns: 0,
      };
      state.completedWaves.push('ship');
      state.status = 'completed';
      await saveCheckpoint(workDir, state);
      await progress?.complete(prUrl);
      metrics.recordWaveCompleted('ship');
      metrics.recordWaveDuration('ship', Date.now() - shipStart);
      metrics.recordPRCreated();
      metrics.recordIssueFixed();
      flog.info(`Fix complete: ${prUrl}`);
      return { success: true, prUrl, state };
    }

    state.status = 'completed';
    metrics.recordIssueFixed();
    return { success: true, state };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    flog.error(`Fix failed: ${msg}`);
    state.status = 'failed';
    state.error = msg;
    await saveCheckpoint(workDir, state);
    await progress?.failed(msg);
    metrics.recordIssueFailed();
    return { success: false, error: msg, state };
  } finally {
    // Metrics: record fix totals and decrement active gauge
    const fixTotalMs = Date.now() - fixStartTime;
    metrics.recordFixDuration(fixTotalMs);
    const totalCost = Object.values(state.waveResults).reduce((sum, wr) => sum + (wr?.cost ?? 0), 0);
    metrics.recordFixCost(totalCost);
    _activeFixes--;
    metrics.setActiveFixes(_activeFixes);
    // Sandbox cleanup: collect stats then stop the backend.
    // Docker path uses the legacy helpers directly to preserve observable behavior;
    // non-docker backends (daytona/modal/etc) route through the SandboxBackend interface.
    if (sandboxContainerId) {
      if (sandboxTimeoutHandle) clearTimeout(sandboxTimeoutHandle);

      // Collect resource usage before stopping
      const stats = sandboxBackend
        ? await sandboxBackend.getStats().catch(() => ({ memoryMB: 0, cpuPercent: 0 }))
        : await getContainerStats(sandboxContainerId).catch(() => ({ memoryMB: 0, cpuPercent: 0 }));
      const wallTimeMs = Date.now() - sandboxStartTime;
      const cpuCount = config.sandbox?.cpus ?? DEFAULT_SANDBOX_LIMITS.cpus;

      state.sandboxResourceUsage = {
        peakMemoryMB: stats.memoryMB,
        cpuSeconds: (stats.cpuPercent / 100) * cpuCount * (wallTimeMs / 1000),
        wallTimeMs,
        containerName: sandboxContainerName ?? 'unknown',
        limitsApplied: {
          cpus: cpuCount,
          memory: config.sandbox?.memory ?? DEFAULT_SANDBOX_LIMITS.memory,
          timeout: config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout,
        },
      };

      if (sandboxTimedOut) {
        flog.warn('[sandbox] Container was killed due to timeout');
      }

      const backendName = config.sandbox?.backend ?? 'docker';
      if (backendName === 'docker') {
        // Preserve the legacy direct call so DockerBackend extraction is observationally identical.
        await killContainer(sandboxContainerId).catch(() => {});
      } else if (sandboxBackend) {
        await sandboxBackend.stop().catch(() => {});
      }
    }

    const costReport = buildCostReport(state);
    printRunSummary(costReport);
    await writeCostReport(workDir, costReport).catch((err) => {
      flog.warn(`Failed to write cost report: ${err instanceof Error ? err.message : String(err)}`);
    });

    // History: append run entry for analytics
    const shipResult = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;
    const prUrlForHistory = shipResult?.prUrl;

    // Aggregate per-wave structured-output telemetry for the history entry
    // (issue #247). Skip waves that don't carry metrics so legacy/no-op waves
    // don't appear with empty objects.
    type HistoryWaveMetric = {
      parse_method?:
        | 'json-tag'
        | 'json-tag-repaired'
        | 'markdown-fence'
        | 'markdown-fence-repaired'
        | 'direct-parse'
        | 'direct-parse-repaired'
        | null
        | undefined;
      attempts: number;
      success: boolean;
      repair_attempts: number;
      model?: string;
    };
    const structuredOutputMetrics: Record<string, HistoryWaveMetric> = {};
    for (const [waveName, waveResult] of Object.entries(state.waveResults)) {
      const metrics = waveResult?.structured_output_metrics;
      if (!metrics) continue;
      const entry: HistoryWaveMetric = {
        attempts: metrics.attempts,
        success: metrics.success,
        repair_attempts: metrics.repair_attempts,
      };
      if (metrics.parse_method !== undefined) {
        entry.parse_method = metrics.parse_method;
      }
      if (waveResult?.model != null) {
        entry.model = waveResult.model;
      }
      structuredOutputMetrics[waveName] = entry;
    }

    // Issue #278: aggregate per-wave tool-call counts into a single run-level
    // total. The retrieval-quality eval harness reads this from history.jsonl
    // to compute the context-on vs context-off delta (tool-call/Read reduction).
    let aggregatedToolCallCounts: { total: number; reads: number; byTool: Record<string, number> } | undefined;
    {
      let total = 0;
      let reads = 0;
      const byTool: Record<string, number> = {};
      let observedAny = false;
      for (const waveResult of Object.values(state.waveResults)) {
        const counts = waveResult?.toolCallCounts;
        if (!counts) continue;
        observedAny = true;
        total += counts.total;
        reads += counts.reads;
        for (const [name, n] of Object.entries(counts.byTool)) {
          byTool[name] = (byTool[name] ?? 0) + n;
        }
      }
      if (observedAny) {
        aggregatedToolCallCounts = { total, reads, byTool };
      }
    }

    // Per-run causal telemetry (issue #266): hoist assess.grade, FixState
    // diagnosis/thrashing/retryAttempts, and quality.* gate failures into the
    // flat history.jsonl so `kova history --stats` and `/reflect` can break
    // success down by why-it-failed, not just cost/outcome.
    const assessArtifactForHistory = state.waveResults.assess?.artifact as
      | { grade?: 'A' | 'B' | 'C' | 'D' | 'F' }
      | undefined;
    const qualityArtifactForHistory = state.waveResults.quality?.artifact as
      | { lint?: string; typecheck?: string; tests?: string; audit?: string; all_passing?: boolean }
      | undefined;
    const GATE_KEYS = ['lint', 'typecheck', 'tests', 'audit'] as const;
    const gatesFailed: string[] = qualityArtifactForHistory
      ? GATE_KEYS.filter((k) => qualityArtifactForHistory[k] === 'fail')
      : [];
    // firstPassQuality is only meaningful when we observed quality at all.
    // Definition: zero impl retries AND all quality gates passed → green on
    // first try. If quality didn't run, leave the field undefined.
    const firstPassQuality =
      qualityArtifactForHistory?.all_passing != null
        ? qualityArtifactForHistory.all_passing && (state.retryAttempts ?? 0) === 0
        : undefined;

    await appendHistoryEntry(repoPath, {
      timestamp: state.startedAt,
      repo: repoName,
      issues: [
        {
          number: issue.number,
          title: issue.title,
          success: state.status === 'completed',
          ...(prUrlForHistory != null && { prUrl: prUrlForHistory }),
          ...(state.error != null && { error: state.error }),
        },
      ],
      prsCreated: prUrlForHistory ? 1 : 0,
      cost: costReport.totalCost,
      duration: costReport.totalDuration,
      outcome:
        state.status === 'completed'
          ? state.failedPieces && state.failedPieces.length > 0
            ? 'partial'
            : 'success'
          : 'failure',
      ...(Object.keys(promptHashes).length > 0 && { promptHashes }),
      ...(abTestVariants != null && Object.keys(abTestVariants).length > 0 && { abTestVariants }),
      ...(Object.keys(structuredOutputMetrics).length > 0 && { structuredOutputMetrics }),
      ...(assessArtifactForHistory?.grade != null && { grade: assessArtifactForHistory.grade }),
      ...(state.diagnosis != null && { diagnosis: state.diagnosis }),
      ...(state.thrashingSignal != null && { thrashingSignal: state.thrashingSignal }),
      ...(gatesFailed.length > 0 && { gatesFailed }),
      ...(firstPassQuality != null && { firstPassQuality }),
      ...(state.retryAttempts != null && { retryAttempts: state.retryAttempts }),
      // Issue #278: per-run tool-call totals + contextArm from repo config.
      ...(aggregatedToolCallCounts != null && { toolCallCounts: aggregatedToolCallCounts }),
      ...(config.eval?.context_arm != null && { contextArm: config.eval.context_arm }),
    }).catch((err) => {
      log.warn(`Failed to record history: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Episodic memory: record fix outcome (success or failure)
    if (config.episodes?.enabled) {
      const episode = buildEpisodeRecord(state);
      const recordTooling = await detectTooling(workDir).catch(() => ({ language: 'unknown' as const }));
      if (recordTooling.language !== 'unknown') {
        episode.language = recordTooling.language;
      }
      await recordEpisode(config.episodes, episode).catch((err) => {
        flog.warn(`Failed to record episode: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Mirror the episode to the local FTS5 index (#302). Optional, local,
      // best-effort — any failure is logged-and-swallowed so it never breaks
      // the existing REST recordEpisode path.
      upsertEpisodeFTS(workDir, config.episodes, episode, flog);

      // Aggregate the episode into the recurring-pattern table (#267). Local,
      // best-effort — failures logged + swallowed so a flaky DB never breaks
      // the existing record/ship path.
      upsertEpisodePattern(workDir, config.episodes, episode, flog);
    }

    // PR feedback collection: collect review comments after ship
    const shipArtifact = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;
    const shipPrUrl = shipArtifact?.prUrl;
    if (config.episodes?.enabled && shipPrUrl) {
      const prNumberMatch = shipPrUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch?.[1] ? Number.parseInt(prNumberMatch[1], 10) : undefined;
      if (prNumber) {
        collectPRFeedback({ episodesConfig: config.episodes, repoName, prNumber, repoPath: workDir }).catch((err) => {
          flog.warn(`Failed to collect PR feedback: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    closeFileLogger();

    // MCP server cleanup
    if (mcpHandles.size > 0) {
      await stopAllMCPServers(mcpHandles);
    }

    if (worktree && state.status === 'completed') {
      await removeWorktree(repoPath, worktree.path);
    }
  }
}

function trackFailedPiece(state: FixState, diagnosis?: string): void {
  const piece: FailedPiece = {
    pieceName: 'impl',
    diagnosis: {
      category: diagnosis ?? 'STUCK',
      theory: 'TI loop exhausted all retries',
      tests_still_failing: [],
    },
  };
  state.failedPieces = [...(state.failedPieces ?? []), piece];
}

function createInitialState(issue: Issue, repo: string, repoPath: string, worktree?: string): FixState {
  return {
    issue,
    repo,
    repoPath,
    worktree,
    startedAt: new Date().toISOString(),
    completedWaves: [],
    waveResults: {},
    status: 'running',
  };
}

/** Extract "owner/repo" from a GitHub issue URL. Returns undefined if not parseable. */
function extractOwnerRepo(issueUrl: string): string | undefined {
  const match = issueUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match?.[1];
}

function formatSkipComment(assess: AssessResult, _issue: Issue): string {
  const files = assess.surface_area.files.length > 0 ? assess.surface_area.files.join(', ') : 'N/A';
  const recommendation =
    assess.grade === 'F'
      ? 'Break this issue into smaller, independently fixable pieces.'
      : 'Consider rescoping this issue to reduce surface area.';
  return [
    '## Kova Assessment — Skipped',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Grade** | ${assess.grade} |`,
    `| **Risk** | ${assess.risk} |`,
    `| **Estimated lines** | ${assess.surface_area.estimated_lines} |`,
    `| **Files** | ${files} |`,
    `| **Modules** | ${assess.surface_area.modules_affected.join(', ') || 'N/A'} |`,
    '',
    '### Reasoning',
    assess.reasoning,
    '',
    '### Recommendation',
    recommendation,
  ].join('\n');
}

/* ================================================================== */
/*  Local FTS5 episode recall (#302) — helpers                         */
/* ================================================================== */

/**
 * Resolve the on-disk path for the local FTS5 episode index. Honors an
 * explicit override on `config.episodes.fts.path` if present; otherwise
 * defaults to `{workDir}/.kova/episode-fts.db`.
 */
function resolveFTSPath(workDir: string, config: EpisodicMemoryConfig): string {
  return config.fts?.path ?? joinPath(workDir, '.kova', 'episode-fts.db');
}

/**
 * Whether the FTS5 sidecar is enabled. Default is on (treat `fts === undefined`
 * as enabled) — explicit opt-out via `fts: { enabled: false }`.
 */
function ftsEnabled(config: EpisodicMemoryConfig): boolean {
  if (config.fts === undefined) return true;
  return config.fts.enabled !== false;
}

/**
 * Open the local FTS5 store, run `searchEpisodesFTS(query)`, return the rows.
 * Best-effort: any open/query failure returns []. Absent DB is the normal
 * first-run state and produces a silent empty result (no warning log).
 */
function queryFTSEpisodes(workDir: string, config: EpisodicMemoryConfig, query: string): EpisodeFTSRecord[] {
  if (!ftsEnabled(config)) return [];
  const dbPath = resolveFTSPath(workDir, config);
  let store: EpisodeFTSStore | null = null;
  try {
    store = new EpisodeFTSStore(dbPath);
    return store.searchEpisodesFTS(query, config.max_episodes);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

/**
 * Adapt an `EpisodeFTSRecord` into the `EpisodeContext` shape expected by
 * `formatEpisodes` / `formatFailedEpisodes`. Maps `outcome` to the EpisodeContext
 * union (`success` | `partial` | `failure`) using the same convention as
 * `buildEpisodeRecord`. Score is a synthetic constant so all FTS hits sort
 * after each other purely by insertion order (which is BM25 order from the
 * store).
 */
function ftsRecordToContext(r: EpisodeFTSRecord): EpisodeContext {
  let outcome: EpisodeContext['outcome'];
  switch (r.outcome) {
    case 'pr_created':
      outcome = 'success';
      break;
    case 'failed':
      outcome = 'failure';
      break;
    case 'skipped':
      outcome = 'partial';
      break;
    case 'success':
    case 'partial':
    case 'failure':
      outcome = r.outcome;
      break;
    default:
      outcome = 'partial';
  }
  return {
    issue_number: r.issue_number,
    issue_title: r.issue_title,
    approach: r.approach,
    outcome,
    learnings: r.learnings ?? '',
    score: 1,
    repo: r.repo,
  };
}

/**
 * Mirror an `EpisodeRecord` into the FTS5 index. Best-effort: open/write
 * failures are logged and swallowed so they never break the existing
 * REST-based recordEpisode path.
 */
function upsertEpisodeFTS(
  workDir: string,
  config: EpisodicMemoryConfig,
  episode: EpisodeRecord,
  logger: { warn: (msg: string) => void },
): void {
  if (!ftsEnabled(config)) return;
  const dbPath = resolveFTSPath(workDir, config);
  let store: EpisodeFTSStore | null = null;
  try {
    store = new EpisodeFTSStore(dbPath);
    store.upsertEpisode({
      issue_number: episode.issue_number,
      repo: episode.repo,
      issue_title: episode.issue_title,
      approach: episode.approach,
      files_changed: episode.files_changed,
      outcome: episode.outcome,
      timestamp: episode.timestamp,
      ...(episode.learnings != null && { learnings: episode.learnings }),
      ...(episode.error_message != null && { error_message: episode.error_message }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[episode-fts] Failed to upsert episode: ${msg}`);
  } finally {
    store?.close();
  }
}

/* ================================================================== */
/*  Pattern aggregation (#267) — helpers                               */
/* ================================================================== */

/**
 * Resolve the on-disk path for the local pattern aggregation DB. Defaults to
 * `{workDir}/.kova/patterns.db` — co-located with the FTS index for cleanup.
 */
function resolvePatternStorePath(workDir: string): string {
  return joinPath(workDir, '.kova', 'patterns.db');
}

/**
 * Open the local PatternStore, run `queryTopPatterns(repo)`, return the rows.
 * Best-effort: any open/query failure returns []. Absent DB is the normal
 * first-run state and produces a silent empty result.
 */
function queryPatternContext(
  workDir: string,
  config: EpisodicMemoryConfig,
  repo: string,
): import('../services/pattern-store.js').PatternRecord[] {
  if (!config.enabled) return [];
  let store: PatternStore | null = null;
  try {
    store = new PatternStore(resolvePatternStorePath(workDir));
    return store.queryTopPatterns(repo, { limit: config.max_episodes });
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

/**
 * Aggregate the completed episode into the pattern store. Best-effort: open or
 * upsert failures are logged and swallowed so they never break the existing
 * recordEpisode path.
 */
function upsertEpisodePattern(
  workDir: string,
  config: EpisodicMemoryConfig,
  episode: EpisodeRecord,
  logger: { warn: (msg: string) => void },
): void {
  if (!config.enabled) return;
  let store: PatternStore | null = null;
  try {
    store = new PatternStore(resolvePatternStorePath(workDir));
    upsertPatternFromEpisode(store, episode);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[pattern-store] Failed to upsert pattern: ${msg}`);
  } finally {
    store?.close();
  }
}
