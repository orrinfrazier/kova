// WaveEngine interface — the contract every pipeline phase implements (issue #353).
//
// This module defines the minimal surface that lets the monolithic `fix.ts`
// orchestrator delegate per-wave logic to per-wave engines. The actual engine
// extractions land in dependent issues:
//   #354 — Assess + Spec engines
//   #355 — TI + Quality engines
//   #356 — Review + Ship engines
//
// Keep this interface minimal. Anything that varies wave-to-wave belongs in
// the engine's `run` method; anything common belongs in EngineContext.

import type { Skill } from '@earendil-works/pi-coding-agent';
import type { AgentRuntimeFactory, MCPServerHandle, OutputFormat } from '../../ai/index.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import type { SandboxContext } from '../../sandbox/dispatch.js';
import type { EventBus } from '../../services/event-bus/index.js';
import type { LiveFixRegistry } from '../../services/live-fix-registry.js';
import type { FixState } from '../../types/config.js';
import type { WaveHandoff } from '../../types/handoffs.js';
import type {
  Issue,
  MCPServerConfig,
  PipelineMode,
  RepoConfig,
  ReviewFinding,
  SkillWaveName,
  WaveName,
  WaveResult,
} from '../../types/index.js';
import type { DiffRunner, FileWriter, PrescanRunner, TestRunner } from '../loops.js';
import type { ProjectContext } from '../project-context.js';

/**
 * Cached per-run skills + enabled-wave list — mirrors `FixRunSkills` from `fix.ts`.
 * Engines accept this so they don't re-scan the skill filesystem per wave.
 */
export interface EngineRunSkills {
  skills: readonly Skill[];
  enabledWaves: readonly SkillWaveName[];
}

/**
 * Cache-affinity context (issue #297). Forwarded into provider session-id
 * derivation so prompt cache stays hot across the multi-turn run.
 */
export interface EngineCacheContext {
  repo: string;
  issue: string | number;
}

/**
 * Optional playwright wiring — only relevant to a subset of waves.
 */
export interface EnginePlaywrightConfig {
  enabled: boolean;
}

/**
 * Shared lifecycle/event context (issue #340). Forwarded into wave-executor so
 * wave-enter / wave-output / cost / aborted events share the orchestrator's
 * runId/fixId tags. Engines that touch AI waves accept this via EngineContext
 * so all callers route through the same shape.
 */
export interface EngineEventContext {
  eventBus: EventBus;
  runId: string;
  repoId: string;
  fixId: string;
}

/**
 * Context every wave engine receives. Carries every input `spawnWave` needs
 * today, kept structural (not nominal) so engines stay testable without
 * importing the orchestrator. Required fields are the four every engine needs;
 * everything else is optional so trivial test engines can ignore them.
 */
export interface EngineContext {
  /** Path the engine should run its work in (worktree path or repo path). */
  workDir: string;
  /** The user's repo checkout (distinct from workDir under worktree isolation). */
  repoPath: string;
  /** `owner/repo` slug. */
  repoName: string;
  /** Repo-level configuration (model routing, isolation, rules, sandbox, …). */
  config: RepoConfig;

  /** Sandbox dispatch context — present when running under docker/daytona isolation. */
  sandbox?: SandboxContext | undefined;
  /** MCP server handles for the run, keyed by server name. */
  mcpHandles?: Map<string, MCPServerHandle> | undefined;
  /** Override directory for wave prompt files (defaults to ./prompts under repoPath). */
  promptsDir?: string | undefined;
  /** Project context loaded once per run (CLAUDE.md + conventions). */
  projectContext?: ProjectContext | undefined;
  /** Per-run skills + enabled-wave list (issue #298). */
  runSkills?: EngineRunSkills | undefined;
  /** Cache-affinity context for prompt-cache pinning (issue #297). */
  cacheContext?: EngineCacheContext | undefined;
  /** A/B test variant key, if any. */
  abTestVariant?: string | undefined;
  /** Playwright wiring for waves that need browser tools. */
  playwright?: EnginePlaywrightConfig | undefined;
  /**
   * Issue #407 — pre-resolved `AgentRuntimeFactory`. When undefined,
   * `dispatchSpawnWave` → `spawnWaveAgent` applies its own default (pi-mono).
   * The orchestrator resolves precedence (option > config.runtime > 'pi') once
   * and threads the factory into every engine so the runtime choice stays
   * consistent across S/T/I/Q/R.
   */
  runtimeFactory?: AgentRuntimeFactory | undefined;
  /**
   * Issue #306 — host-resolved MCP server config map. Forwarded only when
   * `sandbox` is set so dispatch.ts can serialize it across the docker-exec
   * boundary; the in-container runner starts the same servers locally on
   * `/workspace`. Host-path waves get MCP tools via `mcpHandles` (live
   * connections) and ignore this field — it would be redundant on the host.
   */
  resolvedMcpServers?: Record<string, MCPServerConfig> | undefined;
  /**
   * Issue #340 — shared event context. When set, engines forward it into
   * `dispatchSpawnWave` so wave-executor lifecycle events share the
   * orchestrator's runId/fixId tags. Subscribers can correlate the full
   * lifecycle on a single fixId.
   */
  eventContext?: EngineEventContext | undefined;
  /**
   * Issue #294 — optional LiveFixRegistry to register the wave's live agent
   * handle in (keyed by `eventContext.fixId`). When set on the host path
   * (no sandbox), `kova send <fixId>` / `kova kill <fixId>` route into the
   * running wave via the daemon's steer/abort RPCs. Sandbox path skips
   * registration (the agent runs in a remote container).
   */
  liveFixRegistry?: LiveFixRegistry | undefined;
}

