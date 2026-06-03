// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship.
//
// Issue #357: every wave delegates to a per-wave engine in `./engines/`
// (AssessEngine, SpecEngine, createTIEngine, createQualityEngine,
// createReviewEngine, createShipEngine). The orchestrator owns checkpoints,
// metrics, lifecycle events, run-registry mirroring, episodic/codegraph/MCP
// plumbing, mode resolution, and the pipeline scope gates. The engines own
// wave dispatch + per-wave retry logic. Only WAVE Q's initial quality-wave
// dispatch still uses the local `spawnWave` helper inline — the QualityEngine
// docs flag the initial-dispatch fold as a follow-up.

import { join as joinPath } from 'node:path';
import { z } from 'zod';
import { $ } from 'zx';
import {
  initCodegraph,
  isCodegraphOnPath,
  probeCodegraphStatus,
  shouldWithholdCodegraphTools,
  syncCodegraph,
} from '../ai/codegraph.js';
import {
  type AgentRuntimeFactory,
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
  type RuntimeKind,
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
import { openCodegraph } from '../services/codegraph/index.js';
import { checkForConflicts } from '../services/conflict-check.js';
import { EpisodeFTSStore } from '../services/episode-fts.js';
import { type EventBus, getDefaultEventBus } from '../services/event-bus/index.js';
import { collectPRFeedback } from '../services/feedback-collector.js';
import { getCurrentHeadSha } from '../services/git-diff.js';
import { commentOnIssue } from '../services/github.js';
import { appendHistoryEntry, readHistory } from '../services/history.js';
import { validateIsolation } from '../services/isolation.js';
import { detectTooling } from '../services/language-detect.js';
import { buildLiveHandleSink, defaultLiveFixRegistry, type LiveFixRegistry } from '../services/live-fix-registry.js';
import * as metrics from '../services/metrics.js';
import { PatternStore, upsertPatternFromEpisode } from '../services/pattern-store.js';
import { applyScopeToState, detectScope, formatScopeLogLine } from '../services/pipeline-scope.js';
import { ensureScreenshotsDir, isPlaywrightEnabled, resolvePlaywrightEnv } from '../services/playwright.js';
import { formatPRContext, type OpenPR } from '../services/pr-context.js';
import { ProgressTracker } from '../services/progress.js';
import { loadProjectContext, type ProjectContext } from '../services/project-context.js';
import { type ABTestVariantStats, correlateByABTestVariant } from '../services/prompt-correlation.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../services/prompt-versions.js';
import { formatRepoStandards, queryRepoStandards } from '../services/repo-intel.js';
import { registerRun, updateRun } from '../services/run-registry.js';
import {
  buildSandboxImage,
  DEFAULT_SANDBOX_LIMITS,
  getContainerStats,
  killContainer,
  parseTimeout,
  startSandboxContainer,
} from '../services/sandbox.js';
import { shutdownRequested } from '../services/shutdown.js';
import type { EpisodeRecord } from '../services/vectordb.js';
import {
  buildEpisodeRecord,
  formatReviewFeedback,
  queryReviewFeedbackContext,
  recordEpisode,
} from '../services/vectordb.js';
import {
  createWorktree,
  detectDefaultBranch,
  getChangedFiles,
  worktreePath as getWorktreePath,
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
  WaveSingleModelConfig,
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
import { applyConsensusToConfig, formatConsensusActivationLog } from './consensus-flags.js';
import {
  type ContextProviderInput,
  gatherContext,
  POST_ASSESS_CONTEXT_PROVIDERS,
  PRE_ASSESS_CONTEXT_PROVIDERS,
} from './context/index.js';
import { buildWaveContext } from './context.js';
import { refreshCodebaseContext } from './context-refresh.js';
import { buildCostReport, printRunSummary, writeCostReport } from './cost-report.js';
import {
  AssessEngine,
  type AssessEngineInput,
  createQualityEngine,
  createReviewEngine,
  createShipEngine,
  createTIEngine,
  type EngineContext,
  SpecEngine,
  type SpecEngineInput,
  type SpecEnginePendingPR,
} from './engines/index.js';
import { detectThrashing, type TestRunner } from './loops.js';
import { applyPipelineMode, autoSelectMode, describeAutoSelection, MODE_EXTRA_IMPL_ATTEMPTS } from './mode.js';
import { loadPrompt, resolvePromptsDir } from './prompts.js';
import { formatRegressionSurface } from './regression-surface.js';
import { buildRuntimeFactory, resolveRuntimeKind } from './runtime-select.js';
import { loadWaveSkills } from './skills-loader.js';
import { detectDependencyOverlaps } from './spec-validator.js';

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
  /**
   * Optional `EventBus` for run lifecycle + wave observability events
   * (issue #340). When undefined, fix() falls back to `getDefaultEventBus()`
   * so loop.ts callers can share one bus across concurrent fixes without
   * passing it explicitly. The bus is the foundation for #291 (persistent
   * daemon + run registry) and #293 (kova attach client).
   *
   * Pure side-effect: events with no subscribers are no-ops; fix outcome is
   * never altered by the publish path.
   */
  eventBus?: EventBus | undefined;
  /**
   * Per-invocation runtime selector (issue #407). Overrides `config.runtime`.
   * When undefined, falls back to `config.runtime` (default `'pi'`). When
   * `'claude-cli'`, the kova-resolved MCP server map is merged into the
   * claude-cli runtime config so MCP-backed tools work end-to-end under the
   * CLI subprocess. In-process `AgentTool[]` implementations supplied to
   * `spawnWaveAgent` are pi-mono-only — the claude-cli runtime only sees the
   * static allowlist + MCP servers (documented in CLAUDE.md "Runtime
   * selection").
   */
  runtime?: RuntimeKind | undefined;
  /**
   * Consensus-pool members (issue #261). When set together with
   * `consensusWaves`, fix() mutates `config.model[wave]` for each wave to a
   * `WaveConsensusConfig` before validation, routing those waves through
   * `spawnConsensusWave` (multi-model adjudication, ~Nx cost). Caller
   * (typically the CLI layer) resolves the user-supplied `--pool <spec>` into
   * this array via `parsePoolSpec`. Length is constrained to 2-5 by
   * `WaveConsensusConfigSchema`.
   */
  consensusPool?: readonly WaveSingleModelConfig[] | undefined;
  /**
   * Waves to route through the consensus pool when `consensusPool` is set.
   * Defaults to `DEFAULT_CONSENSUS_WAVES` (`['assess', 'spec', 'review']`)
   * when the caller passed `--consensus` without `--consensus-waves`. Caller
   * resolves the user-supplied list via `parseConsensusWavesList`.
   */
  consensusWaves?: readonly FixAIWaveName[] | undefined;
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
  eventContext?: { eventBus: EventBus; runId: string; repoId: string; fixId: string },
  /**
   * Issue #407 — pre-resolved `AgentRuntimeFactory`. When undefined, spawnWaveAgent
   * applies its own `defaultAgentRuntimeFactory` default (pi-mono).  Caller `fix()`
   * resolves precedence (option > config.runtime > 'pi') once and threads the
   * factory into every wave so the runtime choice is consistent across S/T/I/Q/R.
   */
  runtimeFactory?: AgentRuntimeFactory | undefined,
  /**
   * Issue #306 — host-resolved MCP server config map. Forwarded only when
   * `sandbox` is set so dispatch.ts can serialize it across the docker-exec
   * boundary; the runner inside the sandbox starts the same servers locally
   * on `/workspace`. Host-path waves get MCP tools via `mcpHandles` (live
   * connections) and ignore this field — it would be redundant on the host.
   */
  resolvedMcpServers?: Record<string, import('../types/index.js').MCPServerConfig> | undefined,
  /**
   * Issue #294 — optional LiveFixRegistry to register the wave's live agent
   * handle in (keyed by `eventContext.fixId`). When set, `kova send <fixId>`
   * and `kova kill <fixId>` route into the running wave via the daemon's
   * steer/abort RPCs. When unset, the wave runs unchanged — backward-compat.
   * Sandbox path skips registration (agent runs in a remote container).
   */
  liveFixRegistry?: LiveFixRegistry | undefined,
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
  // Issue #306 — when dispatching into a sandbox, the host-side `mcpHandles`
  // live connections cannot cross the container boundary. Instead we forward
  // the resolved MCP server CONFIG map (commands + args + env) so the
  // in-container runner can call `startAllMCPServers` on /workspace itself.
  // Host-path waves use `mcpTools` (already in `tools`) and don't need this.
  const sandboxMcpServers =
    sandbox != null && resolvedMcpServers != null && Object.keys(resolvedMcpServers).length > 0
      ? resolvedMcpServers
      : undefined;
  const sandboxMcpWaveOverrides =
    sandbox != null ? (config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined) : undefined;

  // Issue #294: when a registry + fixId are present AND we're on the host path
  // (no sandbox), build a sink that registers the live handle under the fixId
  // for the duration of this wave. The wrapped handle also publishes
  // `steered` / `aborted` events on the shared bus with `reason: 'manual_*'`
  // so subscribers (kova capture, event ledger) can observe send-keys actions
  // distinct from automatic Tier-1/Tier-3 degradation. We clear the entry
  // from the same closure that registered it so concurrent waves on other
  // fixIds are unaffected. Sandbox path skips registration (the agent runs
  // in a remote container — there is no in-process handle to expose).
  const fixIdForRegistry = eventContext?.fixId;
  const liveHandleSink = buildLiveHandleSink({
    registry: liveFixRegistry,
    fixId: fixIdForRegistry,
    sandboxActive: sandbox != null,
    ...(eventContext != null
      ? { eventBus: eventContext.eventBus, eventContext: { runId: eventContext.runId, repoId: eventContext.repoId } }
      : {}),
    wave,
  });

  try {
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
        // Issue #340: forward eventBus + eventContext so wave-executor's
        // wave-enter / wave-output / cost / aborted events share the same
        // runId/fixId tags as the fix() lifecycle events. Subscribers can
        // correlate the full lifecycle on a single fixId.
        ...(eventContext != null
          ? {
              eventBus: eventContext.eventBus,
              eventContext: { runId: eventContext.runId, repoId: eventContext.repoId, fixId: eventContext.fixId },
            }
          : {}),
        ...(runtimeFactory != null ? { runtimeFactory } : {}),
        // Issue #306 — sandbox-only MCP plumbing; host path ignores these fields.
        ...(sandboxMcpServers != null ? { mcpServers: sandboxMcpServers } : {}),
        ...(sandboxMcpWaveOverrides != null ? { mcpWaveOverrides: sandboxMcpWaveOverrides } : {}),
        // Issue #294 — host-path only; sandbox is excluded above.
        ...(liveHandleSink != null ? { liveHandleSink } : {}),
      },
      sandbox,
    );
    return { handoff, promptHash };
  } finally {
    // Issue #294: clear the live handle for this fixId so a subsequent
    // `kova send <fixId>` between waves (or after the fix completes) returns
    // a clear "not running" error instead of routing into a stale agent.
    if (liveFixRegistry != null && fixIdForRegistry != null) {
      liveFixRegistry.clear(fixIdForRegistry);
    }
  }
}

