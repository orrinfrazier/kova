// Scorer tests: JSONL append + summary aggregation.
// Verifies appendResult is line-by-line JSON; summarize computes correct
// aggregates and survives missing wave entries.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendResult, formatSummary, summarize } from '../scorer.js';
import type { FixtureRunResult } from '../types.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'kova-bench-scorer-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeResult(overrides: Partial<FixtureRunResult> = {}): FixtureRunResult {
  return {
    fixtureId: 'f1',
    passed: true,
    durationMs: 1000,
    cost: 0.5,
    waves: [
      { name: 'assess', durationMs: 100, cost: 0.05 },
      { name: 'impl', durationMs: 800, cost: 0.4 },
    ],
    schemaVersion: 1,
    ...overrides,
  };
}

describe('appendResult', () => {
  it('writes a single JSON line to the file', async () => {
    const path = join(workdir, 'results', 'run.jsonl');
    const result = makeResult();
    await appendResult(path, result);

    const content = await readFile(path, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(content.trim())).toEqual(result);
  });

  it('appends without clobbering existing lines', async () => {
    const path = join(workdir, 'run.jsonl');
    await appendResult(path, makeResult({ fixtureId: 'f1' }));
    await appendResult(path, makeResult({ fixtureId: 'f2', passed: false, cost: 0.2 }));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).fixtureId).toBe('f1');
    expect(JSON.parse(lines[1]!).fixtureId).toBe('f2');
  });

  it('creates parent directories on demand', async () => {
    const path = join(workdir, 'a', 'b', 'c', 'run.jsonl');
    await appendResult(path, makeResult());
    const content = await readFile(path, 'utf8');
    expect(content).toBeTruthy();
  });
});

describe('summarize', () => {
  it('returns zeros when given an empty list', () => {
    const summary = summarize([]);
    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.meanCost).toBe(0);
    expect(summary.meanDurationMs).toBe(0);
  });

  it('computes pass rate, means, and per-fixture cost across results', () => {
    const results: FixtureRunResult[] = [
      makeResult({ fixtureId: 'a', passed: true, cost: 0.4, durationMs: 1000 }),
      makeResult({ fixtureId: 'b', passed: false, cost: 0.6, durationMs: 2000 }),
      makeResult({ fixtureId: 'c', passed: true, cost: 0.5, durationMs: 1500 }),
    ];
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3, 5);
    expect(s.meanCost).toBeCloseTo(1.5 / 3, 5);
    expect(s.meanDurationMs).toBeCloseTo(4500 / 3, 5);
    expect(s.costByFixture.a).toBeCloseTo(0.4, 5);
    expect(s.costByFixture.b).toBeCloseTo(0.6, 5);
  });

  it('averages per-wave timing across results that share wave names', () => {
    const results: FixtureRunResult[] = [
      makeResult({
        waves: [
          { name: 'assess', durationMs: 100, cost: 0 },
          { name: 'impl', durationMs: 200, cost: 0 },
        ],
      }),
      makeResult({
        waves: [
          { name: 'assess', durationMs: 300, cost: 0 },
          { name: 'impl', durationMs: 400, cost: 0 },
        ],
      }),
    ];
    const s = summarize(results);
    expect(s.perWaveMeans.assess?.durationMs).toBeCloseTo(200, 5);
    expect(s.perWaveMeans.impl?.durationMs).toBeCloseTo(300, 5);
  });

  it('handles results with missing or partial wave entries', () => {
    const results: FixtureRunResult[] = [
      makeResult({
        waves: [{ name: 'assess', durationMs: 100, cost: 0 }],
      }),
      makeResult({
        waves: [
          { name: 'assess', durationMs: 200, cost: 0 },
          { name: 'impl', durationMs: 500, cost: 0 },
        ],
      }),
    ];
    const s = summarize(results);
    expect(s.perWaveMeans.assess?.durationMs).toBeCloseTo(150, 5);
    expect(s.perWaveMeans.impl?.durationMs).toBeCloseTo(500, 5);
  });
});

describe('formatSummary', () => {
  it('returns a multiline string containing pass-rate and per-fixture rows', () => {
    const s = summarize([makeResult({ fixtureId: 'a', passed: true }), makeResult({ fixtureId: 'b', passed: false })]);
    const text = formatSummary(s);
    expect(text).toContain('pass rate');
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('renders gracefully for an empty summary', () => {
    const text = formatSummary(summarize([]));
    expect(text).toContain('no fixtures');
  });
});
