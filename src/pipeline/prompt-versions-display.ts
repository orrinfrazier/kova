// Display formatters for prompt version history and correlation stats.

import type { PromptVersion } from '../memory/prompt-versions.js';
import type { ABTestVariantStats, PromptVersionStats } from '../telemetry/prompt-correlation.js';
import { AB_TEST_MIN_RUNS } from '../telemetry/prompt-correlation.js';

export type { ABTestVariantStats, PromptVersionStats };

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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

/** Format A/B test variant stats as a readable table with significance flags. */
export function formatABTestStats(stats: ABTestVariantStats[]): string {
  if (stats.length === 0) return 'No A/B test data available.';

  const lines: string[] = [
    '| Wave       | Variant    | Runs | Success  | Avg Cost | Avg Duration | Status      |',
    '|------------|------------|------|----------|----------|--------------|-------------|',
  ];

  for (const s of stats) {
    const status = s.sufficient ? 'sufficient' : `<${AB_TEST_MIN_RUNS} runs`;
    lines.push(
      `| ${s.wave.padEnd(10)} | ${s.variant.padEnd(10)} | ${String(s.runs).padStart(4)} | ${`${s.successRate.toFixed(1)}%`.padStart(8)} | ${`$${s.avgCost.toFixed(2)}`.padStart(8)} | ${formatDuration(s.avgDuration).padStart(12)} | ${status.padEnd(11)} |`,
    );
  }

  // Add recommendation section if any wave has sufficient data for all variants
  const waveGroups = new Map<string, ABTestVariantStats[]>();
  for (const s of stats) {
    const group = waveGroups.get(s.wave) ?? [];
    group.push(s);
    waveGroups.set(s.wave, group);
  }

  const recommendations: string[] = [];
  for (const [wave, variants] of waveGroups) {
    if (variants.every((v) => v.sufficient)) {
      const best = variants.reduce((a, b) => (a.successRate > b.successRate ? a : b));
      recommendations.push(`  ${wave}: "${best.variant}" leads with ${best.successRate.toFixed(1)}% success rate`);
    }
  }

  if (recommendations.length > 0) {
    lines.push('', 'Recommendations (variants with sufficient data):');
    lines.push(...recommendations);
  }

  return lines.join('\n');
}
