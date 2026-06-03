// Result projection helpers (issue #435 — ADR 004 step 1).
//
// Extracted from fix.ts to keep the orchestrator focused on flow control.
// These three helpers are pure mappings between WaveHandoff / WaveResult /
// provider-strings, used by every wave-completion path in fix.ts to bridge
// the artifact shape produced by engines (`WaveHandoff`) and the checkpoint /
// cost-report shape (`WaveResult`).
//
// Pure, side-effect-free. Independently tested in `./result.test.ts`.

import type { FixAIWaveName } from '../ai/index.js';
import { isConsensusPool, isLocalModel, resolveWaveModel } from '../ai/index.js';
import type { ConsensusMetadata } from '../ai/parallel-executor.js';
import type { RepoConfig, WaveHandoff, WaveModelConfig, WaveResult } from '../types/index.js';
import { waveFallbackModel as waveFallbackModelInner } from './engines/fallback.js';

/**
 * Extract the provider name from a wave's model config.
 *
 * For consensus pools the "provider" concept doesn't fit (multi-provider by
 * design); we return the first pool member's provider for telemetry-tagging
 * purposes only. The first member is guaranteed to exist — `WaveConsensusConfigSchema`
 * constrains pool length to a minimum of 2.
 */
export function waveProvider(config: RepoConfig, wave: FixAIWaveName): string {
  const waveModel = config.model[wave];
  if (isConsensusPool(waveModel)) {
    const first = waveModel.pool[0];
    if (first === undefined) throw new Error(`Empty consensus pool for wave ${wave}`);
    if (typeof first === 'string') return resolveWaveModel(first).provider;
    return first.provider;
  }
  if (typeof waveModel !== 'string') return waveModel.provider;
  return resolveWaveModel(waveModel).provider;
}

/**
 * Convert a `WaveHandoff` to a `WaveResult` for checkpoint / cost-report
 * compatibility.
 *
 * When the handoff carries a `consensus` property (only emitted by
 * `spawnConsensusWave`), project it into `WaveResult.consensus` so the
 * multi-model telemetry survives the WaveResult round-trip. Single-model
 * handoffs leave `WaveResult.consensus` undefined — existing consumers are
 * unaffected.
 *
 * Exported for unit testing the consensus-telemetry propagation contract
 * (#262).
 */
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
  // fields onto the flattened `WaveResultConsensus` telemetry shape — `pool`
  // becomes the list of pool model ids in input order, `rejected_count` is
  // reported via the disagreement log record in `spawnConsensusWave` (which
  // has access to the artifacts); at this mapping layer we default to 0 here
  // and pipeline call sites that own the disagreement log can overwrite
  // `result.consensus.rejected_count`. See `WaveResultConsensus` jsdoc on
  // config.ts.
  const consensus = (handoff as unknown as { consensus?: ConsensusMetadata }).consensus;
  if (consensus != null) {
    result.consensus = {
      pool: consensus.pool_results.map((r) => r.model),
      adjudicator: consensus.adjudicator_model,
      agreement: consensus.agreement,
      rejected_count: 0,
      degraded: consensus.degraded,
    };
  }
  return result;
}

/**
 * Resolve the fallback model string for a wave (3-arg API — issue #242, #435).
 *
 * Thin wrapper around `engines/fallback.ts:waveFallbackModel` that injects the
 * default `isConsensusPool` + `isLocalModel` helpers from `../ai/index.js`. The
 * engines API takes helpers as a 4th arg so unit tests can stub them; this
 * wrapper preserves the original 3-arg surface that orchestrator code and the
 * existing fix.fallback.test.ts / local-model.integration.test.ts depend on.
 *
 * Exported for unit testing.
 */
export function waveFallbackModel(
  waveConfig: WaveModelConfig,
  modelString: string,
  configFallback?: string | false,
): string | undefined {
  return waveFallbackModelInner(waveConfig, modelString, configFallback, { isConsensusPool, isLocalModel });
}

/**
 * Convert a `WaveResult` to a `WaveHandoff` for persistence.
 *
 * Infers `parsed` from the artifact shape — structured artifacts are objects,
 * raw model output that fell back to string fails the discriminator (see
 * issue #308).
 */
export function waveResultToHandoff(result: WaveResult): WaveHandoff {
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
