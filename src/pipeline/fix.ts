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

import { z } from 'zod';
import {
  initCodegraph,
  isCodegraphOnPath,
  probeCodegraphStatus,
  shouldWithholdCodegraphTools,
} from '../ai/codegraph.js';
import {
  type AgentRuntimeFactory,
  type FixAIWaveName,
  isConsensusPool,
  type MCPServerHandle,
  type OutputFormat,
  type RuntimeKind,
  resolveMCPServers,
  startAllMCPServers,
  stopAllMCPServers,
} from '../ai/index.js';
// Sandbox lifecycle (start + cleanup) moved to ./sandbox-lifecycle.ts (#435).
import { selectVariants, type VariantSelection } from '../services/ab-test.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '../services/checkpoint.js';
// codegraph + conflict-check helpers moved to ./codegraph-checks.ts (#435)
import { type EventBus, getDefaultEventBus } from '../services/event-bus/index.js';
import { collectPRFeedback } from '../services/feedback-collector.js';
// getCurrentHeadSha moved into ./wave-runners.ts (#435)
import { commentOnIssue } from '../services/github.js';
import { readHistory } from '../services/history.js';
import { validateIsolation } from '../services/isolation.js';
import { detectTooling } from '../services/language-detect.js';
import { defaultLiveFixRegistry } from '../services/live-fix-registry.js';
import { buildEpisodeRecord, recordEpisode } from '../services/memory/episode-rest.js';
// review-feedback-rest imports moved to ./wave-runners.ts (#435)
import * as metrics from '../services/metrics.js';
// pattern-store helpers moved to ./episodic-mirror.ts (#435)
import { applyScopeToState, detectScope, formatScopeLogLine } from '../services/pipeline-scope.js';
import { ensureScreenshotsDir, isPlaywrightEnabled, resolvePlaywrightEnv } from '../services/playwright.js';
import { formatPRContext, type OpenPR } from '../services/pr-context.js';
import { ProgressTracker } from '../services/progress.js';
import { type ABTestVariantStats, correlateByABTestVariant } from '../services/prompt-correlation.js';
// prompt-versions imports moved into ./context-builder.ts (#435)
// repo-intel imports moved to ./wave-runners.ts (#435)
// run-registry imports moved into ./lifecycle.ts (#435)
import { shutdownRequested } from '../services/shutdown.js';
import {
  createWorktree,
  worktreePath as getWorktreePath,
  removeWorktree,
  worktreeExists,
} from '../services/worktree.js';
import type {
  FixState,
  Issue,
  PipelineMode,
  RepoConfig,
  SpecResult,
  WaveName,
  WaveSingleModelConfig,
} from '../types/index.js';
import {
  type AssessResult,
  AssessResultSchema,
  loadAllHandoffs,
  loadHandoff,
  SpecResultSchema,
  saveHandoff,
} from '../types/index.js';
import { closeFileLogger, initFileLogger, type Logger, log } from '../utils/logger.js';
import { probeDependencyOverlap } from './codegraph-checks.js';
import { applyConsensusToConfig, formatConsensusActivationLog } from './consensus-flags.js';
import type { FixRunSkills } from './context-builder.js';
import { upsertEpisodeFTS, upsertEpisodePattern } from './episodic-mirror.js';
import { emitHistoryEntry } from './history-emit.js';
import { setupFixLifecycle } from './lifecycle.js';
import { handoffToResult, waveProvider } from './result.js';
import { cleanupSandbox, initSandboxLifecycle, startSandbox } from './sandbox-lifecycle.js';
import { createInitialState, extractOwnerRepo, formatSkipComment } from './state-helpers.js';
import { runQualityWave, runReviewWave, runShipWave, runTIWave } from './wave-runners.js';

// Re-export helpers from extracted modules for back-compat with test files
// that imported these from './fix.js' before the strip (issues #242, #262, #435).
export { handoffToResult, waveFallbackModel } from './result.js';

