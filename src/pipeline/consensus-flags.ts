// Consensus pool flag plumbing (#261).
//
// `kova fix --consensus [--pool <spec>] [--consensus-waves <list>]` lets a
// caller route high-stakes waves (assess, spec, review by default) through the
// multi-model consensus path (`spawnConsensusWave`). This module owns:
//
//   - `parsePoolSpec(spec)` — accepts `'diverse'` shorthand or a comma-separated
//     `provider:model` list, returning 2-5 `WaveSingleModelConfig` entries.
//   - `parseConsensusWavesList(list)` — accepts a comma-separated list of wave
//     names, validates each against the FixAIWaveName enum, dedupes.
//   - `applyConsensusToConfig(config, opts)` — returns a new RepoConfig with
//     `config.model[wave]` mutated to a `WaveConsensusConfig` for each requested
//     wave. Pure: input config is not modified.
//   - `formatConsensusActivationLog(opts)` — one-line announcement the CLI
//     surfaces at startup so the user sees the routing + cost implication.
//
// The consensus infrastructure itself (schema, executor, telemetry projection,
// disagreement log) is already wired in main — this module is the user-facing
// CLI seam.

import type { FixAIWaveName } from '../ai/wave-tools.js';
import type { RepoConfig, WaveSingleModelConfig } from '../types/index.js';

/** Default consensus waves when `--consensus` is set without `--consensus-waves`.
 *  Mirrors the issue body: "default consensus waves = assess, spec, review".
 *  High-stakes reasoning phases (assess + spec) plus the safety-net review
 *  benefit most from cross-family adjudication; T/I/Q stay single-model so the
 *  ~Nx cost is bounded. */
export const DEFAULT_CONSENSUS_WAVES: readonly FixAIWaveName[] = ['assess', 'spec', 'review'];

/** The "diverse" pool: one strong model per major foundation-model family
 *  (anthropic, openai, google). Three is the minimum-viable cross-family pool —
 *  enough to detect a 1-of-3 minority dissent without inflating cost beyond ~3x.
 *  Adjudicator stays at the schema-default `'large'` tier (typically opus).
 *  Typed as the `{provider, model}` arm of `WaveSingleModelConfig` so the
 *  `parsePoolSpec('diverse')` shallow-clone path stays type-clean. */
const DIVERSE_POOL: ReadonlyArray<{ provider: string; model: string }> = [
  { provider: 'anthropic', model: 'claude-opus-4-6' },
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'google', model: 'gemini-2.5-pro' },
];

/** Valid FixAI wave names (must match `FixAIWaveName` in src/ai/wave-tools.ts).
 *  Kept as a local readonly tuple so the parser can validate without importing
 *  the runtime constant from a heavier module. */
const VALID_CONSENSUS_WAVES: readonly FixAIWaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review'];

/**
 * Parse `--pool <spec>` into a list of `WaveSingleModelConfig` entries.
 *
 * Accepted forms:
 *   - `'diverse'`               → canonical 3-member cross-family pool
 *   - `'provider:model,...'`    → 2-5 explicit `{provider, model}` entries
 *   - `'tier,tier,...'`         → tier strings (`small|medium|large`); useful
 *     for an all-Claude pool with focus rotation
 *   - mixed `'large,openai:gpt-4o,google:gemini-2.5-pro'` is also accepted —
 *     the schema accepts the `ModelTier | Override | string` union per element.
 *
 * Throws KovaError-shaped errors (Error subclass) when the spec is empty, has
 * fewer than 2 or more than 5 members, or a non-tier entry omits the
 * `provider:model` separator. We use plain `Error` here (not `KovaError`) to
 * avoid the ai/errors.js cyclic import; the CLI layer catches and exits 1.
 */
