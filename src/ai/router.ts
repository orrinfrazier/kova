// Router provider — proxies LLM requests through claude-code-router.
// The router accepts Anthropic API format and routes to any backend provider.
// Controlled by ANTHROPIC_BASE_URL (proxy endpoint) and ROUTER_DEFAULT (model selection).

import type { Model } from '@mariozechner/pi-ai';

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

/** Create a pi-ai Model object for a router-proxied model using the Anthropic messages API. */
export function createRouterModel(modelId?: string): Model<'anthropic-messages'> {
  const baseUrl = getRouterBaseUrl() ?? DEFAULT_ROUTER_URL;

  // Parse the model ID — if it contains a provider prefix, extract just the model part
  let resolvedId: string;
  if (modelId) {
    const colonIndex = modelId.indexOf(':');
    resolvedId = colonIndex > 0 ? modelId.slice(colonIndex + 1) : modelId;
  } else {
    const defaultModel = getRouterDefaultModel();
    const colonIndex = defaultModel.indexOf(':');
    resolvedId = colonIndex > 0 ? defaultModel.slice(colonIndex + 1) : defaultModel;
  }

  return {
    id: resolvedId,
    name: resolvedId,
    api: 'anthropic-messages',
    provider: 'router',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

/** Resolve the API key for the router — uses ANTHROPIC_API_KEY. */
export function resolveRouterApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}
