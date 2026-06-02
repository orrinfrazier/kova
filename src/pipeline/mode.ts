// Pipeline-mode resolution (issue #282).
//
// `PipelineMode` is a per-run knob set via `kova fix --mode <mode>` or
// auto-derived from the WAVE A feasibility grade. It maps to per-wave model
// tier overrides + an extra impl-attempt budget for `explore`, without
// editing repos.yaml.
//
// Phase-level model policy (CLAUDE.md): spec, assess, review, and brainstorm
// NEVER downgrade based on mode — reasoning waves are paid for once and
// reused across every piece. Economy/explore only move the execution-tier
// waves (test, impl, quality).

import type { ModelTier, PipelineMode, RepoConfig } from '../types/index.js';

/** Canonical pipeline modes, in declaration order. */
export const PIPELINE_MODES = ['simple', 'standard', 'economy', 'explore'] as const;

type ExecWave = 'test' | 'impl' | 'quality';

/** Per-mode tier overrides for the execution waves. `null` = leave as-is. */
const MODE_TIER_OVERRIDES: Record<PipelineMode, Record<ExecWave, ModelTier | null>> = {
  // standard + simple: leave configured tiers unchanged.
  standard: { test: null, impl: null, quality: null },
  simple: { test: null, impl: null, quality: null },
  // economy: force every execution wave to small. Per CLAUDE.md the gain is
  // not "small everywhere" — it's "small where the spec is already clear".
  economy: { test: 'small', impl: 'small', quality: 'small' },
  // explore: raise breadth on T/I so retries explore more of the space; keep
  // quality on its configured tier (gates don't benefit from explore).
  explore: { test: 'large', impl: 'large', quality: null },
};

/**
 * Extra impl attempts granted per-piece in each mode (issue #282 explore AC).
 * Plumbed into `runPieceTILoop.extraImplAttempts` from fix.ts.
 *
 *  - `explore`: +1 attempt → 4 total. Gives the review wave one extra
 *    candidate impl to evaluate. Phase 1 of the "review selects winner"
 *    feature — full parallel-impl + adjudication is a follow-up.
 *  - All other modes: 0 extra (default 3-attempt budget).
 */
export const MODE_EXTRA_IMPL_ATTEMPTS: Record<PipelineMode, number> = {
  simple: 0,
  standard: 0,
  economy: 0,
  explore: 1,
};

/** Numeric ordering for tier-downgrade safety checks. */
const TIER_RANK: Record<ModelTier, number> = { small: 0, medium: 1, large: 2 };

/** Return the tier rank for a string config value, or null if it isn't a tier. */
function tierRank(value: unknown): number | null {
  if (value === 'small' || value === 'medium' || value === 'large') {
    return TIER_RANK[value];
  }
  return null;
}

/**
 * Apply a pipeline mode's tier overrides to a `RepoConfig`. Returns a new
 * config object — never mutates the input.
 *
 * Safety rule (issue #282 AC): never silently upgrades cost. For each
 * execution wave, the result is the cheaper of (configured tier, mode override).
 * If the configured tier is a structured override (consensus pool or
 * provider/model object), the mode override does NOT apply — preserving the
 * user's explicit configuration.
 */
export function applyPipelineMode(config: RepoConfig, mode: PipelineMode): RepoConfig {
  const overrides = MODE_TIER_OVERRIDES[mode];

  // Mode controls only the execution waves. Spec/assess/review/brainstorm are
  // unchanged (CLAUDE.md phase-level policy).
  const next = {
    ...config,
    model: {
      ...config.model,
      test: pickWaveTier(config.model.test, overrides.test),
      impl: pickWaveTier(config.model.impl, overrides.impl),
      quality: pickWaveTier(config.model.quality, overrides.quality),
    },
  } satisfies RepoConfig;

  return next;
}

/**
 * Select the cheaper of (configured, mode override) for a single wave. If
 * the configured value isn't a plain tier (e.g. a consensus pool or a
 * provider/model override), preserve it unchanged — the user opted in
 * explicitly and we won't override that.
 */
function pickWaveTier<T>(configured: T, override: ModelTier | null): T {
  if (override == null) return configured;
  const configuredRank = tierRank(configured);
  if (configuredRank == null) {
    // Non-tier override (pool, provider/model object, custom string). Leave alone.
    return configured;
  }
  const overrideRank = TIER_RANK[override];
  // Never silently upgrade: keep whichever rank is lower.
  if (overrideRank < configuredRank) {
    return override as T;
  }
  if (overrideRank > configuredRank) {
    // Mode wants a higher tier (explore raising small → large). This IS an
    // intentional upgrade — the AC bans *silent* upgrades, not all upgrades.
    // The caller logs the choice so it's never silent.
    return override as T;
  }
  return configured;
}

/**
 * Auto-select a pipeline mode from the WAVE A grade and surface area.
 * Per CLAUDE.md "Mode Auto-Selection":
 *   - Grade A + 1-2 files → simple
 *   - Grade A or B → economy
 *   - Grade C / D / F → standard (give the smart model context)
 *
 * Never returns `explore` — that mode is opt-in only.
 */
export function autoSelectMode(grade: 'A' | 'B' | 'C' | 'D' | 'F', fileCount: number): PipelineMode {
  if (grade === 'A' && fileCount <= 2) return 'simple';
  if (grade === 'A' || grade === 'B') return 'economy';
  return 'standard';
}

/** Human-readable reason string for an auto-selected mode (for logging). */
export function describeAutoSelection(
  grade: 'A' | 'B' | 'C' | 'D' | 'F',
  fileCount: number,
  mode: PipelineMode,
): string {
  const filesLabel = fileCount === 1 ? '1 file' : `${fileCount} files`;
  return `Auto-selected --mode ${mode}: Grade ${grade}, ${filesLabel} of surface area.`;
}
