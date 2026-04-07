// Prompt version correlation — group history entries by prompt hash and compute success rates.
// Also supports A/B test variant correlation.

import type { HistoryEntry } from './history.js';

export interface PromptVersionStats {
  runs: number;
  successRate: number;
  avgCost: number;
}

export interface ABTestVariantStats {
  wave: string;
  variant: string;
  runs: number;
  successes: number;
  successRate: number;
  avgCost: number;
  avgDuration: number;
  sufficient: boolean;
}

/** Minimum runs per variant before drawing conclusions. */
export const AB_TEST_MIN_RUNS = 10;

/**
 * Correlate history entries by prompt version.
 * Returns a map of "wave:hash" → stats (runs, success rate, avg cost).
 * Entries without promptHashes are skipped.
 */
export function correlateByPromptVersion(entries: HistoryEntry[]): Map<string, PromptVersionStats> {
  const groups = new Map<string, { outcomes: string[]; costs: number[] }>();

  for (const entry of entries) {
    if (!entry.promptHashes) continue;

    for (const [wave, hash] of Object.entries(entry.promptHashes)) {
      const key = `${wave}:${hash}`;
      let group = groups.get(key);
      if (!group) {
        group = { outcomes: [], costs: [] };
        groups.set(key, group);
      }
      group.outcomes.push(entry.outcome);
      group.costs.push(entry.cost);
    }
  }

  const result = new Map<string, PromptVersionStats>();
  for (const [key, group] of groups) {
    const runs = group.outcomes.length;
    const successes = group.outcomes.filter((o) => o === 'success').length;
    const successRate = (successes / runs) * 100;
    const avgCost = group.costs.reduce((sum, c) => sum + c, 0) / runs;
    result.set(key, { runs, successRate, avgCost });
  }

  return result;
}

/**
 * Correlate history entries by A/B test variant.
 * Returns stats per wave+variant pair, with a `sufficient` flag based on AB_TEST_MIN_RUNS.
 * Entries without abTestVariants are skipped.
 */
export function correlateByABTestVariant(entries: HistoryEntry[]): ABTestVariantStats[] {
  const groups = new Map<string, { outcomes: string[]; costs: number[]; durations: number[] }>();

  for (const entry of entries) {
    if (!entry.abTestVariants) continue;

    for (const [wave, variant] of Object.entries(entry.abTestVariants)) {
      const key = `${wave}:${variant}`;
      let group = groups.get(key);
      if (!group) {
        group = { outcomes: [], costs: [], durations: [] };
        groups.set(key, group);
      }
      group.outcomes.push(entry.outcome);
      group.costs.push(entry.cost);
      group.durations.push(entry.duration);
    }
  }

  const results: ABTestVariantStats[] = [];
  for (const [key, group] of groups) {
    const [wave, variant] = key.split(':') as [string, string];
    const runs = group.outcomes.length;
    const successes = group.outcomes.filter((o) => o === 'success').length;
    const successRate = runs > 0 ? (successes / runs) * 100 : 0;
    const avgCost = runs > 0 ? group.costs.reduce((sum, c) => sum + c, 0) / runs : 0;
    const avgDuration = runs > 0 ? group.durations.reduce((sum, d) => sum + d, 0) / runs : 0;

    results.push({
      wave,
      variant,
      runs,
      successes,
      successRate,
      avgCost,
      avgDuration,
      sufficient: runs >= AB_TEST_MIN_RUNS,
    });
  }

  // Sort by wave then variant for stable output
  results.sort((a, b) => a.wave.localeCompare(b.wave) || a.variant.localeCompare(b.variant));
  return results;
}
