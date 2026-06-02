// Ollama provider — runs waves on local models via Ollama's OpenAI-compatible API.
// Models are registered as `openai-completions` with baseUrl pointing to Ollama's /v1 endpoint,
// so pi-ai's existing OpenAI completions streaming handles the actual HTTP calls.

import type { Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Default tier → Ollama model mappings. */
export const OLLAMA_TIER_DEFAULTS: Readonly<Record<string, string>> = {
  medium: 'qwen2.5-coder:32b',
  small: 'qwen2.5-coder:7b',
};

/** Context window sizes for known Ollama models. */
const OLLAMA_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'qwen2.5-coder:32b': 32768,
  'qwen2.5-coder:7b': 32768,
  'llama3.1:8b': 131072,
  'llama3.1:70b': 131072,
  'llama3.3:70b': 131072,
  'codellama:34b': 16384,
  'deepseek-coder-v2:16b': 128000,
};

const DEFAULT_CONTEXT_WINDOW = 32768;

/** Models known to support OpenAI-compatible function calling via Ollama. */
const TOOL_CAPABLE_MODELS = new Set([
  'qwen2.5-coder:32b',
  'qwen2.5-coder:7b',
  'llama3.1:8b',
  'llama3.1:70b',
  'llama3.3:70b',
]);

/** Compat settings for Ollama's OpenAI-compatible endpoint. */
const OLLAMA_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens',
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsStrictMode: false,
};

/** Ollama base URL — respects `KOVA_OLLAMA_URL` env var. */
export function getOllamaBaseUrl(): string {
  return process.env.KOVA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
}

/** Detect whether Ollama is running by hitting its version endpoint. */
export async function detectOllama(): Promise<boolean> {
  const baseUrl = getOllamaBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

/** List locally available Ollama models via the /api/tags endpoint. */
export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const baseUrl = getOllamaBaseUrl();
  const response = await fetch(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Failed to list Ollama models: ${response.statusText}`);
  }
  const data = (await response.json()) as {
    models: Array<{ name: string; size: number; modified_at: string }>;
  };
  return data.models.map((m) => ({
    name: m.name,
    size: m.size,
    modifiedAt: m.modified_at,
  }));
}

/** Create a pi-ai Model object for an Ollama model using the OpenAI-compatible API. */
export function createOllamaModel(modelId: string): Model<'openai-completions'> {
  const baseUrl = getOllamaBaseUrl();
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: `${baseUrl}/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: OLLAMA_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: 8192,
    compat: OLLAMA_COMPAT,
  };
}

/** Check if a provider string identifies Ollama. */
export function isOllamaProvider(provider: string): boolean {
  return provider === 'ollama';
}

/** Check if an Ollama model supports function calling. */
export function isToolCapable(modelId: string): boolean {
  return TOOL_CAPABLE_MODELS.has(modelId);
}

/** Dummy API key for Ollama — required by OpenAI client but not validated by Ollama. */
export function resolveOllamaApiKey(): string {
  return 'ollama';
}
