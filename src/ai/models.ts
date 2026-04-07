import { getModel, type Model } from '@mariozechner/pi-ai';
import type { ModelTier } from '../types/index.js';
import { KovaError } from './errors.js';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  large: 'claude-opus-4-6',
};

export type { Model };

export function resolveModel(tier: ModelTier = 'medium'): Model<string> {
  const modelId = resolveModelId(tier);
  // modelId may come from env vars, so cast to satisfy getModel's union type
  const model = getModel('anthropic', modelId as Parameters<typeof getModel>[1]);
  if (!model) {
    throw new KovaError(`Unknown model: ${modelId} (tier=${tier})`, 'config', false);
  }
  return model;
}

function resolveModelId(tier: ModelTier): string {
  switch (tier) {
    case 'small':
      return process.env.KOVA_SMALL_MODEL ?? DEFAULT_MODELS.small;
    case 'large':
      return process.env.KOVA_LARGE_MODEL ?? DEFAULT_MODELS.large;
    default:
      return process.env.KOVA_MEDIUM_MODEL ?? DEFAULT_MODELS.medium;
  }
}