/**
 * Per-run state changes an engine may surface alongside its handoff (issue #432).
 *
 * The orchestrator merges these into `FixState` in one place after each engine
 * call, so engines never reach into `FixState` directly. Every field is
 * optional — omit a field to signal "no change to this slot".
 *
 * Convention:
 *   - Set scalar fields (`diagnosis`, `thrashingSignal`, `retryAttempts`) to a
 *     value to write it, or omit to leave the prior state untouched. Passing
 *     `undefined` explicitly is treated as "no change" (use omission instead).
 *   - `failedPieces` and `reviewKnownIssues` use REPLACE semantics — the loop
 *     overwrites the FixState slot with whatever the engine returns. Engines
 *     that want to append should include the prior values in the delta.
 *   - `completedWaves` is owned by the orchestrator (it tracks which engine
 *     just ran); engines do NOT surface it.
 */
export interface EngineStateDelta {
  diagnosis?: FixState['diagnosis'];
  thrashingSignal?: FixState['thrashingSignal'];
  retryAttempts?: FixState['retryAttempts'];
  failedPieces?: FixState['failedPieces'];
  reviewKnownIssues?: FixState['reviewKnownIssues'];
  mergeDependencies?: FixState['mergeDependencies'];
}

/**
 * Per-run config changes an engine may surface (issue #432). Today only the
 * AssessEngine uses this — it pre-resolves the pipeline mode and returns the
 * tier-adjusted `config` so the orchestrator does not have to rebind `config`
 * mid-pipeline. The orchestrator applies `config = configDelta.config ?? config`
 * exactly once, in a single deterministic place, after Assess.
 *
 * `resolvedMode` is forwarded so callers can log which mode the engine picked
 * without re-running the auto-selection branch. `extraImplAttempts` is the
 * `MODE_EXTRA_IMPL_ATTEMPTS` lookup result for the resolved mode — surfaced
 * here so the orchestrator does not have to re-derive it.
 */
export interface EngineConfigDelta {
  /** Replacement RepoConfig — the orchestrator rebinds `config` to this. */
  config?: RepoConfig;
  /** Pre-resolved pipeline mode (for logging + downstream behavior). */
  resolvedMode?: PipelineMode;
  /** Extra impl attempts per piece for the resolved mode. */
  extraImplAttempts?: number;
}

/**
 * What every engine returns. Mirrors the shape `spawnWave` returns today so
 * engines drop into the existing orchestrator call sites with no shape change.
 *
 * `stateDelta` (issue #432) lets engines surface FixState changes the loop
 * applies after the call — no engine writes through shared mutable state.
 * `configDelta` (issue #432) is reserved for AssessEngine's pipeline-mode
 * pre-resolution. Both are optional; existing engines continue to compile
 * without setting them.
 */
export interface EngineResult<T> {
  handoff: WaveHandoff<T>;
  promptHash: string;
  stateDelta?: EngineStateDelta;
  configDelta?: EngineConfigDelta;
}

/**
 * The contract for a per-wave engine.
 *
 * `TInput` is the wave-specific input payload (e.g. the user message + episodic
 * context for Assess; the spec document for Test/Impl). `TOutput` is the typed
 * artifact the wave produces (e.g. AssessResult, SpecResult). Generic over both
 * so the type system tracks the input/output coupling across the pipeline.
 */
