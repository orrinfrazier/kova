// CLI-level wiring for subscription-billed providers.
//
// Today this is just ChatGPT/Codex. Called once per fix/auto/brainstorm
// invocation, BEFORE `validateModelConfig` so that:
//   (a) a stale-but-refreshable token doesn't fail startup validation; and
//   (b) the in-memory token cache is warm before any wave invokes resolveApiKey.

import { isConsensusPool } from '../ai/models.js';
import { CODEX_PROVIDER, ensureFreshCodexToken } from '../auth/codex/index.js';
import type {
  KovaConfig,
  RepoConfig,
  WaveModelConfig,
  WaveModelOverride,
  WaveSingleModelConfig,
} from '../types/index.js';
import { log } from '../utils/logger.js';

/** The 7 wave keys in RepoConfig.model. `RepoConfig['model']` also includes
 *  `fallback` (string|false) and `thinking` (per-wave thinking levels), so we
 *  don't use `keyof` here — we'd accidentally treat thinking-level maps as
 *  WaveModelConfig values. */
type WaveKey = 'assess' | 'spec' | 'test' | 'impl' | 'quality' | 'review' | 'brainstorm';
const WAVE_NAMES: readonly WaveKey[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'brainstorm'];

/** True when this single-model spec resolves to the openai-codex provider. */
function singleUsesCodex(spec: WaveSingleModelConfig): boolean {
  if (typeof spec === 'string') return spec.startsWith(`${CODEX_PROVIDER}:`);
  // Tier strings 'small'/'medium'/'large' are handled by the string case above
  // (z.infer turns them into bare strings). The remaining object case is the
  // explicit {provider, model} override.
  if (typeof spec === 'object' && spec !== null && 'provider' in spec) {
    return (spec as WaveModelOverride).provider === CODEX_PROVIDER;
  }
  return false;
}

/** True when ANY pool member or adjudicator in this wave uses codex. */
function waveUsesCodex(wc: WaveModelConfig): boolean {
  if (isConsensusPool(wc)) {
    return wc.pool.some(singleUsesCodex) || singleUsesCodex(wc.adjudicator);
  }
  return singleUsesCodex(wc);
}

/** Returns true when any wave in the config references the openai-codex provider. */
export function configUsesCodex(config: RepoConfig): boolean {
  for (const wave of WAVE_NAMES) {
    const wc = config.model?.[wave];
    if (wc && waveUsesCodex(wc)) return true;
  }
  return false;
}

/** Refresh subscription-billed credentials needed by `config`. No-op when no
 *  subscription providers are referenced. Throws on refresh failure — we want
 *  to fail-fast at startup rather than silently 401 on the first wave. */
export async function prepareSubscriptionAuth(config: RepoConfig): Promise<void> {
  if (configUsesCodex(config)) {
    log.debug('Codex provider in config — ensuring fresh access token before pipeline starts.');
    const creds = await ensureFreshCodexToken();
    if (!creds) {
      throw new Error(
        `Codex provider is referenced in your config, but no credentials are present. ` +
          `Run \`kova auth login --codex\` first (or set OPENAI_CODEX_API_KEY in CI).`,
      );
    }
  }
}

/** Multi-repo variant — iterate every repo entry in a KovaConfig. */
export async function prepareSubscriptionAuthForKovaConfig(config: KovaConfig): Promise<void> {
  for (const repo of Object.values(config.repos)) {
    await prepareSubscriptionAuth(repo);
  }
}
