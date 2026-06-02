// Verifies the per-wave → per-run tool-call aggregation that fix.ts performs
// before writing to history.jsonl (issue #278). The aggregation logic is the
// load-bearing piece for the retrieval-quality eval harness — without it, the
// eval has nothing to compare on/off arms against.
//
// We replicate the inline aggregation block from fix.ts as a small pure
// helper here and assert the contract. fix.ts itself is exercised via the
// existing fix.test.ts mocked-pipeline tests.

import { describe, expect, it } from 'vitest';
import type { WaveResult } from '../types/index.js';

interface Aggregated {
  total: number;
  reads: number;
  byTool: Record<string, number>;
}

function aggregate(waveResults: Record<string, WaveResult | undefined>): Aggregated | undefined {
  let total = 0;
  let reads = 0;
  const byTool: Record<string, number> = {};
  let observedAny = false;
  for (const wr of Object.values(waveResults)) {
    const counts = wr?.toolCallCounts;
    if (!counts) continue;
    observedAny = true;
    total += counts.total;
    reads += counts.reads;
    for (const [name, n] of Object.entries(counts.byTool)) {
      byTool[name] = (byTool[name] ?? 0) + n;
    }
  }
  return observedAny ? { total, reads, byTool } : undefined;
}

function makeWave(counts?: WaveResult['toolCallCounts']): WaveResult {
  return {
    wave: 'impl',
    success: true,
    artifact: {},
    duration: 0,
    cost: 0,
    turns: 0,
    ...(counts != null && { toolCallCounts: counts }),
  };
}

describe('fix.ts tool-call aggregation (issue #278)', () => {
  it('returns undefined when no wave reported counts', () => {
    expect(aggregate({ assess: makeWave(), spec: makeWave() })).toBeUndefined();
  });

  it('returns aggregated counts when at least one wave reported (even zeros)', () => {
    const result = aggregate({
      assess: makeWave({ total: 0, reads: 0, byTool: {} }),
      spec: makeWave(),
    });
    expect(result).toBeDefined();
    expect(result?.total).toBe(0);
    expect(result?.reads).toBe(0);
    expect(result?.byTool).toEqual({});
  });

  it('sums totals across waves', () => {
    const result = aggregate({
      assess: makeWave({ total: 3, reads: 2, byTool: { Read: 2, Grep: 1 } }),
      spec: makeWave({ total: 5, reads: 0, byTool: { Bash: 5 } }),
      impl: makeWave({ total: 12, reads: 4, byTool: { Read: 4, Edit: 8 } }),
    });
    expect(result?.total).toBe(20);
    expect(result?.reads).toBe(6);
    expect(result?.byTool).toEqual({ Read: 6, Grep: 1, Bash: 5, Edit: 8 });
  });

  it('skips waves without counts but still aggregates the rest', () => {
    const result = aggregate({
      assess: makeWave({ total: 2, reads: 1, byTool: { Read: 1, Grep: 1 } }),
      spec: makeWave(), // no counts (legacy / mid-migration)
      impl: makeWave({ total: 3, reads: 2, byTool: { Read: 2, Edit: 1 } }),
    });
    expect(result?.total).toBe(5);
    expect(result?.reads).toBe(3);
    expect(result?.byTool).toEqual({ Read: 3, Grep: 1, Edit: 1 });
  });
});