export interface WaveEngine<TInput, TOutput> {
  /** Which fix AI wave this engine implements. Excludes 'ship' and 'brainstorm'. */
  readonly name: FixAIWaveName;
  /**
   * Run the engine. Throws on unrecoverable engine errors; recoverable failures
   * (retryable provider errors, structured-output parse falls, low confidence)
   * are signalled inside the returned `handoff` per the existing handoff contract.
   */
  run(ctx: EngineContext, input: TInput): Promise<EngineResult<TOutput>>;
}

/**
 * Optional bundle of engine-level knobs callers pass alongside `EngineContext`
 * when invoking an engine. Kept distinct from `EngineContext` so the context
 * stays focused on "what the run needs" while this covers "how the engine
 * should configure its dispatch". Engines that take an OutputFormat receive
 * it here; everything else stays in EngineContext.
 */
export interface EngineConfig {
  /** Structured-output format for the wave's response (Zod-derived). */
  outputFormat?: OutputFormat | undefined;
}

// --- TIEngine input (issue #355) ---
//
// Wave-specific input payload for the TIEngine. The engine merges these with
// orchestrator-owned EngineContext fields (workDir, repoConfig, sandbox,
// projectContext, cacheContext) before delegating to
// `runParallelPieceTILoop`. Fields here mirror the loop's config minus the
// ctx-shaped slots.

export interface TIEngineInput {
  issue: Issue;
  /** Accumulated wave handoffs. Spec result is required for piece fan-out. */
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxConcurrent?: number | undefined;
  testCommand?: string | undefined;
  testRunner?: TestRunner | undefined;
  diffRunner?: DiffRunner | undefined;
  prContext?: string | undefined;
  codebaseContext?: string | undefined;
  /** Issue #273 codegraph-derived context (symbol spans, callers/callees). */
  codegraphContext?: string | undefined;
  /** Issue #275 framework-resolved call paths (route → handler). */
  callPathContext?: string | undefined;
  /** Skip the test-writing wave per piece (pipeline-scope IMPL_ONLY/REFACTOR). */
  skipTestPhase?: boolean | undefined;
  /** Skip the impl wave per piece (pipeline-scope TEST_ONLY). */
  skipImplPhase?: boolean | undefined;
  /** Extra impl attempts per piece (issue #282 explore mode). */
  extraImplAttempts?: number | undefined;
}

// --- QualityEngine input (issue #355) ---

export interface QualityEngineInput {
  issue: Issue;
  /** Accumulated wave handoffs. Quality wave result is required for retry analysis. */
  waveResults: Partial<Record<WaveName, WaveResult>>;
  testRunner?: TestRunner | undefined;
  testCommand?: string | undefined;
}

// --- ReviewEngine input (issue #356) ---
//
// Wave-specific input payload for the ReviewEngine. The engine merges these
// with orchestrator-owned EngineContext fields (workDir, repoConfig, sandbox,
// projectContext, cacheContext, playwright) before delegating to
// `runReviewLoop`. Fields here mirror the loop's config minus the ctx-shaped
// slots.

export interface ReviewEngineInput {
  issue: Issue;
  /** Accumulated wave handoffs. Review reads quality + impl + test results. */
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxIterations?: number | undefined;
  testCommand?: string | undefined;
  testRunner?: TestRunner | undefined;
  fileWriter?: FileWriter | undefined;
  prContext?: string | undefined;
  reviewFeedbackContext?: string | undefined;
  /**
   * Issue #276 — regression-surface context (callers/importers of changed files)
   * built from the codegraph. Routed into the review wave's user message via
   * `runReviewLoop` so the reviewer can verify behavioral consistency at each
   * dependent. Optional — falls back to no surface context when undefined.
   */
  regressionSurfaceContext?: string | undefined;
  prescanRunner?: PrescanRunner | undefined;
  /** Baseline failing-test names recorded before WAVE I ran. */
  baselineFailures?: string[] | undefined;
  /** Current failing-test names after WAVE I. Paired with baselineFailures. */
  currentFailures?: string[] | undefined;
  /** Override the wave's playwright wiring at input level. EngineContext.playwright wins. */
  playwright?: { enabled: boolean } | undefined;
}

// --- ShipEngine (issue #356) ---
//
// Ship is NOT an AI wave — it has no model, no cost, no turns. It encapsulates
// the deterministic git operations phase: pre-ship conflict detection,
// conditional impl retry on overlapping conflicts, rebase, secrets scan,
// commit, push, PR creation. ShipEngine therefore lives outside the
// `WaveEngine<TInput, TOutput>` contract (whose `name` is `FixAIWaveName`).

