// QualityEngine — quality-gate engine adapter (issue #355).
//
// Wraps the quality-gate self-healing retry loop behind the WaveEngine
// contract. Today it adapts `runQualityRetryLoop` from `../loops.ts`; once
// every wave runs through an engine, fix.ts stops importing loops.ts
// directly and the orchestrator only sees the WaveEngine surface.
//
// Note on scope: this engine handles the POST-quality retry loop only — the
// initial quality wave dispatch (spawnWave('quality', ...)) is still owned by
// fix.ts. A follow-up issue will fold that dispatch into this engine so the
// full quality phase (initial + self-heal) lives in one place. For now we
// keep the seam narrow so the swap from inline loops.ts to engines is
// behavior-preserving.

import type { QualityRetryConfig, QualityRetryResult } from '../loops.js';
import { runQualityRetryLoop } from '../loops.js';
import type { EngineContext, EngineResult, QualityEngineInput, WaveEngine } from './types.js';

/**
 * Merge engine ctx + input into a `runQualityRetryLoop` config. The
 * orchestrator-owned ctx fields (workDir, repoConfig, sandbox, projectContext,
 * cacheContext) take precedence over anything callers smuggle through input.
 * Exposed for unit-testing the merge in isolation from the loop dispatch.
 */
export function buildQualityRetryConfig(ctx: EngineContext, input: QualityEngineInput): QualityRetryConfig {
  return {
    issue: input.issue,
    workDir: ctx.workDir,
    repoConfig: ctx.config,
    waveResults: input.waveResults,
    ...(input.testRunner !== undefined && { testRunner: input.testRunner }),
    ...(input.testCommand !== undefined && { testCommand: input.testCommand }),
    ...(ctx.projectContext !== undefined && { projectContext: ctx.projectContext }),
    ...(ctx.sandbox !== undefined && { sandbox: ctx.sandbox }),
    ...(ctx.cacheContext !== undefined && { cacheContext: ctx.cacheContext }),
  };
}

/**
 * Map a `QualityRetryResult` into an `EngineResult`. Confidence reflects
 * whether self-healing was needed: `high` on a clean pass (no retry),
 * `medium` when impl was retried (signal that the run is recoverable but
 * imperfect). Matches the existing semantics in `fix.ts` where a retry leaves
 * the run continuing but with reduced confidence.
 */
function toEngineResult(result: QualityRetryResult): EngineResult<QualityRetryResult> {
  const model = result.qualityWaveResult.model ?? 'unknown';
  return {
    handoff: {
      wave: 'quality',
      timestamp: new Date().toISOString(),
      model,
      cost: result.totalCost,
      turns: result.qualityWaveResult.turns ?? 0,
      confidence: result.retried ? 'medium' : 'high',
      artifact: result,
      approach_notes: result.retried ? 'quality self-healing retry triggered' : '',
    },
    promptHash: '',
  };
}

/**
 * Create a QualityEngine instance. Stateless. The returned engine can be
 * reused across runs.
 */
export function createQualityEngine(): WaveEngine<QualityEngineInput, QualityRetryResult> {
  return {
    name: 'quality',
    async run(ctx, input) {
      const retryConfig = buildQualityRetryConfig(ctx, input);
      const result = await runQualityRetryLoop(retryConfig);
      return toEngineResult(result);
    },
  };
}
