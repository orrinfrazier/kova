// Router provider — proxies LLM requests through claude-code-router.
// The router accepts Anthropic API format and routes to any backend provider.
// Controlled by ANTHROPIC_BASE_URL (proxy endpoint) and ROUTER_DEFAULT (model selection).

import { getModel, type Model, registerBuiltInApiProviders } from '@earendil-works/pi-ai';
import { log } from '../utils/logger.js';

/** Check whether router mode is active (ANTHROPIC_BASE_URL is set). */
export function isRouterEnabled(): boolean {
  return process.env.ANTHROPIC_BASE_URL != null && process.env.ANTHROPIC_BASE_URL.length > 0;
}

/** Check if a provider string identifies the router. */
export function isRouterProvider(provider: string): boolean {
  return provider === 'router';
}

/** Get the router base URL from ANTHROPIC_BASE_URL env var. */
export function getRouterBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL;
}

/** Get the default model for the router from ROUTER_DEFAULT env var. */
export function getRouterDefaultModel(): string {
  return process.env.ROUTER_DEFAULT ?? 'anthropic:claude-sonnet-4-6';
}

const DEFAULT_ROUTER_URL = 'http://localhost:4141';

// --- Upstream pricing resolution (kova#314) ---
//
// Router-proxied requests previously carried `cost: { input: 0, output: 0, ... }`,
// which made pi-ai's `calculateCost` zero every turn and silently no-op'd the
// user-configured cost cap (`KOVA_MAX_COST_USD`). The cost report and shared
// budget tracker were also lying for the same reason. We now copy pricing from
// the upstream provider/model pair (encoded in `ROUTER_DEFAULT` or the
// per-wave model spec) so the cap, report, and tracker all see real cost.
//
// `model.provider` is intentionally kept as `'router'` — flipping it to the
// upstream provider would break `isRouterProvider()` checks and break
// `resolveApiKey()` API key routing (which depends on `'router'` to read
// ANTHROPIC_API_KEY for the proxy endpoint). Per-aggregate bucketing in
// cost-report.ts consults `getRouterUpstreamProvider(modelId)` instead.

/** Hard-coded fallback pricing table for the Anthropic family.
 *  Used when pi-ai's `getModel` cannot resolve a router target — keeps the
 *  cost cap effective for the model strings kova itself defaults to. */
const FALLBACK_PRICING: Readonly<Record<string, Model<'anthropic-messages'>['cost']>> = {
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** modelId → upstream provider mapping, populated lazily by createRouterModel.
 *  Consumed by cost-report.ts so the per-provider aggregate buckets under the
 *  upstream provider (e.g. 'anthropic') instead of 'router'. */
const UPSTREAM_PROVIDER_BY_MODEL_ID = new Map<string, string>();

/** Once-per-session flag so we don't spam the log on every router invocation. */
let unresolvedWarnEmitted = false;

let registeredProviders = false;
function ensureProvidersRegistered(): void {
  if (!registeredProviders) {
    registerBuiltInApiProviders();
    registeredProviders = true;
  }
}

/** Resolve pricing for a router target by looking up the upstream (provider, modelId)
 *  pair via pi-ai's getModel. Falls back to the hard-coded Anthropic table when
 *  pi-ai's registry is silent. Returns undefined when nothing is known — caller
 *  should log a warning and keep the cap-disabled behavior. */
function resolveUpstreamPricing(
  upstreamProvider: string | undefined,
  modelId: string,
): { cost: Model<'anthropic-messages'>['cost']; resolvedProvider: string } | undefined {
  if (upstreamProvider) {
    try {
      ensureProvidersRegistered();
      // Pi-ai is typed extremely strictly (provider/model id are unions over the
      // generated registry). We're handed runtime strings, so a cast is necessary.
      const upstream = getModel(
        upstreamProvider as Parameters<typeof getModel>[0],
        modelId as Parameters<typeof getModel>[1],
      );
      if (upstream) {
        return { cost: upstream.cost, resolvedProvider: upstreamProvider };
      }
    } catch {
      // Unknown provider/model in pi-ai — fall through to fallback table.
    }
  }
  const fallback = FALLBACK_PRICING[modelId];
  if (fallback) {
    // We have pricing without knowing the provider; we DO know everything in the
    // fallback table is anthropic-family today, so attribute accordingly. If the
    // table grows beyond anthropic this should become a per-entry tuple.
    return { cost: fallback, resolvedProvider: 'anthropic' };
  }
  return undefined;
}

/** Create a pi-ai Model object for a router-proxied model using the Anthropic messages API. */
export function createRouterModel(modelId?: string): Model<'anthropic-messages'> {
  const baseUrl = getRouterBaseUrl() ?? DEFAULT_ROUTER_URL;

  // Parse the model spec — if it contains a provider prefix, split into (provider, modelId).
  // We need the provider half to look up upstream pricing via pi-ai's getModel.
  const spec = modelId ?? getRouterDefaultModel();
  const colonIndex = spec.indexOf(':');
  const upstreamProvider = colonIndex > 0 ? spec.slice(0, colonIndex) : undefined;
  const resolvedId = colonIndex > 0 ? spec.slice(colonIndex + 1) : spec;

  // Look up real pricing from pi-ai (or fallback table) so the cost cap, report,
  // and shared budget tracker all see non-zero per-turn cost. See kova#314.
  const pricing = resolveUpstreamPricing(upstreamProvider, resolvedId);
  const cost = pricing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  if (pricing) {
    UPSTREAM_PROVIDER_BY_MODEL_ID.set(resolvedId, pricing.resolvedProvider);
  } else if (!unresolvedWarnEmitted) {
    // Once-per-session warning: cap will not enforce for this model. Tools like
    // KOVA_MAX_COST_USD and cost-report.json will report $0 cost for routed waves.
    log.warn(
      `[router] No pricing known for "${spec}" — cost cap and cost report will report $0 for this model. ` +
        `Set ROUTER_DEFAULT to a known model spec like "anthropic:claude-opus-4-6", or add the model to the fallback table in src/ai/router.ts. (kova#314)`,
    );
    unresolvedWarnEmitted = true;
  }

  return {
    id: resolvedId,
    name: resolvedId,
    api: 'anthropic-messages',
    provider: 'router',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost,
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

/** Return the upstream provider for a router-resolved modelId, if known.
 *  Used by cost-report.ts to aggregate router-proxied waves under their real
 *  provider bucket (e.g. 'anthropic') instead of 'router'. Returns undefined
 *  when the model was not resolved against pi-ai or the fallback table. */
export function getRouterUpstreamProvider(modelId: string): string | undefined {
  return UPSTREAM_PROVIDER_BY_MODEL_ID.get(modelId);
}

/** Clear the upstream-provider mapping. Primarily for test isolation. */
export function clearRouterUpstreamProviders(): void {
  UPSTREAM_PROVIDER_BY_MODEL_ID.clear();
  unresolvedWarnEmitted = false;
}

/** Resolve the API key for the router — uses ANTHROPIC_API_KEY. */
export function resolveRouterApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}
