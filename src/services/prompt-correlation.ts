// Prompt version correlation — group history entries by prompt hash and compute success rates.

import type { HistoryEntry } from './history.js';

export interface PromptVersionStats {
  runs: number;
  successRate: number;
  avgCost: number;
}

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