/** Convert a WaveHandoff to WaveResult for checkpoint/cost-report compatibility.
 *
 *  Exported for unit testing the consensus-telemetry propagation contract
 *  (#262). Callers within this module use it directly.
 *
 *  When the handoff carries a `consensus` property (only emitted by
 *  `spawnConsensusWave`), project it into `WaveResult.consensus` so the
 *  multi-model telemetry survives the WaveResult round-trip. Single-model
 *  handoffs leave `WaveResult.consensus` undefined — existing consumers are
 *  unaffected. */
export function handoffToResult(handoff: WaveHandoff, provider?: string, promptHash?: string): WaveResult {
  const result: WaveResult = {
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
  // Structural check: ConsensusWaveHandoff extends WaveHandoff with a
  // `consensus` member of shape `ConsensusMetadata`. We project the relevant
  // fields onto the flattened `WaveResultConsensus` telemetry shape — pool
  // becomes the list of pool model ids in input order, rejected_count is
  // recomputed (not stored on ConsensusMetadata directly; see #262 spec).
  const consensus = (handoff as unknown as { consensus?: import('../ai/parallel-executor.js').ConsensusMetadata })
    .consensus;
  if (consensus != null) {
    result.consensus = {
      pool: consensus.pool_results.map((r) => r.model),
      adjudicator: consensus.adjudicator_model,
      agreement: consensus.agreement,
      // `rejected_count` is reported via the disagreement log record in
      // `spawnConsensusWave` (which has access to the artifacts). At this
      // mapping layer we don't have the raw artifacts anymore — but we DO
      // know the answer when the handoff itself was produced by a consensus
      // wave: the count is computed below the handoff layer. For now, default
      // to 0 here; pipeline call sites that own the disagreement log can
      // overwrite `result.consensus.rejected_count` when they construct the
      // WaveResult. See the WaveResultConsensus jsdoc on config.ts.
      rejected_count: 0,
      degraded: consensus.degraded,
    };
  }
  return result;
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
  // Issue #261 — defense-in-depth: when callers invoke fix() programmatically
  // (skipping the CLI) and pass `consensusPool` + `consensusWaves` instead of a
  // pre-mutated config, apply the same `applyConsensusToConfig` mutation the
  // CLI does so consensus-aware engines see the pool wave configs. The CLI
  // pre-mutates the config it passes here, so this branch is a no-op for the
  // normal CLI path — it only fires when a programmatic caller wants the
  // option-shape ergonomics without doing the mutation themselves.
  if (options.consensusPool != null && options.consensusWaves != null && options.consensusWaves.length > 0) {
    // Skip if the requested waves are already pools — caller already mutated.
    const alreadyApplied = options.consensusWaves.every((w) => isConsensusPool(config.model[w]));
    if (!alreadyApplied) {
      config = applyConsensusToConfig(config, {
        pool: options.consensusPool,
        waves: options.consensusWaves,
      });
      log.info(formatConsensusActivationLog({ pool: options.consensusPool, waves: options.consensusWaves }));
    }
  }
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

  // Event bus (issue #340): resolve to the caller-provided bus, else the
  // process-singleton. `fixId` is stable across the lifecycle so subscribers
  // can correlate `fix-started` → wave events → `fix-done` on the same
  // identifier. `runId` doubles as the bus-level run id; loop.ts callers
  // who share a bus across concurrent fixes get one event stream tagged by
  // `fixId`. `publishedFixDone` guards against the finally block double-
  // publishing the terminal event when an early return path already emitted.
  const eventBus = options.eventBus ?? getDefaultEventBus();
  const fixId = runId;
  let publishedFixDone = false;

  // Issue #293: register this fix in the on-disk RunRegistry and mirror
  // wave-enter / fix-done into it so `kova ls` and `kova attach` can discover
  // and follow the run. Registry writes are fire-and-forget (best-effort, log
  // on failure) — a registry-disk problem must never alter fix outcomes.
  const registerRunSafe = (run: Parameters<typeof registerRun>[1]): Promise<void> =>
    registerRun(repoPath, run).catch((err) => {
      flog.warn(`[run-registry] registerRun failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  const updateRunSafe = (patch: Parameters<typeof updateRun>[2]): Promise<void> =>
    updateRun(repoPath, runId, patch).catch((err) => {
      flog.warn(`[run-registry] updateRun failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  // Subscribe to wave-enter events on this fixId to write the currentWave
  // field as the pipeline advances. Subscription is per-fixId, so other
  // concurrent fixes on the same bus do not bleed into this run's registry
  // entry. The unsubscribe is invoked from publishFixDone() so the bus does
  // not retain a listener after the run terminates.
  const unsubscribeWaveEnter = eventBus.subscribeForFix(fixId, (event) => {
    if (event.type === 'wave-enter') {
      void updateRunSafe({ currentWave: event.wave });
    }
  });

  const publishFixDone = async (
    outcome: 'done' | 'failed' | 'done_with_known_issues',
    extras: { totalCostUsd: number; prNumber?: number; reason?: string },
  ): Promise<void> => {
    if (publishedFixDone) return;
    publishedFixDone = true;
    try {
      eventBus.publish({
        type: 'fix-done',
        runId,
        repoId: repoName,
        fixId,
        outcome,
        totalCostUsd: extras.totalCostUsd,
        ...(extras.prNumber != null ? { prNumber: extras.prNumber } : {}),
        ...(extras.reason != null ? { reason: extras.reason } : {}),
      });
    } catch (err) {
      // Pure side-effect: a misbehaving bus must never alter fix outcomes.
      flog.warn(`[event-bus] fix-done publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Issue #293: mirror terminal status into the on-disk registry BEFORE
    // returning so callers (and tests) observing the registry after fix()
    // resolves see the terminal status, not the prior 'running'. We map
    // 'done_with_known_issues' to 'done' — the registry's status field is
    // the binary "is this still active?" signal that `kova ls` needs;
    // outcome detail lives in the event stream.
    const registryStatus = outcome === 'failed' ? 'failed' : 'done';
    await updateRunSafe({
      status: registryStatus,
      completedAt: new Date().toISOString(),
      ...(extras.prNumber != null ? { prNumber: extras.prNumber } : {}),
    });
    unsubscribeWaveEnter();
  };

  try {
    eventBus.publish({
      type: 'fix-started',
      runId,
      repoId: repoName,
      fixId,
      issueNumber: issue.number,
    });
  } catch (err) {
    flog.warn(`[event-bus] fix-started publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Issue #293: register the run AFTER fix-started publishes so the on-disk
  // entry is created exactly once per run lifecycle.
  await registerRunSafe({
    runId,
    fixId,
    repoId: repoName,
    issueNumber: issue.number,
    startedAt: new Date().toISOString(),
    status: 'running',
  });

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
    await publishFixDone('failed', { totalCostUsd: 0, reason: errorMsg });
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

  // Issue #340: shared eventContext threaded into every spawnWave call so all
  // wave-level events the wave-executor emits (wave-enter, wave-output, cost,
  // aborted, steered) share the runId/repoId/fixId tags with the fix-started /
  // fix-done lifecycle events. Subscribers can correlate every event in this
  // fix on the same fixId.
  const eventDispatchContext: { eventBus: EventBus; runId: string; repoId: string; fixId: string } = {
    eventBus,
    runId,
    repoId: repoName,
    fixId,
  };

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

  // Issue #271 — codegraph init+probe gate.
  //
  // The external `codegraph` CLI (consumed via stdio MCP as `codegraph serve --mcp`)
  // only returns useful results after `codegraph init <workDir> --index`. A fresh
  // worktree has no index, so without this gate the MCP server answers empty-but-
  // successfully and the agent silently gets no graph. Sequence:
  //   1. probe `command -v codegraph` (skip everything if not installed — pipeline unchanged)
  //   2. run `codegraph init <workDir> --index` best-effort
  //   3. probe status; if uninitialized OR zero nodes -> withhold codegraph from MCP startup
  //   4. log warning exactly once on the withhold path
  // `syncCodegraph` runs between WAVE I and WAVE R (further down).
  const codegraphWithholdList: string[] = [];
  let codegraphAvailable = false;
  try {
    codegraphAvailable = await isCodegraphOnPath();
    if (codegraphAvailable) {
      const initResult = await initCodegraph(workDir);
      if (!initResult.ok) {
        flog.warn(`[codegraph] init failed (${initResult.reason}) — proceeding; status probe may still pass`);
      }
      const probe = await probeCodegraphStatus(workDir);
      if (shouldWithholdCodegraphTools(probe)) {
        flog.warn(
          `[codegraph] withholding tools — index empty/uninitialized (initialized=${probe.initialized}, nodes=${probe.nodeCount}${probe.reason ? `, reason=${probe.reason}` : ''})`,
        );
        codegraphWithholdList.push('codegraph');
      } else {
        flog.info(`[codegraph] index ready — ${probe.nodeCount} nodes`);
      }
    }
  } catch (err) {
    // Defensive: any unexpected failure means treat codegraph as unavailable.
    flog.warn(`[codegraph] gate threw — treating as unavailable: ${err instanceof Error ? err.message : String(err)}`);
    codegraphWithholdList.push('codegraph');
  }

  // MCP server startup: resolve config and start servers for tool augmentation.
  // workDir threads through so per-fix path-sensitive servers (codegraph,
  // language servers) point at the worktree, not the orchestrator's cwd
  // (issue #270). `codegraphWithholdList` suppresses the codegraph server entry
  // when its index is empty/uninitialized (issue #271).
  let mcpHandles = new Map<string, MCPServerHandle>();
  let resolvedMcpServers: Record<string, import('../types/index.js').MCPServerConfig> = {};
  try {
    resolvedMcpServers = await resolveMCPServers(config.mcp);
    if (Object.keys(resolvedMcpServers).length > 0) {
      mcpHandles = await startAllMCPServers(resolvedMcpServers, workDir, codegraphWithholdList);
      flog.info(`[mcp] ${mcpHandles.size} MCP server(s) running (cwd=${workDir})`);
    }
  } catch (error) {
    flog.warn(`[mcp] Failed to start MCP servers: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Issue #407 — runtime selection. Resolve precedence (option > config.runtime
  // > 'pi') ONCE here and build the factory; thread it through every
  // spawnWave() call so the runtime choice is consistent across S/T/I/Q/R.
  // For the claude-cli path we merge the kova-resolved MCP map into the
  // factory wrapper so MCP-backed tools work end-to-end under the CLI
  // subprocess. The pi path ignores `resolvedMcpServers` — pi-mono consumes
  // live `MCPServerHandle` objects via the tools array, not a static map.
  const resolvedRuntimeKindRaw = options.runtime ?? config.runtime;
  const resolvedRuntimeFactory: AgentRuntimeFactory | undefined =
    resolvedRuntimeKindRaw != null
      ? buildRuntimeFactory(resolveRuntimeKind(options.runtime, config.runtime), resolvedMcpServers)
      : undefined;
  if (resolvedRuntimeKindRaw != null) {
    flog.info(`[runtime] Using ${resolveRuntimeKind(options.runtime, config.runtime)} runtime`);
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

    // Issue #357 — engine instances. Engines are stateless factories; reuse
    // across the run so ship's retry-TI callback can dispatch into the same
    // engine the WAVE T+I block uses.
    const tiEngine = createTIEngine();
    // Issue #357 — engine context builder. Every wave engine receives the same
    // shape: orchestrator-owned fields (workDir, repoPath, config, sandbox,
    // mcpHandles, runtimeFactory, resolvedMcpServers, eventContext) come from
    // the outer fix() closure; wave-specific fields are passed via the engine
    // input. Built as a closure so it sees the latest `config` (mutated post-
    // WAVE A by applyPipelineMode) on every call.
    const buildEngineContext = (overrides: Partial<EngineContext> = {}): EngineContext => ({
      workDir,
      repoPath,
      repoName,
      config,
      ...(sandboxContext != null && { sandbox: sandboxContext }),
      ...(mcpHandles.size > 0 && { mcpHandles }),
      promptsDir: resolvedPromptsDir,
      projectContext,
      runSkills,
      cacheContext,
      ...(playwrightOption != null && { playwright: playwrightOption }),
      ...(resolvedRuntimeFactory != null && { runtimeFactory: resolvedRuntimeFactory }),
      ...(Object.keys(resolvedMcpServers).length > 0 && { resolvedMcpServers }),
      eventContext: eventDispatchContext,
      // Issue #294: thread the process-level LiveFixRegistry into every engine
      // so each wave registers its live agent handle and `kova send <fixId>` /
      // `kova kill <fixId>` route to the currently-running wave.
      liveFixRegistry: defaultLiveFixRegistry,
      ...overrides,
    });
    if (playwrightEnabled) {
      await ensureScreenshotsDir(workDir, config);
      const pwEnv = resolvePlaywrightEnv(config, tooling);
      for (const [key, val] of Object.entries(pwEnv)) {
        process.env[key] = val;
      }
      flog.info(`Playwright MCP enabled — screenshots dir: ${pwEnv.PLAYWRIGHT_SCREENSHOTS_DIR}`);
    }

    // Pre-WAVE-A context providers (issue #431): episodic memory, repo-intel,
    // pattern aggregation. Each is independently testable and gracefully
    // degrades to undefined on error — see `./context/` for per-provider
    // implementations and the gather helper.
    const contextProviderCtx: ContextProviderInput = {
      issue,
      config,
      ownerRepo,
      repoName,
      repoPath,
      workDir,
      language: tooling.language,
      assessResult: undefined,
      logger: flog,
    };
    const preAssessCtx = await gatherContext(PRE_ASSESS_CONTEXT_PROVIDERS, contextProviderCtx);
    const episodicContext = preAssessCtx.episodicContext;
    const failedEpisodicContext = preAssessCtx.failedEpisodicContext;
    const repoContextText = preAssessCtx.repoContextText;
    const patternContext = preAssessCtx.patternContext;

    // WAVE A: Assess — delegated to AssessEngine (issue #357).
    if (!shouldSkip('assess')) {
      const waveStart = Date.now();
      const assessInput: AssessEngineInput = {
        userMessage: buildWaveContext(
          'assess',
          issue,
          {},
          {
            ...(episodicContext != null && { episodicContext }),
            ...(repoContextText != null && { repoContextText }),
            ...(patternContext != null && { patternContext }),
          },
        ),
        outputFormat: toOutputFormat(AssessResultSchema),
      };
      const assessCtx = buildEngineContext({
        ...(abTestVariants?.assess != null && { abTestVariant: abTestVariants.assess }),
      });
      const { handoff, promptHash } = await AssessEngine.run(assessCtx, assessInput);
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

    // Post-WAVE-A context providers (issue #431): vector DB code chunks,
    // codegraph symbol facts, framework-resolved call paths, repo-intel
    // similar-implementation search, playbook synthesis. Order in
    // `POST_ASSESS_CONTEXT_PROVIDERS` mirrors the original block; the assess
    // artifact is now visible to providers that need it (call-path).
    const postAssessProviderCtx: ContextProviderInput = {
      ...contextProviderCtx,
      assessResult: state.waveResults.assess?.artifact as AssessResult | undefined,
    };
    const postAssessCtx = await gatherContext(POST_ASSESS_CONTEXT_PROVIDERS, postAssessProviderCtx);
    // `codebaseContext` is reassigned after WAVE I by `refreshCodebaseContext`
    // (issue #277), so it stays `let`. The others are read-only.
    let codebaseContext = postAssessCtx.codebaseContext;
    const codegraphContext = postAssessCtx.codegraphContext;
    const callPathContext = postAssessCtx.callPathContext;
    const repoSearchText = postAssessCtx.repoSearchText;
    const playbookContext = postAssessCtx.playbookContext;

    // WAVE S: Spec — delegated to SpecEngine (issue #357).
    // SpecEngine owns: initial dispatch + piece-to-piece validation (merge in place) +
    // retry on pendingPR conflicts + post-retry validation + serialFallback flag +
    // mergeDependencies. Orchestrator still owns: checkpoints, codegraph dependency-
    // overlap probe, empty-pieces retry (#243), respec-after-TI escalation.
    const pendingPRFileList = (pendingPRs ?? []).flatMap((pr) => pr.files);
    let serialFallback = false;
    const specCtxBase = buildEngineContext({
      ...(abTestVariants?.spec != null && { abTestVariant: abTestVariants.spec }),
    });
    if (!shouldSkip('spec')) {
      const waveStart = Date.now();
      const specInput: SpecEngineInput = {
        userMessage: buildWaveContext('spec', issue, state.waveResults, {
          prContext,
          ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
          ...(playbookContext != null && { playbookContext }),
          ...(codegraphContext != null && { codegraphContext }),
          ...(callPathContext != null && { callPathContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
          ...(patternContext != null && { patternContext }),
        }),
        outputFormat: toOutputFormat(SpecResultSchema),
        pendingPRFiles: pendingPRFileList,
        ...(pendingPRs != null && {
          pendingPRs: pendingPRs.map<SpecEnginePendingPR>((pr) => ({ number: pr.number, files: pr.files })),
        }),
      };
      const specResult = await SpecEngine.run(specCtxBase, specInput);

      await saveHandoff(workDir, specResult.handoff);
      promptHashes.spec = specResult.promptHash;
      state.waveResults.spec = handoffToResult(specResult.handoff, waveProvider(config, 'spec'), specResult.promptHash);
      state.completedWaves.push('spec');
      // Engine surfaces serialFallback / mergeDependencies — orchestrator records them on state.
      if (specResult.serialFallback) serialFallback = true;
      if (specResult.mergeDependencies && specResult.mergeDependencies.length > 0) {
        state.mergeDependencies = [...specResult.mergeDependencies];
      }
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('spec', state);
      metrics.recordWaveCompleted('spec');
      metrics.recordWaveDuration('spec', Date.now() - waveStart);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Codegraph dependency-overlap gate (issue #276) — orchestrator concern,
    // not spec-validation concern. Probes cross-piece call/import edges even
    // when piece file sets are disjoint and forces serial when found.
    const specArtifactPostEngine = state.waveResults.spec?.artifact as SpecResult | undefined;
    if (specArtifactPostEngine?.pieces && specArtifactPostEngine.pieces.length > 0) {
      // Issue #276 — dependency-overlap gate. Even when piece file sets are
      // fully disjoint, the codegraph may reveal cross-piece call/import edges
      // (e.g. piece A defines `exportedFn` in src/a.ts, piece B calls it from
      // src/b.ts). Running both concurrently risks rename/signature collision.
      // We probe the graph and, if any cross-piece edges exist, force serial
      // execution. Graph unavailable -> falls back to file-overlap-only
      // behavior (this block is a no-op).
      if (specArtifactPostEngine.pieces.length > 1 && !serialFallback) {
        try {
          const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
          const cg = openCodegraph(dbPath);
          try {
            const depOverlaps = detectDependencyOverlaps(specArtifactPostEngine.pieces, {
              listFileSymbols: (fp) => cg.listFileSymbols(fp),
              getCallers: (id) => cg.getCallers(id),
            });
            if (depOverlaps.length > 0) {
              const sampleNames = depOverlaps
                .slice(0, 3)
                .map((o) => `${o.sourcePieceName}->${o.dependentPieceName}(${o.symbolName})`)
                .join(', ');
              log.warn(
                `[fix] Dependency-overlap detected (${depOverlaps.length} cross-piece edge(s): ${sampleNames}) — forcing serial execution`,
              );
              serialFallback = true;
            }
          } finally {
            cg.close();
          }
        } catch (err) {
          // Graceful fallback: codegraph missing/unreachable — keep existing
          // file-overlap-only behavior. Logged at debug to avoid noise on the
          // common "no codegraph indexed" path.
          log.debug(`[fix] dependency-overlap probe degraded: ${err instanceof Error ? err.message : String(err)}`);
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
          ...(codegraphContext != null && { codegraphContext }),
          ...(callPathContext != null && { callPathContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
        });

        // Empty-pieces retry uses SpecEngine in pass-through mode (no pendingPR
        // context — the prior validation already handled that). The orchestrator
        // owns this retry path per SpecEngine's docs.
        const emptyRetryResult = await SpecEngine.run(specCtxBase, {
          userMessage: emptyRetryContext,
          outputFormat: toOutputFormat(SpecResultSchema),
          pendingPRFiles: [],
        });

        await saveHandoff(workDir, emptyRetryResult.handoff);
        promptHashes.spec = emptyRetryResult.promptHash;
        state.waveResults.spec = handoffToResult(
          emptyRetryResult.handoff,
          waveProvider(config, 'spec'),
          emptyRetryResult.promptHash,
        );
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

      // Issue #277: capture the pre-impl HEAD SHA so `refreshCodebaseContext`
      // can later list the affected-set via `git diff <sha> HEAD` and
      // incrementally re-embed only those files. Failure to capture (e.g. a
      // shallow worktree mid-rebase) degrades to `null` → refresh becomes a
      // no-op rather than a full-repo reindex.
      let preImplSha: string | null = null;
      try {
        preImplSha = await getCurrentHeadSha(workDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flog.warn(`[context-refresh] Could not capture pre-impl SHA (${msg}) — context refresh will be a no-op`);
      }

      // WAVE T+I — delegated to TIEngine (issue #357). Engine wraps
      // runParallelPieceTILoop and returns the full ParallelPieceTILoopResult
      // as `handoff.artifact`, preserving every field the orchestrator reads.
      const tiCtx = buildEngineContext();
      const tiEngineResult = await tiEngine.run(tiCtx, {
        issue,
        waveResults: state.waveResults,
        ...(prContext != null && { prContext }),
        ...(codebaseContext != null && { codebaseContext }),
        ...(codegraphContext != null && { codegraphContext }),
        ...(callPathContext != null && { callPathContext }),
        ...(testRunner != null && { testRunner }),
        ...(serialFallback && { maxConcurrent: 1 }),
        ...(skipTestPhase && { skipTestPhase: true }),
        ...(skipImplPhase && { skipImplPhase: true }),
        ...(extraImplAttempts > 0 && { extraImplAttempts }),
      });
      const tiResult = tiEngineResult.handoff.artifact;

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

      // Issue #277: refresh codebaseContext to reflect post-impl edits BEFORE
      // any subsequent wave (re-spec / re-impl on shouldRespec, conflict
      // resolution retry, etc) consumes it. No-op when vectordb is disabled,
      // when no source files changed, or when the pre-impl SHA was not
      // captured. Failures degrade to the stale (pre-impl) context — never
      // crash the pipeline.
      codebaseContext = await refreshCodebaseContext({
        config,
        workDir,
        sinceSha: preImplSha,
        issueQuery: `${issue.title}\n\n${issue.body}`,
        currentContext: codebaseContext,
      });

      // Escalation: shouldRespec → re-run spec + TI loop (max 1 re-spec).
      // Both delegated to their engines (issue #357).
      if (!tiResult.testsPassing && tiResult.shouldRespec) {
        flog.info(`[escalation] ${tiResult.diagnosis ?? 'SPEC_WRONG'} — re-running spec then TI loop`);
        const respecContext = `Previous spec led to ${tiResult.diagnosis ?? 'failure'} — the implementation could not pass the tests. Re-examine the requirements and produce a revised spec.`;
        const respecResult = await SpecEngine.run(specCtxBase, {
          userMessage: buildWaveContext('spec', issue, state.waveResults, {
            prContext,
            ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
            ...(codegraphContext != null && { codegraphContext }),
            ...(callPathContext != null && { callPathContext }),
            ...(codebaseContext != null && { codebaseContext }),
            ...(repoSearchText != null && { repoSearchText }),
            escalationHint: respecContext,
          }),
          outputFormat: toOutputFormat(SpecResultSchema),
          pendingPRFiles: pendingPRFileList,
        });
        await saveHandoff(workDir, respecResult.handoff);
        promptHashes.spec = respecResult.promptHash;
        state.waveResults.spec = handoffToResult(
          respecResult.handoff,
          waveProvider(config, 'spec'),
          respecResult.promptHash,
        );

        const respecTI = await tiEngine.run(tiCtx, {
          issue,
          waveResults: state.waveResults,
          ...(prContext != null && { prContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(codegraphContext != null && { codegraphContext }),
          ...(callPathContext != null && { callPathContext }),
          ...(testRunner != null && { testRunner }),
          ...(skipTestPhase && { skipTestPhase: true }),
          ...(skipImplPhase && { skipImplPhase: true }),
          ...(extraImplAttempts > 0 && { extraImplAttempts }),
        });
        const retryTI = respecTI.handoff.artifact;
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

    // WAVE Q: Quality — initial dispatch stays inline (the engine wraps the
    // retry loop only); self-healing retry delegated to QualityEngine (#357).
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
        eventDispatchContext,
        resolvedRuntimeFactory,
        resolvedMcpServers,
        defaultLiveFixRegistry,
      );
      await saveHandoff(workDir, handoff);
      promptHashes.quality = promptHash;
      state.waveResults.quality = handoffToResult(handoff, waveProvider(config, 'quality'), promptHash);
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('quality', state);
      metrics.recordWaveCompleted('quality');
      metrics.recordWaveDuration('quality', Date.now() - waveStart);

      // Quality self-healing: delegated to QualityEngine.
      const qualityEngine = createQualityEngine();
      const qualityRetryEngineResult = await qualityEngine.run(buildEngineContext(), {
        issue,
        waveResults: state.waveResults,
        ...(testRunner != null && { testRunner }),
      });
      const qualityRetry = qualityRetryEngineResult.handoff.artifact;
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
      // Issue #271 — sync the codegraph so impact/callers/callees reflect
      // WAVE-I edits before the review wave consults the graph. Only runs when
      // codegraph is on PATH AND was not withheld for empty index — otherwise
      // there is nothing to sync.
      if (codegraphAvailable && codegraphWithholdList.length === 0) {
        const syncResult = await syncCodegraph(workDir);
        if (!syncResult.ok) {
          flog.warn(`[codegraph] pre-review sync failed (${syncResult.reason}) — review will use stale graph`);
        } else {
          flog.info('[codegraph] pre-review sync complete');
        }
      }

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

      // Issue #276 — compute regression-surface context from the codegraph.
      // For each file changed in the worktree, list dependents (callers +
      // importers) so the reviewer can verify behavioral consistency at each
      // dependent. Graceful: any failure leaves context undefined and the
      // review wave proceeds with the existing inputs.
      let regressionSurfaceContext: string | undefined;
      try {
        const changedFiles = await getChangedFiles(workDir);
        if (changedFiles.length > 0) {
          const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
          const cg = openCodegraph(dbPath);
          try {
            const formatted = formatRegressionSurface({
              lookup: {
                listFileSymbols: (fp) => cg.listFileSymbols(fp),
                getCallers: (id) => cg.getCallers(id),
                getFileDependents: (fp) => cg.getFileDependents(fp),
              },
              changedFiles,
            });
            if (formatted.length > 0) {
              regressionSurfaceContext = formatted;
              flog.info(
                `[regression-surface] injected (${changedFiles.length} changed files, ${formatted.length} chars)`,
              );
            }
          } finally {
            cg.close();
          }
        }
      } catch (err) {
        flog.warn(
          `[regression-surface] degraded — proceeding without surface context: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // WAVE R — delegated to ReviewEngine (issue #357).
      const reviewEngine = createReviewEngine();
      const reviewEngineResult = await reviewEngine.run(buildEngineContext(), {
        issue,
        waveResults: state.waveResults,
        ...(prContext != null && { prContext }),
        ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
        ...(regressionSurfaceContext != null && { regressionSurfaceContext }),
        ...(testRunner != null && { testRunner }),
      });
      const reviewLoopResult = reviewEngineResult.handoff.artifact;

      // Save review handoff — engine emits the same shape as the prior inline
      // construction (model + cost + turns + confidence + iterations notes).
      await saveHandoff(workDir, reviewEngineResult.handoff);

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

    // Ship — no AI wave, just git operations. Delegated to ShipEngine (#357).
    // ShipEngine owns the conflict-check → non-overlapping autoresolve →
    // overlapping retry → rebase → secrets scan → commit → push → PR sequence.
    // Orchestrator owns: codegraph-aware dependency-overlap WARNING (#276 pre-
    // ship pre-flight), metrics emission, state persistence, and the no-changes
    // early-exit path.
    if (!shouldSkip('ship')) {
      const shipStart = Date.now();
      const branch = worktree?.branch ?? `kova/fix-${issue.number}`;

      const specArtifactForShip = state.waveResults.spec?.artifact as SpecResult | undefined;
      const specFiles = specArtifactForShip?.pieces?.flatMap((p) => p.files) ?? [];

      // Codegraph-aware dependency-overlap pre-flight WARNING (#276). Pure
      // observation — does not block the ship. Engine runs its own simpler
      // conflict-check internally; this one logs the cross-file dependent set
      // so reviewers see the impact before merge.
      try {
        const defaultBranch = await detectDefaultBranch(workDir);
        const committedDiff = await $`git -C ${workDir} diff --name-only origin/${defaultBranch}...HEAD`.nothrow();
        const committed = committedDiff.exitCode === 0 ? committedDiff.stdout.trim().split('\n').filter(Boolean) : [];
        const uncommitted = await getChangedFiles(workDir);
        const allChangedFiles = [...new Set([...committed, ...uncommitted])];

        if (allChangedFiles.length > 0) {
          const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
          const cg = openCodegraph(dbPath);
          try {
            const preCheck = await checkForConflicts(workDir, specFiles, {
              dependencyLookup: {
                listFileSymbols: (fp) => cg.listFileSymbols(fp),
                getFileDependents: (fp) => cg.getFileDependents(fp),
              },
              changedFiles: allChangedFiles,
            });
            if (preCheck.dependencyOverlaps.length > 0) {
              const sample = preCheck.dependencyOverlaps
                .slice(0, 3)
                .map((d) => `${d.sourceFile}->${d.dependentFile}`)
                .join(', ');
              flog.warn(
                `[conflict-check] dependency-overlap surfaced (${preCheck.dependencyOverlaps.length} edge(s): ${sample}) — review the dependents before merging`,
              );
            }
          } finally {
            cg.close();
          }
        }
      } catch (err) {
        flog.debug(`[conflict-check] dependency wiring degraded: ${err instanceof Error ? err.message : String(err)}`);
      }

      metrics.recordRebaseAttempt();
      const shipEngine = createShipEngine();
      const shipResult = await shipEngine.run(
        { workDir, repoPath, config },
        {
          issue,
          branch,
          specFiles,
          openPRs: [], // engine fetches via listOpenPRs internally
          ...(state.mergeDependencies &&
            state.mergeDependencies.length > 0 && {
              mergeDependencies: state.mergeDependencies,
            }),
          // FixState.reviewKnownIssues stores findings with a broader string
          // type for category/severity; ShipEngine expects narrowed ReviewFinding
          // enums. The runtime values are the same — the cast preserves them.
          ...(state.reviewKnownIssues &&
            state.reviewKnownIssues.length > 0 && {
              reviewKnownIssues: state.reviewKnownIssues.map(
                (i) =>
                  ({
                    category: i.category,
                    file: i.file,
                    description: i.description,
                    severity: i.severity,
                  }) as import('../types/index.js').ReviewFinding,
              ),
            }),
          retryParallelTILoop: async (retryInput) => {
            // ShipEngine emits this callback when overlapping conflicts are
            // detected. Run the TI engine again with the conflict hint so the
            // impl picks up the upstream files. Conflict counter mirrors the
            // pre-extraction emission path.
            metrics.recordConflictDetected();
            const conflictTIResult = await tiEngine.run(buildEngineContext(), {
              issue,
              waveResults: state.waveResults,
              ...(prContext != null && { prContext }),
              codebaseContext: [codebaseContext, retryInput.codebaseContext].filter(Boolean).join('\n\n'),
              ...(codegraphContext != null && { codegraphContext }),
              ...(callPathContext != null && { callPathContext }),
              ...(testRunner != null && { testRunner }),
              ...(skipTestPhase && { skipTestPhase: true }),
              ...(skipImplPhase && { skipImplPhase: true }),
              ...(extraImplAttempts > 0 && { extraImplAttempts }),
            });
            const retryTI = conflictTIResult.handoff.artifact;
            state.waveResults.test = retryTI.testWaveResult;
            state.waveResults.impl = retryTI.implWaveResult;
            await saveCheckpoint(workDir, state);
            return { testsPassing: retryTI.testsPassing };
          },
        },
      );

      // Map ShipEngine's discriminated-union result back to FixState +
      // metrics. Failure reasons map to the same error strings the inline
      // ship phase used pre-extraction so consumers see no diff.
      if (shipResult.status === 'failed') {
        if (shipResult.reason === 'rebase') metrics.recordConflictFailed();
        state.status = 'failed';
        state.error = shipResult.error;
        await saveCheckpoint(workDir, state);
        metrics.recordIssueFailed();
        return { success: false, error: state.error, state };
      }

      if (shipResult.status === 'no_changes') {
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

      // shipResult.status === 'shipped' — record PR + metrics.
      state.waveResults.ship = {
        wave: 'ship',
        success: true,
        artifact: {
          prUrl: shipResult.prUrl,
          ...(shipResult.commitMessage != null && { commitMessage: shipResult.commitMessage }),
          filesStaged: shipResult.filesStaged,
        },
        duration: 0,
        cost: 0,
        turns: 0,
      };
      state.completedWaves.push('ship');
      state.status = 'completed';
      await saveCheckpoint(workDir, state);
      await progress?.complete(shipResult.prUrl);
      metrics.recordWaveCompleted('ship');
      metrics.recordWaveDuration('ship', Date.now() - shipStart);
      metrics.recordPRCreated();
      metrics.recordIssueFixed();
      flog.info(`Fix complete: ${shipResult.prUrl}`);
      return { success: true, prUrl: shipResult.prUrl, state };
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

    // Lifecycle event: publish fix-done unless an early-return path already
    // emitted it. Outcome maps to the discriminated-union in event-bus/schema.ts:
    //   completed + reviewKnownIssues → done_with_known_issues
    //   completed                     → done
    //   anything else                 → failed
    // The PR number (when present) is parsed from the ship-artifact URL — the
    // same source the history-write path uses below, so the two records can be
    // cross-referenced by subscribers. Issue #340.
    if (!publishedFixDone) {
      const shipArtifactForEvent = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;
      const prUrlForEvent = shipArtifactForEvent?.prUrl;
      const prNumberMatch = prUrlForEvent?.match(/\/pull\/(\d+)/);
      const prNumberForEvent = prNumberMatch?.[1] ? Number.parseInt(prNumberMatch[1], 10) : undefined;
      const outcome: 'done' | 'failed' | 'done_with_known_issues' =
        state.status === 'completed'
          ? state.reviewKnownIssues && state.reviewKnownIssues.length > 0
            ? 'done_with_known_issues'
            : 'done'
          : 'failed';
      await publishFixDone(outcome, {
        totalCostUsd: totalCost,
        ...(prNumberForEvent != null ? { prNumber: prNumberForEvent } : {}),
        ...(state.error != null ? { reason: state.error } : {}),
      });
    }
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
 * Mirror an `EpisodeRecord` into the FTS5 index. Best-effort: open/write
 * failures are logged and swallowed so they never break the existing
 * REST-based recordEpisode path.
 *
 * Note: the search-side `queryFTSEpisodes` + `ftsRecordToContext` helpers
 * moved to `./context/episodic-provider.ts` as part of issue #431; only the
 * write-side mirror remains here in fix.ts.
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
 * Aggregate the completed episode into the pattern store. Best-effort: open or
 * upsert failures are logged and swallowed so they never break the existing
 * recordEpisode path.
 *
 * Note: the search-side `queryPatternContext` helper moved to
 * `./context/pattern-provider.ts` as part of issue #431; only the write-side
 * mirror remains here in fix.ts.
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
