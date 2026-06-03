// ReviewEngine — review-loop engine adapter (issue #356).
//
// Wraps `runReviewLoop` from `../loops.ts` behind the WaveEngine contract
// defined in `./types.ts`. The loop owns iteration control, prescan/baseline
// gates, persona selection, and known-issue accumulation; this engine is a
// thin adapter that:
//   1. Merges orchestrator-owned ctx fields with caller-supplied input.
//   2. Maps the loop's result into the WaveHandoff/EngineResult shape so the
//      orchestrator's persistence + downstream consumers see the same shape
//      every wave produces.
//
// Confidence mapping mirrors the existing semantics in `fix.ts:1393`:
//   - `high` when the loop returns with no `knownIssues`
//   - `medium` when known issues remain (the run still ships but the PR body
//     surfaces the leftovers under "Known Issues")

import type { ReviewLoopConfig, ReviewLoopResult } from '../loops.js';
import { runReviewLoop } from '../loops.js';
import type { EngineContext, EngineResult, ReviewEngineInput, WaveEngine } from './types.js';

/**
 * Build the `runReviewLoop` config from the engine ctx + input.
 *
 * Exposed for unit testing the merge logic without invoking the loop. Merge
 * precedence: orchestrator-owned ctx fields (workDir, repoConfig, sandbox,
 * projectContext, cacheContext, playwright) override anything callers smuggle
 * through input — those are not user-facing knobs at the engine layer.
 */
export function buildReviewLoopConfig(ctx: EngineContext, input: ReviewEngineInput): ReviewLoopConfig {
  return {
    issue: input.issue,
    workDir: ctx.workDir,
    repoConfig: ctx.config,
    waveResults: input.waveResults,
    ...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
    ...(input.testCommand !== undefined && { testCommand: input.testCommand }),
    ...(input.testRunner !== undefined && { testRunner: input.testRunner }),
    ...(input.fileWriter !== undefined && { fileWriter: input.fileWriter }),
    ...(input.prContext !== undefined && { prContext: input.prContext }),
    ...(input.reviewFeedbackContext !== undefined && {
      reviewFeedbackContext: input.reviewFeedbackContext,
    }),
    ...(input.regressionSurfaceContext !== undefined && {
      regressionSurfaceContext: input.regressionSurfaceContext,
    }),
    ...(input.prescanRunner !== undefined && { prescanRunner: input.prescanRunner }),
    ...(input.baselineFailures !== undefined && { baselineFailures: input.baselineFailures }),
    ...(input.currentFailures !== undefined && { currentFailures: input.currentFailures }),
    // ctx-level overrides win over input — these are orchestrator-owned.
    ...(ctx.projectContext !== undefined && { projectContext: ctx.projectContext }),
    ...(ctx.sandbox !== undefined && { sandbox: ctx.sandbox }),
    ...(ctx.cacheContext !== undefined && { cacheContext: ctx.cacheContext }),
    ...(ctx.playwright !== undefined
      ? { playwright: ctx.playwright }
      : input.playwright !== undefined
        ? { playwright: input.playwright }
        : {}),
  };
}

/**
 * Map a `ReviewLoopResult` to an `EngineResult` carrying a typed `WaveHandoff`.
 * Confidence reflects whether known issues remain after the loop's max
 * iterations — high when clean, medium when leftovers survive into the PR body.
 */
function toEngineResult(result: ReviewLoopResult): EngineResult<ReviewLoopResult> {
  const model = result.reviewWaveResult.model ?? 'unknown';
  return {
    handoff: {
      wave: 'review',
      timestamp: new Date().toISOString(),
      model,
      cost: result.totalCost,
      turns: result.reviewWaveResult.turns ?? 0,
      confidence: result.knownIssues.length === 0 ? 'high' : 'medium',
      artifact: result,
      approach_notes: `${result.iterations} iteration(s)`,
    },
    // No prompt-hash at this layer — the loop spawns multiple review-wave
    // dispatches across iterations, each with its own prompt hash. The
    // aggregate handoff intentionally elides it.
    promptHash: '',
  };
}

/**
 * Create a ReviewEngine instance. Stateless — the returned object can be
 * reused across runs; engines are not meant to hold state between invocations.
 */
export function createReviewEngine(): WaveEngine<ReviewEngineInput, ReviewLoopResult> {
  return {
    name: 'review',
    async run(ctx, input) {
      const loopConfig = buildReviewLoopConfig(ctx, input);
      const result = await runReviewLoop(loopConfig);
      return toEngineResult(result);
    },
  };
}
