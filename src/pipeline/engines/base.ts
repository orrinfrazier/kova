// Base utilities for engine execution (issue #353).
//
// `runWaveEngine` is the executor wrapper every caller should go through —
// it gives us a single seam to add cross-cutting concerns (timing, telemetry,
// metric tagging) without touching individual engine implementations. Today
// it's a thin pass-through; dependent issues add the real cross-cutting work
// as engines get extracted from fix.ts.
//
// `resolveWaveModelProvider` re-exports the provider lookup logic in a stable
// location so engines can call it without depending on fix.ts internals.

import { isConsensusPool, resolveWaveModel } from '../../ai/index.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import type { RepoConfig } from '../../types/index.js';
import type { EngineContext, EngineResult, WaveEngine } from './types.js';

/**
 * Run a wave engine against the given context + input. Thin pass-through today;
 * the seam exists so dependent issues can layer in timing, retries, telemetry,
 * or metric tagging in one place rather than per-engine.
 */
export async function runWaveEngine<TInput, TOutput>(
  engine: WaveEngine<TInput, TOutput>,
  ctx: EngineContext,
  input: TInput,
): Promise<EngineResult<TOutput>> {
  return engine.run(ctx, input);
}

/**
 * Extract the provider name from a wave's model config. Used for telemetry-
 * tagging and cost-attribution. For consensus pools (multi-provider by
 * design), returns the first member's provider — the same shape `fix.ts`
 * uses for tagging.
 *
 * Kept here so engines can reach it without importing the orchestrator;
 * `fix.ts` retains its own copy for now (dependent issues #354-#356 unify them
 * once each wave's engine is extracted).
 */
export function resolveWaveModelProvider(config: RepoConfig, wave: FixAIWaveName): string {
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
