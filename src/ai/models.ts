import { getModel, getProviders, type Model, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import type { ModelTier } from '../types/index.js';
import { KovaError } from './errors.js';

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

let _knownProviders: Set<string> | undefined;
function knownProviders(): Set<string> {
  if (!_knownProviders) {
    ensureProviders();
    _knownProviders = new Set(getProviders());
  }
  return _knownProviders;
}

export function parseModelSpec(modelString: string): ModelSpec {
  const colonIndex = modelString.indexOf(':');
  if (colonIndex > 0) {
    const candidate = modelString.slice(0, colonIndex);
    if (knownProviders().has(candidate)) {
      return { provider: candidate, modelId: modelString.slice(colonIndex + 1) };
    }
  }
  // No recognized provider prefix — default to anthropic
  return { provider: 'anthropic', modelId: modelString };
}

export function resolveModelFromString(modelString: string): Model<string> {
  ensureProviders();
  const { provider, modelId } = parseModelSpec(modelString);
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
