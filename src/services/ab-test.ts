// A/B test variant selection — picks prompt variants per run and tracks
// selections for correlation with success rates. Supports adaptive selection
// (epsilon-greedy) from historical variant stats so successful variants get
// exploited and weaker ones are explored only occasionally.

import type { ABTestConfig } from '../types/index.js';
import type { ABTestVariantStats } from './prompt-correlation.js';

/** Selected variants for a single run, keyed by wave name. */
export type VariantSelection = Record<string, string>;

/** Default exploration rate when stats exist for a wave. */
export const DEFAULT_EPSILON = 0.1;

/**
 * Policy controlling how `selectVariants` consults history.
 *
 * - `epsilon`: probability of exploring uniformly instead of exploiting the
 *   best sufficient variant. Clamped to `[0, 1]`. Defaults to {@link DEFAULT_EPSILON}.
 * - `forceRandom`: if true, always picks uniformly at random regardless of stats.
 *   Equivalent to setting `epsilon = 1` but explicit / config-friendly.
 */
export interface ABTestPolicy {
  epsilon?: number;
  forceRandom?: boolean;
}

/**
 * Injectable RNG used by tests. Defaults to {@link Math.random}.
 * Always returns a number in `[0, 1)`.
 */
export type RandomFn = () => number;

export interface SelectVariantsOptions {
  stats?: ABTestVariantStats[];
  policy?: ABTestPolicy;
  /** Injectable RNG for deterministic tests. */
  random?: RandomFn;
}

/**
 * Select a variant for each wave configured in `abTest`.
 *
 * Behavior:
 * - When no `stats` are provided (or no `sufficient` stats exist for a wave),
 *   selection is uniform random — preserves cold-start backward compatibility.
 * - When a wave has at least one `sufficient` variant in `stats`, behaves as
 *   epsilon-greedy: with probability `1 - epsilon` exploit the best
 *   `sufficient` variant (highest `successRate`); otherwise explore uniformly
 *   across all configured variants.
 * - `policy.forceRandom = true` always falls back to uniform random regardless
 *   of stats — useful as a config / CLI `--explore` escape hatch.
 *
 * The exploit branch always picks the best variant by `successRate` from the
 * set of variants that are both configured in `abTest[wave]` and present in
 * `stats` as `sufficient`. Variants seen in stats but no longer configured are
 * ignored. This keeps adaptive selection stable across config edits.
 */
export function selectVariants(abTest: ABTestConfig, options: SelectVariantsOptions = {}): VariantSelection {
  const { stats, policy, random = Math.random } = options;
  const epsilonRaw = policy?.epsilon ?? DEFAULT_EPSILON;
  const epsilon = clamp01(epsilonRaw);
  const forceRandom = policy?.forceRandom === true;

  const statsByWave = indexStatsByWave(stats);

  const selection: VariantSelection = {};
  for (const [wave, variants] of Object.entries(abTest)) {
    if (!variants || variants.length === 0) continue;

    const picked = forceRandom
      ? pickRandom(variants, random)
      : pickEpsilonGreedy(variants, statsByWave.get(wave), epsilon, random);

    if (picked != null) {
      selection[wave] = picked;
    }
  }
  return selection;
}

/**
 * Resolve the prompt file name for a wave given A/B test selections.
 * Returns the variant file name (e.g., "assess.v2.md") if a variant is selected,
 * or undefined if no variant is selected for this wave.
 */
export function variantFileName(wave: string, variant: string): string {
  return `${wave}.${variant}.md`;
}

// --- internals ---------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EPSILON;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickRandom(variants: string[], random: RandomFn): string | undefined {
  if (variants.length === 0) return undefined;
  const index = Math.floor(random() * variants.length);
  return variants[index];
}

function pickEpsilonGreedy(
  variants: string[],
  waveStats: ABTestVariantStats[] | undefined,
  epsilon: number,
  random: RandomFn,
): string | undefined {
  // Cold start: no sufficient data for this wave → uniform random.
  const sufficient = (waveStats ?? []).filter((s) => s.sufficient && variants.includes(s.variant));
  if (sufficient.length === 0) {
    return pickRandom(variants, random);
  }

  // Epsilon-greedy: explore with probability epsilon.
  if (random() < epsilon) {
    return pickRandom(variants, random);
  }

  // Exploit: best sufficient variant by success rate. Tie-break by name for
  // determinism.
  let best = sufficient[0];
  if (!best) return pickRandom(variants, random);
  for (const s of sufficient) {
    if (s.successRate > best.successRate || (s.successRate === best.successRate && s.variant < best.variant)) {
      best = s;
    }
  }
  return best.variant;
}

function indexStatsByWave(stats: ABTestVariantStats[] | undefined): Map<string, ABTestVariantStats[]> {
  const map = new Map<string, ABTestVariantStats[]>();
  if (!stats) return map;
  for (const s of stats) {
    const list = map.get(s.wave);
    if (list) {
      list.push(s);
    } else {
      map.set(s.wave, [s]);
    }
  }
  return map;
}