import {
  type ContextProviderInput,
  gatherContext,
  POST_ASSESS_CONTEXT_PROVIDERS,
  PRE_ASSESS_CONTEXT_PROVIDERS,
} from './context/index.js';
import { buildWaveContext } from './context.js';
// context-refresh moved into ./wave-runners.ts:runTIWave (#435)
import { buildCostReport, printRunSummary, writeCostReport } from './cost-report.js';
import {
  AssessEngine,
  type AssessEngineInput,
  applyEngineStateDelta,
  buildAssessConfigDelta,
  createTIEngine,
  type EngineContext,
  SpecEngine,
  type SpecEngineInput,
  type SpecEnginePendingPR,
} from './engines/index.js';
import type { TestRunner } from './loops.js';
import { loadProjectContext } from './project-context.js';
import { resolvePromptsDir } from './prompts.js';
// regression-surface helper moved to ./codegraph-checks.ts (#435)
import { buildRuntimeFactory, resolveRuntimeKind } from './runtime-select.js';
import { loadWaveSkills } from './skills-loader.js';

// spec-validator's detectDependencyOverlaps moved to ./codegraph-checks.ts (#435)

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

  // Lifecycle (issue #340 + #293): event-bus + run-registry plumbing moved to
  // `./lifecycle.ts`. Resolves the bus (caller-provided or singleton), publishes
  // `fix-started`, registers the on-disk run entry, and returns a `publishFixDone`
  // that mirrors the terminal event + registry status. `fixId === runId` is
  // stable across the lifecycle so subscribers correlate every event on the
  // same identifier.
  const eventBus = options.eventBus ?? getDefaultEventBus();
  const fixId = runId;
  const lifecycle = await setupFixLifecycle({
    eventBus,
    repoPath,
    repoName,
    runId,
    fixId,
    issueNumber: issue.number,
    logger: flog,
  });
  const publishFixDone = lifecycle.publishFixDone;

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
  // touching pipeline code. Start logic delegated to `./sandbox-lifecycle.ts:startSandbox` (#435).
  const sandboxLifecycle = { ...initSandboxLifecycle() };
  if (config.isolation === 'docker') {
    const startResult = await startSandbox({ issue, repoName, workDir, config, logger: flog });
    if (startResult.status === 'failed') {
      const state = createInitialState(issue, repoName, repoPath);
      state.status = 'failed';
      state.error = startResult.error;
      metrics.recordIssueFailed();
      metrics.recordFixDuration(Date.now() - fixStartTime);
      metrics.recordFixCost(0);
      _activeFixes--;
      metrics.setActiveFixes(_activeFixes);
      return { success: false, error: startResult.error, state };
    }
    Object.assign(sandboxLifecycle, startResult.state);
  }
  const sandboxContext = sandboxLifecycle.context;

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

  // Track prompt hashes across waves for history correlation (issue #432).
  // Derived from each `EngineResult.promptHash` via `setPromptHash`; the
  // helper drops empty strings so engines that don't emit a per-call hash
  // (TIEngine, QualityEngine, ReviewEngine wrap multi-call loops) don't
  // clobber the slot.
  const promptHashes: Record<string, string> = {};
  const setPromptHash = (wave: string, hash: string | undefined): void => {
    if (hash != null && hash !== '') promptHashes[wave] = hash;
  };

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
        // Issue #432 — surface options.mode to the engine so it can pre-resolve
        // the pipeline mode and return a configDelta. When undefined the engine
        // auto-selects from the assess artifact's grade + surface area.
        ...(options.mode != null && { explicitMode: options.mode }),
      };
      const assessCtx = buildEngineContext({
        ...(abTestVariants?.assess != null && { abTestVariant: abTestVariants.assess }),
      });
      const assessResult = await AssessEngine.run(assessCtx, assessInput);
      const { handoff, promptHash, configDelta, stateDelta: assessStateDelta } = assessResult;
      await saveHandoff(workDir, handoff);
      setPromptHash('assess', promptHash);
      state.waveResults.assess = handoffToResult(handoff, waveProvider(config, 'assess'), promptHash);
      // Issue #432 — apply stateDelta + configDelta in the single application
      // point. configDelta carries the pipeline-mode-applied RepoConfig so
      // `config` is rebound exactly once here (replaces the inline
      // applyPipelineMode call that used to live at fix.ts:1146).
      state = applyEngineStateDelta(state, assessStateDelta);
      if (configDelta?.config != null) {
        config = configDelta.config;
      }
      if (configDelta?.resolvedMode != null) {
        resolvedMode = configDelta.resolvedMode;
      }
      if (configDelta?.extraImplAttempts != null) {
        extraImplAttempts = configDelta.extraImplAttempts;
      }
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

    // Pipeline mode fallback (issue #432). The AssessEngine handles the normal
    // resolution path via `configDelta` (applied above when WAVE A runs); this
    // branch only fires when WAVE A is skipped (REVIEW_ONLY pipeline scope or
    // a checkpoint resume past assess) AND no explicit `--mode` was passed.
    // Falls back to `standard` for the same reason as the engine's "no
    // artifact" branch: never economize when we can't see surface area.
    if (resolvedMode == null) {
      const assessArtifact = state.waveResults.assess?.artifact as AssessResult | undefined;
      const fallback = buildAssessConfigDelta(config, assessArtifact, undefined);
      if (fallback?.config != null) {
        config = fallback.config;
      }
      if (fallback?.resolvedMode != null) {
        resolvedMode = fallback.resolvedMode;
      }
      if (fallback?.extraImplAttempts != null) {
        extraImplAttempts = fallback.extraImplAttempts;
      }
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
      setPromptHash('spec', specResult.promptHash);
      state.waveResults.spec = handoffToResult(specResult.handoff, waveProvider(config, 'spec'), specResult.promptHash);
      state.completedWaves.push('spec');
      // Engine surfaces serialFallback as a control-flow flag (not FixState).
      // mergeDependencies flows through stateDelta — applied by the loop's
      // single application point (issue #432).
      if (specResult.serialFallback) serialFallback = true;
      state = applyEngineStateDelta(state, specResult.stateDelta);
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('spec', state);
      metrics.recordWaveCompleted('spec');
      metrics.recordWaveDuration('spec', Date.now() - waveStart);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Codegraph dependency-overlap gate (issue #276). Even when piece file
    // sets are disjoint, the graph may reveal cross-piece call/import edges
    // that force serial execution. Delegated to `./codegraph-checks.ts`.
    const specArtifactPostEngine = state.waveResults.spec?.artifact as SpecResult | undefined;
    if (specArtifactPostEngine?.pieces && !serialFallback) {
      if (probeDependencyOverlap({ pieces: specArtifactPostEngine.pieces, repoPath, logger: log })) {
        serialFallback = true;
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
        setPromptHash('spec', emptyRetryResult.promptHash);
        state.waveResults.spec = handoffToResult(
          emptyRetryResult.handoff,
          waveProvider(config, 'spec'),
          emptyRetryResult.promptHash,
        );
        state = applyEngineStateDelta(state, emptyRetryResult.stateDelta);
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

    // WAVE T + I: delegated to `./wave-runners.ts:runTIWave` (#435). Encapsulates
    // pre-impl SHA capture (#277), TIEngine dispatch, handoff persistence,
    // post-impl codebaseContext refresh, and the shouldRespec escalation.
    if (!(shouldSkip('test') && shouldSkip('impl'))) {
      const tiOutcome = await runTIWave({
        issue,
        state,
        config,
        workDir,
        prContext,
        codebaseContext,
        codegraphContext,
        callPathContext,
        failedEpisodicContext,
        repoSearchText,
        testRunner,
        serialFallback,
        skipTestPhase,
        skipImplPhase,
        extraImplAttempts,
        pendingPRFileList,
        tiEngine,
        specCtxBase,
        buildEngineContext,
        progress,
        setPromptHash,
        logger: flog,
      });
      state = tiOutcome.state;
      codebaseContext = tiOutcome.codebaseContext;

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE Q: Quality — delegated to `./wave-runners.ts:runQualityWave` (#435).
    // Encapsulates repo-intel project-standards query, initial quality dispatch,
    // QualityEngine self-healing retry, and metrics/checkpoint persistence.
    if (!shouldSkip('quality')) {
      state = await runQualityWave({
        issue,
        state,
        config,
        workDir,
        repoPath,
        ownerRepo,
        testRunner,
        mcpHandles,
        resolvedPromptsDir,
        projectContext,
        abTestVariants,
        sandboxContext,
        runSkills,
        cacheContext,
        eventContext: eventDispatchContext,
        resolvedRuntimeFactory,
        resolvedMcpServers,
        liveFixRegistry: defaultLiveFixRegistry,
        buildEngineContext,
        progress,
        setPromptHash,
        logger: flog,
      });
      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE R: Review — delegated to `./wave-runners.ts:runReviewWave` (#435).
    if (!shouldSkip('review')) {
      state = await runReviewWave({
        issue,
        state,
        config,
        repoName,
        workDir,
        repoPath,
        prContext,
        testRunner,
        codegraphAvailable,
        codegraphWithholdList,
        buildEngineContext,
        progress,
        logger: flog,
      });
      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Ship — no AI wave, just git operations. Delegated to ShipEngine (#357).
    // ShipEngine owns the conflict-check → non-overlapping autoresolve →
    // overlapping retry → rebase → secrets scan → commit → push → PR sequence.
    // Orchestrator owns: codegraph-aware dependency-overlap WARNING (#276 pre-
    // ship pre-flight), metrics emission, state persistence, and the no-changes
    // early-exit path.
    if (!shouldSkip('ship')) {
      const shipOutcome = await runShipWave({
        issue,
        state,
        config,
        workDir,
        repoPath,
        worktreeBranch: worktree?.branch,
        prContext,
        codebaseContext,
        codegraphContext,
        callPathContext,
        testRunner,
        skipTestPhase,
        skipImplPhase,
        extraImplAttempts,
        tiEngine,
        buildEngineContext,
        progress,
        logger: flog,
      });
      if (shipOutcome.kind === 'early_return') return shipOutcome.result;
      state = shipOutcome.updatedState;
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
    if (!lifecycle.hasPublishedFixDone()) {
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
    // Sandbox cleanup: collect stats + stop the backend (delegated to
    // `./sandbox-lifecycle.ts`). Docker path preserves its legacy direct
    // killContainer call; non-docker backends route through SandboxBackend.
    if (sandboxLifecycle.containerId) {
      await cleanupSandbox({
        containerId: sandboxLifecycle.containerId,
        containerName: sandboxLifecycle.containerName,
        backend: sandboxLifecycle.backend,
        startTime: sandboxLifecycle.startTime,
        timeoutHandle: sandboxLifecycle.timeoutHandle,
        timedOut: sandboxLifecycle.timedOut,
        config,
        state,
        logger: flog,
      });
    }

    const costReport = buildCostReport(state);
    printRunSummary(costReport);
    await writeCostReport(workDir, costReport).catch((err) => {
      flog.warn(`Failed to write cost report: ${err instanceof Error ? err.message : String(err)}`);
    });

    // History entry — full per-run causal telemetry aggregation delegated to
    // `./history-emit.ts` (#247, #266, #278).
    await emitHistoryEntry({ state, issue, repoName, repoPath, config, costReport, promptHashes, abTestVariants });

    // Episodic memory: record fix outcome (success or failure)
    if (config.episodes?.enabled) {
      const episode = buildEpisodeRecord(state);
      const recordTooling = await detectTooling(workDir).catch(() => ({ language: 'unknown' as const }));
      if (recordTooling.language !== 'unknown') {
        episode.language = recordTooling.language;
      }
      await recordEpisode(config.episodes, episode, workDir).catch((err) => {
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
        collectPRFeedback({ episodesConfig: config.episodes, repoName, prNumber, repoPath: workDir, workDir }).catch(
          (err) => {
            flog.warn(`Failed to collect PR feedback: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
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
