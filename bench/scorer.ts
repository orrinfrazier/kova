// JSONL append + summary aggregation.
//
// Each fixture run is one JSON line. The summary computes pass rate,
// means, and per-wave breakdowns — keeping the wire format stable so
// downstream consumers (regression dashboards, prompt-change diffs) can
// rely on `schemaVersion`.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BenchSummary, FixtureRunResult, WaveRecord } from './types.js';

/**
 * Append a single fixture result as one JSON line to `jsonlPath`. Creates
 * parent directories on demand so callers can hand in a fresh
 * `bench/results/run-<ts>.jsonl` without prep.
 */
export async function appendResult(jsonlPath: string, result: FixtureRunResult): Promise<void> {
  await mkdir(dirname(jsonlPath), { recursive: true });
  const line = `${JSON.stringify(result)}\n`;
  await appendFile(jsonlPath, line, 'utf8');
}

/**
 * Aggregate a batch of results into a single summary. Pass rate is 0
 * on an empty list rather than NaN — `formatSummary` relies on this.
 */
export function summarize(results: FixtureRunResult[]): BenchSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  if (total === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      meanCost: 0,
      meanDurationMs: 0,
      perWaveMeans: {},
      costByFixture: {},
    };
  }

  const totalCost = results.reduce((acc, r) => acc + r.cost, 0);
  const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);

  const costByFixture: Record<string, number> = {};
  for (const r of results) {
    costByFixture[r.fixtureId] = (costByFixture[r.fixtureId] ?? 0) + r.cost;
  }

  // Per-wave: accumulate sums + counts, divide at the end so missing-wave
  // entries don't drag a wave's mean toward zero.
  const waveAccum: Record<string, { durationSum: number; costSum: number; count: number }> = {};
  for (const r of results) {
    for (const w of r.waves) {
      let slot = waveAccum[w.name];
      if (slot === undefined) {
        slot = { durationSum: 0, costSum: 0, count: 0 };
        waveAccum[w.name] = slot;
      }
      slot.durationSum += w.durationMs;
      slot.costSum += w.cost;
      slot.count += 1;
    }
  }
  const perWaveMeans: Record<string, { durationMs: number; cost: number }> = {};
  for (const [name, slot] of Object.entries(waveAccum)) {
    perWaveMeans[name] = {
      durationMs: slot.durationSum / slot.count,
      cost: slot.costSum / slot.count,
    };
  }

  return {
    total,
    passed,
    failed,
    passRate: passed / total,
    meanCost: totalCost / total,
    meanDurationMs: totalDuration / total,
    perWaveMeans,
    costByFixture,
  };
}

/** Render a `BenchSummary` as a human-readable multi-line string. */
export function formatSummary(s: BenchSummary): string {
  if (s.total === 0) {
    return 'no fixtures ran\n';
  }
  const lines: string[] = [];
  lines.push('=== kova fix-bench summary ===');
  lines.push(`pass rate: ${s.passed}/${s.total} (${(s.passRate * 100).toFixed(1)}%) — failed: ${s.failed}`);
  lines.push(`mean cost-per-fix: $${s.meanCost.toFixed(4)}`);
  lines.push(`mean duration: ${formatMs(s.meanDurationMs)}`);
  lines.push('');
  lines.push('per-fixture cost:');
  for (const [id, cost] of Object.entries(s.costByFixture)) {
    lines.push(`  ${id}: $${cost.toFixed(4)}`);
  }
  if (Object.keys(s.perWaveMeans).length > 0) {
    lines.push('');
    lines.push('per-wave mean timing:');
    for (const [name, w] of Object.entries(s.perWaveMeans)) {
      lines.push(`  ${name}: ${formatMs(w.durationMs)} @ $${w.cost.toFixed(4)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

/** Re-export for harness callers that only want the wave-record shape. */
export type { WaveRecord };
