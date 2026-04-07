import { describe, expect, it } from 'vitest';
import type { ABTestVariantStats } from './prompt-correlation.js';
import type { PromptVersion } from './prompt-versions.js';
import {
  formatABTestStats,
  formatPromptCorrelation,
  formatPromptHistory,
  type PromptVersionStats,
} from './prompt-versions-display.js';

describe('formatPromptHistory', () => {
  it('returns a message when no versions exist', () => {
    const table = formatPromptHistory([]);
    expect(table).toContain('No prompt versions');
  });

  it('formats version entries as a readable table', () => {
    const versions: PromptVersion[] = [
      { wave: 'assess', hash: 'abc123def456', timestamp: '2026-01-15T10:00:00.000Z' },
      { wave: 'spec', hash: 'xyz789uvw012', timestamp: '2026-01-16T11:00:00.000Z' },
    ];

    const table = formatPromptHistory(versions);
    expect(table).toContain('assess');
    expect(table).toContain('abc123def456');
    expect(table).toContain('2026-01-15');
    expect(table).toContain('spec');
  });
});

describe('formatPromptCorrelation', () => {
  it('returns a message when no correlations exist', () => {
    const table = formatPromptCorrelation(new Map());
    expect(table).toContain('No prompt correlation');
  });

  it('formats correlation stats as a readable table', () => {
    const stats = new Map<string, PromptVersionStats>([
      ['assess:abc123', { runs: 10, successRate: 80, avgCost: 0.5 }],
      ['assess:def456', { runs: 5, successRate: 40, avgCost: 1.2 }],
    ]);

    const table = formatPromptCorrelation(stats);
    expect(table).toContain('assess');
    expect(table).toContain('abc123');
    expect(table).toContain('80.0%');
    expect(table).toContain('40.0%');
    expect(table).toContain('$0.50');
  });
});

describe('formatABTestStats', () => {
  it('returns a message when no stats available', () => {
    const table = formatABTestStats([]);
    expect(table).toContain('No A/B test data');
  });

  it('formats variant stats as a readable table', () => {
    const stats: ABTestVariantStats[] = [
      {
        wave: 'assess',
        variant: 'v1',
        runs: 15,
        successes: 12,
        successRate: 80,
        avgCost: 0.5,
        avgDuration: 90000,
        sufficient: true,
      },
      {
        wave: 'assess',
        variant: 'v2',
        runs: 5,
        successes: 2,
        successRate: 40,
        avgCost: 0.8,
        avgDuration: 120000,
        sufficient: false,
      },
    ];

    const table = formatABTestStats(stats);
    expect(table).toContain('assess');
    expect(table).toContain('v1');
    expect(table).toContain('v2');
    expect(table).toContain('80.0%');
    expect(table).toContain('40.0%');
    expect(table).toContain('sufficient');
    expect(table).toContain('<10 runs');
  });

  it('includes recommendations when all variants have sufficient data', () => {
    const stats: ABTestVariantStats[] = [
      {
        wave: 'assess',
        variant: 'v1',
        runs: 15,
        successes: 12,
        successRate: 80,
        avgCost: 0.5,
        avgDuration: 90000,
        sufficient: true,
      },
      {
        wave: 'assess',
        variant: 'v2',
        runs: 10,
        successes: 5,
        successRate: 50,
        avgCost: 0.8,
        avgDuration: 120000,
        sufficient: true,
      },
    ];

    const table = formatABTestStats(stats);
    expect(table).toContain('Recommendations');
    expect(table).toContain('"v1" leads');
  });

  it('omits recommendations when not all variants have sufficient data', () => {
    const stats: ABTestVariantStats[] = [
      {
        wave: 'assess',
        variant: 'v1',
        runs: 15,
        successes: 12,
        successRate: 80,
        avgCost: 0.5,
        avgDuration: 90000,
        sufficient: true,
      },
      {
        wave: 'assess',
        variant: 'v2',
        runs: 3,
        successes: 1,
        successRate: 33.3,
        avgCost: 0.8,
        avgDuration: 120000,
        sufficient: false,
      },
    ];

    const table = formatABTestStats(stats);
    expect(table).not.toContain('Recommendations');
  });
});