export function parsePoolSpec(spec: string): WaveSingleModelConfig[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error('--pool spec is empty; expected "diverse" or a comma-separated provider:model list');
  }

  if (trimmed === 'diverse') {
    return DIVERSE_POOL.map((m) => ({ ...m }));
  }

  const parts = trimmed
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) {
    throw new Error(
      `--pool spec must contain at least 2 members (got ${parts.length}); ` +
        'consensus needs ≥2 perspectives to adjudicate',
    );
  }
  if (parts.length > 5) {
    throw new Error(`--pool spec must contain at most 5 members (got ${parts.length}); the schema caps pools at 5`);
  }

  return parts.map((entry) => {
    // Tier strings pass through unchanged — WaveSingleModelConfigSchema accepts
    // `small|medium|large` via the `ModelTier` arm of the union.
    if (entry === 'small' || entry === 'medium' || entry === 'large') {
      return entry;
    }
    const colonIndex = entry.indexOf(':');
    if (colonIndex <= 0 || colonIndex === entry.length - 1) {
      throw new Error(
        `--pool member "${entry}" must be either a tier (small|medium|large) or a "provider:model" string`,
      );
    }
    return {
      provider: entry.slice(0, colonIndex),
      model: entry.slice(colonIndex + 1),
    };
  });
}

/**
 * Parse `--consensus-waves <list>` into a deduped list of `FixAIWaveName`.
 *
 * - Empty list throws (the flag with no value is meaningless).
 * - Unknown wave names throw with the valid list surfaced so the user can
 *   correct a typo without grepping the source.
 * - Order is preserved across the first occurrence of each wave; later
 *   duplicates are dropped (last-wins is not meaningful — the wave config
 *   either gets a pool or it doesn't).
 */
export function parseConsensusWavesList(list: string): FixAIWaveName[] {
  const trimmed = list.trim();
  if (trimmed.length === 0) {
    throw new Error(`--consensus-waves list is empty; expected one or more of: ${VALID_CONSENSUS_WAVES.join(', ')}`);
  }
  const tokens = trimmed
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const seen = new Set<FixAIWaveName>();
  const out: FixAIWaveName[] = [];
  for (const tok of tokens) {
    if (!(VALID_CONSENSUS_WAVES as readonly string[]).includes(tok)) {
      throw new Error(
        `--consensus-waves contains unknown wave "${tok}"; valid waves: ${VALID_CONSENSUS_WAVES.join(', ')}`,
      );
    }
    const wave = tok as FixAIWaveName;
    if (!seen.has(wave)) {
      seen.add(wave);
      out.push(wave);
    }
  }
  return out;
}

/** Options for `applyConsensusToConfig`. */
export interface ApplyConsensusOptions {
  /** Pool members (≥2, ≤5). Caller resolves via `parsePoolSpec`. */
  pool: readonly WaveSingleModelConfig[];
  /** Waves to route through the pool. Caller resolves via `parseConsensusWavesList`
   *  or falls back to `DEFAULT_CONSENSUS_WAVES`. */
  waves: readonly FixAIWaveName[];
  /** Optional adjudicator override. Defaults to the schema default (`'large'`,
   *  typically opus). */
  adjudicator?: WaveSingleModelConfig;
}

/**
 * Return a new RepoConfig with `config.model[wave]` replaced by a
 * `WaveConsensusConfig` for each wave in `opts.waves`. Untouched waves keep
 * their existing single-model config.
 *
 * Pure: input config is not mutated. The returned config still satisfies
 * `RepoConfigSchema.parse` — `WaveModelConfigSchema` accepts the pool variant.
 */
export function applyConsensusToConfig(config: RepoConfig, opts: ApplyConsensusOptions): RepoConfig {
  if (opts.pool.length < 2) {
    throw new Error(`applyConsensusToConfig: pool must have ≥2 members (got ${opts.pool.length})`);
  }
  const newModel = { ...config.model };
  const clonedPool: WaveSingleModelConfig[] = opts.pool.map((m) => (typeof m === 'string' ? m : { ...m }));
  for (const wave of opts.waves) {
    newModel[wave] = {
      // Defensive clone so callers can't mutate the returned config's pool
      // array through the shared `opts.pool` reference after the fact.
      pool: [...clonedPool],
      adjudicator: opts.adjudicator ?? 'large',
    };
  }
  return { ...config, model: newModel };
}

/**
 * Render the one-line "consensus activated" log message the CLI prints at
 * startup. Surfaces the pool size, wave list, and Nx cost hint so the user
 * sees the routing and the implication without reading the source.
 */
export function formatConsensusActivationLog(opts: {
  pool: readonly WaveSingleModelConfig[];
  waves: readonly FixAIWaveName[];
}): string {
  const n = opts.pool.length;
  const waveList = opts.waves.join(', ');
  return `[consensus] Routing waves [${waveList}] through pool of ${n} member${n === 1 ? '' : 's'} (adjudicator: large). Expect ~${n}x cost on those waves.`;
}
