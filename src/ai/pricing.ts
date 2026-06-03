/**
 * Runtime-neutral USD pricing table for kova-spawned wave agents.
 *
 * Why this lives here (issue #313): kova trusts `msg.usage.cost.total` from
 * pi-ai's streaming events. That couples cost accounting to pi-ai's
 * `Model.cost` shape and to whatever `calculateCost(model, usage)` returns.
 * Concrete leaks:
 *
 *   1. Router-mode reports $0 because `router.ts` stubs `cost` to zeros.
 *   2. Pi-ai's `Model.cost.cacheWrite` is a single static number per model;
 *      Anthropic actually charges 1.25× input for 5-min cache writes and
 *      2.0× for 1-hour writes (#297 will engage long retention).
 *   3. A future Claude-Code-SDK / claude-CLI runtime path (NEW-13) emits only
 *      token counts and expects the caller to price them — no `cost` object.
 *
 * This module is the single source of truth for USD pricing. It is keyed on
 * pi-ai model ids (the bare `model.id` string, not the `provider:id` round-
 * trip form), aliases the common region/Bedrock prefixes, and exposes a
 * retention-aware `priceUsage(modelId, usage)` that callers use instead of
 * reading `msg.usage.cost.total`.
 *
 * Numbers come from pi-ai's `models.generated.js` and Anthropic's published
 * pricing as of 2026-06. The unit test `pricing.test.ts` regression-guards
 * the formula against pi-ai's `calculateCost` for sonnet 4.6 within float
 * epsilon — if pi-ai drifts (or this table drifts), CI catches it.
 */

import { isLocalProvider, parseModelSpec } from './models.js';

/** USD per million tokens (Mtok). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute retention (Anthropic default — input × 1.25). */
  cacheWrite5m: number;
  /** 1-hour retention (Anthropic — input × 2.0). #297 calls this "long". */
  cacheWrite1h: number;
}

/** Token usage emitted by a runtime. `cost.total` is intentionally NOT
 *  required — pricing must work for runtimes that only know token counts
 *  (e.g. the future claude-CLI path). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheRetention?: '5m' | '1h';
}

// --- Pricing table (USD per Mtok) ---
//
// Anchored on the model ids that flow through wave-executor: `DEFAULT_MODELS`
// in models.ts (claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-6)
// plus the alias families pi-ai itself defines. Adding a new model = one row.

const HAIKU_4_5: ModelPricing = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.0,
};

const SONNET_4_X: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6.0,
};

const OPUS_4_5_X: ModelPricing = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10.0,
};

const OPUS_LEGACY: ModelPricing = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheWrite5m: 18.75,
  cacheWrite1h: 30.0,
};

/** Exact-id pricing. Lookup goes here first; alias resolution is a fallback. */
const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Haiku 4.5
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  // Sonnet 4.x — all aliased to the 4-6 row because pi-ai itself bills them
  // identically. Diverge into separate rows if/when Anthropic differentiates.
  'claude-sonnet-4-6': SONNET_4_X,
  'claude-sonnet-4-5': SONNET_4_X,
  'claude-sonnet-4-5-20250929': SONNET_4_X,
  'claude-sonnet-4-0': SONNET_4_X,
  // Opus 4.5 / 4.6 (the cheaper Opus generation)
  'claude-opus-4-6': OPUS_4_5_X,
  'claude-opus-4-5': OPUS_4_5_X,
  'claude-opus-4-5-20251101': OPUS_4_5_X,
  // Opus 4.0 / 4.1 (the older, pricier Opus rows pi-ai still maps to)
  'claude-opus-4-1': OPUS_LEGACY,
  'claude-opus-4-1-20250805': OPUS_LEGACY,
  'claude-opus-4-0': OPUS_LEGACY,
  'claude-opus-4-20250514': OPUS_LEGACY,
};

/** Region / cross-account prefixes (Bedrock + Anthropic enterprise). Stripped
 *  before lookup so `eu.anthropic.claude-sonnet-4-6` resolves to the base row.
 *  Order matters: try the longest prefix first so `global.anthropic.` matches
 *  before the bare `anthropic.` substring. */
const REGION_PREFIXES: readonly string[] = [
  'global.anthropic.',
  'us.anthropic.',
  'eu.anthropic.',
  'apac.anthropic.',
  'anthropic.',
];

