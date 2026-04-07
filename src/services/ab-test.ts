// A/B test variant selection — randomly selects prompt variants per run
// and tracks selections for correlation with success rates.

import type { ABTestConfig } from '../types/index.js';

/** Selected variants for a single run, keyed by wave name. */
export type VariantSelection = Record<string, string>;

/**
 * Select a random variant for each wave configured in ab_test.
 * Uses Math.random() for uniform selection across variants.
 */
export function selectVariants(abTest: ABTestConfig): VariantSelection {
  const selection: VariantSelection = {};
  for (const [wave, variants] of Object.entries(abTest)) {
    if (!variants || variants.length === 0) continue;
    const index = Math.floor(Math.random() * variants.length);
    const picked = variants[index];
    if (picked != null) {
      selection[wave] = picked;
    }
  }
  return selection;
}

/**
 * Resolve the prompt file name for a wave given A/B test selections.
 * Returns the variant file name (e.g., "assess.v2.md") if a variant is selected,
 * or undefined if no variant is selected for this wave.
 */
export function variantFileName(wave: string, variant: string): string {
  return `${wave}.${variant}.md`;
}
