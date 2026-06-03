// Wave-level fallback model resolution — shared between engines (issue #354).
//
// Mirrors `waveFallbackModel` from `fix.ts` so engines can call it without
// importing the orchestrator (which would create a fix.ts → engine → fix.ts
// cycle). `fix.ts` retains its own copy so call sites there don't change
// behavior; once every wave is extracted (#355, #356) the duplicate goes.
//
// The helpers (`isConsensusPool`, `isLocalModel`) are injected so tests can
// stub them without re-mocking `../../ai/index.js` for every engine test.

import { getApiFallbackModelString } from '../../ai/index.js';
import type { WaveModelConfig } from '../../types/index.js';

export interface FallbackHelpers {
  isConsensusPool: (config: WaveModelConfig) => boolean;
  isLocalModel: (modelString: string) => boolean;
}

/**
 * Resolve the fallback model string for a wave. Returns `undefined` when no
 * fallback applies. Same semantics as `fix.ts:waveFallbackModel`:
 *
 *   - `configFallback === false` → no fallback (explicit opt-out, issue #242)
 *   - explicit configured fallback different from primary → use it
 *   - local primary model → tier-default API fallback (small/medium/large)
 *   - non-local primary → no fallback
 *   - consensus-pool primary → no fallback (pool runners own per-member fallback)
 */
export function waveFallbackModel(
  waveConfig: WaveModelConfig,
  modelString: string,
  configFallback: string | false | undefined,
  helpers: FallbackHelpers,
): string | undefined {
  if (configFallback === false) return undefined;
  if (configFallback && configFallback !== modelString) return configFallback;
  if (!helpers.isLocalModel(modelString)) return undefined;
  if (helpers.isConsensusPool(waveConfig)) return undefined;
  if (typeof waveConfig === 'string') {
    if (waveConfig === 'small' || waveConfig === 'medium' || waveConfig === 'large') {
      return getApiFallbackModelString(waveConfig);
    }
    return getApiFallbackModelString('medium');
  }
  return getApiFallbackModelString('medium');
}
