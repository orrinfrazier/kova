import type { ModelTier } from '../types/index.js';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  large: 'claude-opus-4-6',
};

export function resolveModel(tier: ModelTier = 'medium'): string {
  switch (tier) {
    case 'small':
      return process.env.KOVA_SMALL_MODEL ?? DEFAULT_MODELS.small;
    case 'large':
      return process.env.KOVA_LARGE_MODEL ?? DEFAULT_MODELS.large;
    default:
      return process.env.KOVA_MEDIUM_MODEL ?? DEFAULT_MODELS.medium;
  }
}