/**
 * Hook for re-running the parallel piece T+I loop when ship detects
 * overlapping spec-file conflicts. Injected by callers so this engine stays
 * decoupled from the TIEngine module. Returning `testsPassing: false` is a
 * non-fatal signal — ship logs a warning and proceeds to rebase.
 */
export type ShipRetryParallelTILoop = (input: { codebaseContext: string }) => Promise<{ testsPassing: boolean }>;

/**
 * Context every ShipEngine run receives. A strict subset of `EngineContext` —
 * ship only needs the working directory and the repo path (for `listOpenPRs`).
 * Keeping it separate from `EngineContext` avoids dragging AI-wave-only fields
 * (mcpHandles, runSkills, abTestVariant) into a non-AI engine.
 */
export interface ShipEngineContext {
  /** Worktree path where the engine performs git operations. */
  workDir: string;
  /** The user's repo checkout — used for repo-level gh queries (listOpenPRs). */
  repoPath: string;
  /** Repo-level configuration. Optional — ship's deterministic gates do not consult it. */
  config?: RepoConfig | undefined;
}

/**
 * Input payload for a ShipEngine run.
 */
export interface ShipEngineInput {
  issue: Issue;
  /** Branch name on origin where the PR will be created. */
  branch: string;
  /** Files declared in the spec — used by `checkForConflicts` to bucket overlapping vs not. */
  specFiles: string[];
  /** Other PRs currently open against the repo — surfaced in the PR body for merge ordering. */
  openPRs: string[];
  /** Issue numbers this fix depends on (for the "Merge Dependencies" PR-body section). */
  mergeDependencies?: number[] | undefined;
  /** Findings from WAVE R the loop could not resolve — listed under "Known Issues" in PR body. */
  reviewKnownIssues?: ReviewFinding[] | undefined;
  /** Optional retry hook — invoked when overlapping conflicts are detected. */
  retryParallelTILoop?: ShipRetryParallelTILoop | undefined;
}

/**
 * Discriminated-union outcome of a ShipEngine run.
 *
 * `shipped` — PR created. Carries the URL + commit + staged-file list.
 * `no_changes` — `commitAndPush` reported nothing to commit (the fix was a no-op).
 * `failed` — A deterministic gate (secrets / rebase / conflict-resolution) blocked the ship.
 */
export type ShipEngineResult =
  | {
      status: 'shipped';
      prUrl: string;
      commitMessage?: string;
      filesStaged: string[];
    }
  | {
      status: 'no_changes';
    }
  | {
      status: 'failed';
      reason: 'secrets' | 'rebase' | 'conflict';
      error: string;
    };

/**
 * The ShipEngine contract. Stateless. Implementations encapsulate the
 * conflict-detect → rebase → secrets-scan → commit → push → PR sequence.
 */
export interface ShipEngine {
  readonly name: 'ship';
  run(ctx: ShipEngineContext, input: ShipEngineInput): Promise<ShipEngineResult>;
}

/**
 * Pure helper that applies an `EngineStateDelta` onto a `FixState`, returning
 * a NEW state object (issue #432). The orchestrator calls this after every
 * engine run so the per-wave assignments scattered across `fix.ts` collapse
 * into a single application point.
 *
 * Semantics (mirrors the doc on `EngineStateDelta`):
 *   - Omitted fields → state slot unchanged.
 *   - `failedPieces` / `reviewKnownIssues` → REPLACE the slot. Engines that
 *     want to append must include the prior values themselves.
 *   - `completedWaves` is NOT in the delta — the orchestrator owns that field.
 *
 * Returning a new object (rather than mutating) keeps engines from holding
 * stale references and matches the "config bound exactly once" guarantee on
 * `RepoConfig` (issue #432 AC).
 */
export function applyEngineStateDelta(state: FixState, delta: EngineStateDelta | undefined): FixState {
  if (delta == null) return state;
  const next: FixState = { ...state };
  if ('diagnosis' in delta) next.diagnosis = delta.diagnosis;
  if ('thrashingSignal' in delta) next.thrashingSignal = delta.thrashingSignal;
  if ('retryAttempts' in delta) next.retryAttempts = delta.retryAttempts;
  if ('failedPieces' in delta) next.failedPieces = delta.failedPieces;
  if ('reviewKnownIssues' in delta) next.reviewKnownIssues = delta.reviewKnownIssues;
  if ('mergeDependencies' in delta) next.mergeDependencies = delta.mergeDependencies;
  return next;
}
