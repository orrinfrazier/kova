// Display formatters for prompt version history and correlation stats.

import type { PromptVersionStats } from './prompt-correlation.js';
import type { PromptVersion } from './prompt-versions.js';

export type { PromptVersionStats };

/** Format prompt version history as a readable table. */
export function formatPromptHistory(versions: PromptVersion[]): string {
  if (versions.length === 0) return 'No prompt versions recorded.';

  const lines: string[] = ['| Date       | Wave       | Hash         |', '|------------|------------|--------------|'];

  for (const v of versions) {
    const date = v.timestamp.slice(0, 10);
    lines.push(`| ${date} | ${v.wave.padEnd(10)} | ${v.hash} |`);
  }

  return lines.join('\n');
}

/** Format prompt correlation stats as a readable table. */
export function formatPromptCorrelation(stats: Map<string, PromptVersionStats>): string {
  if (stats.size === 0) return 'No prompt correlation data available.';

  const lines: string[] = [
    '| Wave       | Hash         | Runs | Success  | Avg Cost |',
    '|------------|--------------|------|----------|----------|',
  ];

  for (const [key, s] of stats) {
    const [wave, hash] = key.split(':');
    lines.push(
      `| ${(wave ?? '').padEnd(10)} | ${(hash ?? '').padEnd(12)} | ${String(s.runs).padStart(4)} | ${`${s.successRate.toFixed(1)}%`.padStart(8)} | ${`$${s.avgCost.toFixed(2)}`.padStart(8)} |`,
    );
  }

  return lines.join('\n');
}