/** Strip a region/Bedrock prefix from a model id, returning the bare id pi-ai
 *  knows. Returns the input unchanged when no known prefix matches. */
function stripRegionPrefix(modelId: string): string {
  for (const prefix of REGION_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      return modelId.slice(prefix.length);
    }
  }
  return modelId;
}

/** Look up pricing for a model id. Returns `undefined` for unknown ids so
 *  callers can branch (local providers → 0, unknown → warn + 0). Aliases
 *  region prefixes to the base anthropic.* row. */
export function getPricing(modelId: string): ModelPricing | undefined {
  // Try exact match first (most common path).
  const direct = PRICING[modelId];
  if (direct) return direct;
  // Then try after stripping known region prefixes.
  const stripped = stripRegionPrefix(modelId);
  if (stripped !== modelId) {
    return PRICING[stripped];
  }
  return undefined;
}

// Warn-once cache to avoid log spam when an unknown model id appears on every
// turn. Module-scoped so it persists across calls within a process. Reset hook
// for tests is exposed below.
const warnedUnknown = new Set<string>();

/** Test-only: reset the warn-once cache. Not exported through index.ts.
 *  Marked as `__` to make the intent obvious. */
export function __resetWarnCache(): void {
  warnedUnknown.clear();
}

/** Detect whether a model string refers to a local provider — the local-
 *  provider list is the source of truth in `models.ts`. We accept either
 *  `provider:modelId` (the round-trip form) or a bare modelId. Bare ids that
 *  look like a known provider colon-prefix get parsed; otherwise we fall back
 *  to provider extraction via `parseModelSpec`. */
function isLocalModelId(modelString: string): boolean {
  const colonIndex = modelString.indexOf(':');
  if (colonIndex > 0) {
    const prefix = modelString.slice(0, colonIndex);
    if (isLocalProvider(prefix)) return true;
  }
  // No colon — defer to parseModelSpec, which is conservative and will return
  // `anthropic` for anything it doesn't recognize. That's fine — we only care
  // about positive local-provider matches here.
  const { provider } = parseModelSpec(modelString);
  return isLocalProvider(provider);
}

/** Strip an optional `provider:` prefix so callers can pass either a bare
 *  model id or the round-trip `provider:id` form. */
function bareModelId(modelString: string): string {
  const colonIndex = modelString.indexOf(':');
  return colonIndex > 0 ? modelString.slice(colonIndex + 1) : modelString;
}

/** Price token usage in USD using the kova-owned pricing table.
 *
 *  - Local providers (`ollama`, `lmstudio`, `vllm`, `llamacpp`, `llamafile`,
 *    `llama-cpp`) bypass the table and return 0 — no API cost is incurred.
 *  - Unknown anthropic model ids return 0 with a single `console.warn` per
 *    id (no throw — we never want a pricing miss to kill a wave).
 *  - `cacheRetention` defaults to `'5m'` (Anthropic's default). Pass `'1h'`
 *    once #297 engages long retention so the cache-write line is priced at
 *    2.0× input instead of 1.25×.
 *
 *  Formula mirrors pi-ai's `calculateCost`:
 *    cost = sum( (rate / 1_000_000) * tokens )
 *  This is regression-tested in `pricing.test.ts` against pi-ai for sonnet 4.6.
 */
export function priceUsage(modelId: string, usage: TokenUsage): number {
  if (isLocalModelId(modelId)) return 0;

  const id = bareModelId(modelId);
  const pricing = getPricing(id);
  if (!pricing) {
    if (!warnedUnknown.has(id)) {
      warnedUnknown.add(id);
      // Use console.warn directly (not `log` from utils) so this module stays
      // dependency-light — it's intended to be safe to import from any layer.
      // Format includes "unknown pricing" so the test's filter can find it.
      console.warn(`[pricing] unknown pricing for model id "${id}"; treating cost as $0`);
    }
    return 0;
  }

  const retention = usage.cacheRetention ?? '5m';
  const cacheWriteRate = retention === '1h' ? pricing.cacheWrite1h : pricing.cacheWrite5m;

  const inputCost = (pricing.input / 1_000_000) * usage.input;
  const outputCost = (pricing.output / 1_000_000) * usage.output;
  const cacheReadCost = (pricing.cacheRead / 1_000_000) * usage.cacheRead;
  const cacheWriteCost = (cacheWriteRate / 1_000_000) * usage.cacheWrite;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
