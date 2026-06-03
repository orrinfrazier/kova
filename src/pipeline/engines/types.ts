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
import type { MCPServerHandle, OutputFormat } from '../../ai/index.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import type { SandboxContext } from '../../sandbox/dispatch.js';
import type { ProjectContext } from '../../services/project-context.js';
import type { WaveHandoff } from '../../types/handoffs.js';
import type { Issue, RepoConfig, SkillWaveName, WaveName, WaveResult } from '../../types/index.js';
import type { DiffRunner, TestRunner } from '../loops.js';

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
}

/**
 * What every engine returns. Mirrors the shape `spawnWave` returns today so
 * engines drop into the existing orchestrator call sites with no shape change.
 */
export interface EngineResult<T> {
  handoff: WaveHandoff<T>;
  promptHash: string;
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
