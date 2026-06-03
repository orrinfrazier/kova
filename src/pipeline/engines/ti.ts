// TIEngine — Test+Impl engine adapter (issue #355).
//
// Modularizes the parallel Test+Implement loop behind the WaveEngine contract
// defined in `./types.ts`. Today it is a thin adapter that delegates to
// `runParallelPieceTILoop` from `../loops.ts`; this keeps behavior identical
// while giving downstream issues (#356 review/ship engines, #357 unified
// dispatch) a stable seam to wire through. Once every wave runs through an
// engine, the orchestrator stops importing loops.ts directly.
//
// Why a factory (`createTIEngine`) rather than a singleton:
// - lets callers inject test doubles in unit tests (the engine itself is
//   stateless, but the factory keeps the construction shape parallel to the
//   QualityEngine / ReviewEngine / ShipEngine factories that will land next)
// - mirrors the pattern in `~/.claude/skills/fix/SKILL.md` "Skill Worktree &
//   Review Enforcement" — a small, separate seam is cheaper to evolve than a
//   module-level free function.

import type { FailedPiece } from '../../types/index.js';
import type { ParallelPieceTILoopConfig, ParallelPieceTILoopResult } from '../loops.js';
import { detectThrashing, runParallelPieceTILoop } from '../loops.js';
import type { EngineContext, EngineResult, EngineStateDelta, TIEngineInput, WaveEngine } from './types.js';

/**
 * Build the `runParallelPieceTILoop` config from the engine ctx + input.
 *
 * Exposed for unit testing the merge logic without spinning up the full loop.
 * The merge precedence is: orchestrator-owned ctx fields (workDir, repoConfig,
 * sandbox, projectContext, cacheContext) override anything in the input —
 * those are not user-facing knobs at the engine layer.
 */
export function buildTILoopConfig(ctx: EngineContext, input: TIEngineInput): ParallelPieceTILoopConfig {
  return {
    issue: input.issue,
    workDir: ctx.workDir,
    repoConfig: ctx.config,
    waveResults: input.waveResults,
    ...(input.maxConcurrent !== undefined && { maxConcurrent: input.maxConcurrent }),
    ...(input.testCommand !== undefined && { testCommand: input.testCommand }),
    ...(input.testRunner !== undefined && { testRunner: input.testRunner }),
    ...(input.diffRunner !== undefined && { diffRunner: input.diffRunner }),
    ...(input.prContext !== undefined && { prContext: input.prContext }),
    ...(input.codebaseContext !== undefined && { codebaseContext: input.codebaseContext }),
    ...(input.codegraphContext !== undefined && { codegraphContext: input.codegraphContext }),
    ...(input.callPathContext !== undefined && { callPathContext: input.callPathContext }),
    ...(ctx.projectContext !== undefined && { projectContext: ctx.projectContext }),
    ...(ctx.sandbox !== undefined && { sandbox: ctx.sandbox }),
    ...(ctx.cacheContext !== undefined && { cacheContext: ctx.cacheContext }),
    ...(input.skipTestPhase !== undefined && { skipTestPhase: input.skipTestPhase }),
    ...(input.skipImplPhase !== undefined && { skipImplPhase: input.skipImplPhase }),
    ...(input.extraImplAttempts !== undefined && { extraImplAttempts: input.extraImplAttempts }),
  };
}

/**
 * Build the `EngineStateDelta` that captures TI's contribution to FixState
 * (issue #432). Mirrors the inline assignments at fix.ts:1459-1462 — the
 * orchestrator's loop applies these via `applyEngineStateDelta` instead of
 * writing through `state.*` directly. Exported for unit testing.
 */
export function buildTIStateDelta(result: ParallelPieceTILoopResult): EngineStateDelta {
  return {
    diagnosis: result.diagnosis,
    thrashingSignal:
      result.modifiedFilesPerAttempt.length >= 2 ? detectThrashing(result.modifiedFilesPerAttempt) : undefined,
    retryAttempts: result.attempts,
  };
}

/**
 * Build a `FailedPiece` for the orchestrator to append to `state.failedPieces`
 * (issue #432). Returns `undefined` when the run succeeded — the orchestrator
 * uses absence to mean "no append". Mirrors the inline helper from
 * fix.ts:2134-2143.
 */
export function buildFailedPiece(result: ParallelPieceTILoopResult): FailedPiece | undefined {
  if (result.testsPassing) return undefined;
  return {
    pieceName: 'impl',
    diagnosis: {
      category: result.diagnosis ?? 'STUCK',
      theory: 'TI loop exhausted all retries',
      tests_still_failing: [],
    },
  };
}

/**
 * Result type for `TIEngine.run()` (issue #432).
 *
 * Extends `EngineResult` with the optional `newFailedPiece` field. We keep
 * `newFailedPiece` OUTSIDE `stateDelta` because `failedPieces` is APPEND-style
 * (the orchestrator may call TIEngine twice — once initially, once after a
 * respec — and both failures must accumulate). The orchestrator's loop reads
 * `newFailedPiece` and appends to `state.failedPieces` in one place.
 */
export interface TIEngineResult extends EngineResult<ParallelPieceTILoopResult> {
  /** When tests still fail, the FailedPiece the orchestrator should append. */
  newFailedPiece?: FailedPiece | undefined;
}

/**
 * Map a `ParallelPieceTILoopResult` to a `TIEngineResult` carrying a typed
 * `WaveHandoff` + `stateDelta` (issue #432). Confidence collapses the loop's
 * testsPassing flag the same way `fix.ts` does today — high when green, low
 * when red — so this engine is a drop-in for the existing call sites.
 */
function toEngineResult(result: ParallelPieceTILoopResult): TIEngineResult {
  const model = result.implWaveResult.model ?? 'unknown';
  const approachNotes = result.diagnosis ? `diagnosis: ${result.diagnosis}` : '';
  const newFailedPiece = buildFailedPiece(result);
  return {
    handoff: {
      wave: 'impl',
      timestamp: new Date().toISOString(),
      model,
      cost: result.totalCost,
      turns: result.attempts,
      confidence: result.testsPassing ? 'high' : 'low',
      artifact: result,
      approach_notes: approachNotes,
    },
    // No prompt-hash at this layer — TIEngine wraps a loop that spawns N
    // per-piece waves, each with its own prompt hash. The aggregate handoff
    // intentionally elides it. Once the loop migrates to per-piece sub-engines
    // we can surface a deterministic aggregate.
    promptHash: '',
    stateDelta: buildTIStateDelta(result),
    ...(newFailedPiece != null && { newFailedPiece }),
  };
}

/**
 * The TIEngine narrows the engine contract to its richer `TIEngineResult`
 * return type (which extends `EngineResult<ParallelPieceTILoopResult>` with
 * `newFailedPiece`). A deliberate covariant narrowing — base `WaveEngine`
 * consumers still see the standard shape, while callers that need the failed-
 * piece accumulator (orchestrator's loop) see it too.
 */
export interface TIEngineType extends WaveEngine<TIEngineInput, ParallelPieceTILoopResult> {
  run(ctx: EngineContext, input: TIEngineInput): Promise<TIEngineResult>;
}

/**
 * Create a TIEngine instance. Stateless — the returned object can be reused
 * across runs; engines are not meant to hold state between invocations.
 */
export function createTIEngine(): TIEngineType {
  return {
    name: 'impl',
    async run(ctx, input) {
      const loopConfig = buildTILoopConfig(ctx, input);
      const result = await runParallelPieceTILoop(loopConfig);
      return toEngineResult(result);
    },
  };
}
