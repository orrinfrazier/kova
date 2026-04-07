import { getModel, getProviders, type Model, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import type { ModelTier, OllamaProvider } from '../types/index.js';
import { KovaError } from './errors.js';
import { createOllamaModel, isOllamaProvider } from './ollama.js';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  large: 'claude-opus-4-6',
};

let providersRegistered = false;

function ensureProviders(): void {
  if (!providersRegistered) {
    registerBuiltInApiProviders();
    providersRegistered = true;
  }
}

export type { Model };

export interface ModelSpec {
  provider: string;
  modelId: string;
}

// --- Custom model registry (Ollama, future local providers) ---

const customModels = new Map<string, Model<string>>();

export interface OllamaModelDef {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
}

/** Register Ollama models into the custom model registry.
 *  OLLAMA_HOST env var takes precedence over config host. */
export function registerOllamaModels(config: OllamaProvider): void {
  const host = process.env.OLLAMA_HOST ?? config.host;
  const baseUrl = `${host}/v1`;

  for (const def of config.models) {
    const model: Model<'openai-completions'> = {
      id: def.id,
      name: def.name ?? def.id,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
    };
    customModels.set(`ollama:${def.id}`, model);
  }
}

/** Clear all custom models. Primarily for test cleanup. */
export function clearCustomModels(): void {
  customModels.clear();
}

// --- Provider / model resolution ---

let _knownProviders: Set<string> | undefined;
function knownProviders(): Set<string> {
  if (!_knownProviders) {
    ensureProviders();
    _knownProviders = new Set(getProviders());
  }
  return _knownProviders;
}

export function parseModelSpec(modelString: string): ModelSpec {
  // Check custom model registry first — allows "ollama:modelId" even though
  // "ollama" isn't a known pi-mono provider
  if (customModels.has(modelString)) {
    const colonIndex = modelString.indexOf(':');
    if (colonIndex > 0) {
      return { provider: modelString.slice(0, colonIndex), modelId: modelString.slice(colonIndex + 1) };
    }
  }

  const colonIndex = modelString.indexOf(':');
  if (colonIndex > 0) {
    const candidate = modelString.slice(0, colonIndex);
    // Ollama is not a pi-ai built-in provider — handle it explicitly
    if (isOllamaProvider(candidate) || knownProviders().has(candidate)) {
      return { provider: candidate, modelId: modelString.slice(colonIndex + 1) };
    }
  }
  // No recognized provider prefix — default to anthropic
  return { provider: 'anthropic', modelId: modelString };
}

export function resolveModelFromString(modelString: string): Model<string> {
  // Check custom model registry first (Ollama, etc.)
  const custom = customModels.get(modelString);
  if (custom) return custom;

  ensureProviders();
  const { provider, modelId } = parseModelSpec(modelString);

  // Ollama models are not in pi-ai's registry — create them directly
  if (isOllamaProvider(provider)) {
    return createOllamaModel(modelId);
  }

  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
  if (!model) {
    throw new KovaError(`Unknown model: ${provider}:${modelId}`, 'config', false);
  }
  return model;
}

export function resolveModel(tier: ModelTier = 'medium'): Model<string> {
  ensureProviders();
  const modelString = resolveModelString(tier);
  return resolveModelFromString(modelString);
}

function resolveModelString(tier: ModelTier): string {
  switch (tier) {
    case 'small':
      return process.env.KOVA_SMALL_MODEL ?? DEFAULT_MODELS.small;
    case 'large':
      return process.env.KOVA_LARGE_MODEL ?? DEFAULT_MODELS.large;
    default:
      return process.env.KOVA_MEDIUM_MODEL ?? DEFAULT_MODELS.medium;
  }
}
