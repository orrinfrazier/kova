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

import type { ParallelPieceTILoopConfig, ParallelPieceTILoopResult } from '../loops.js';
import { runParallelPieceTILoop } from '../loops.js';
import type { EngineContext, EngineResult, TIEngineInput, WaveEngine } from './types.js';

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
    ...(ctx.projectContext !== undefined && { projectContext: ctx.projectContext }),
    ...(ctx.sandbox !== undefined && { sandbox: ctx.sandbox }),
    ...(ctx.cacheContext !== undefined && { cacheContext: ctx.cacheContext }),
    ...(input.skipTestPhase !== undefined && { skipTestPhase: input.skipTestPhase }),
    ...(input.skipImplPhase !== undefined && { skipImplPhase: input.skipImplPhase }),
    ...(input.extraImplAttempts !== undefined && { extraImplAttempts: input.extraImplAttempts }),
  };
}

/**
 * Map a `ParallelPieceTILoopResult` to an `EngineResult` carrying a typed
 * `WaveHandoff`. Confidence collapses the loop's testsPassing flag the same
 * way `fix.ts` does today — high when green, low when red — so this engine is
 * a drop-in for the existing call sites.
 */
function toEngineResult(result: ParallelPieceTILoopResult): EngineResult<ParallelPieceTILoopResult> {
  const model = result.implWaveResult.model ?? 'unknown';
  const approachNotes = result.diagnosis ? `diagnosis: ${result.diagnosis}` : '';
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
  };
}

/**
 * Create a TIEngine instance. Stateless — the returned object can be reused
 * across runs; engines are not meant to hold state between invocations.
 */
export function createTIEngine(): WaveEngine<TIEngineInput, ParallelPieceTILoopResult> {
  return {
    name: 'impl',
    async run(ctx, input) {
      const loopConfig = buildTILoopConfig(ctx, input);
      const result = await runParallelPieceTILoop(loopConfig);
      return toEngineResult(result);
    },
  };
}
