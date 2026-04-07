import { describe, expect, it } from 'vitest';
import type { PromptVersion } from './prompt-versions.js';
import { formatPromptCorrelation, formatPromptHistory, type PromptVersionStats } from './prompt-versions-display.js';

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
