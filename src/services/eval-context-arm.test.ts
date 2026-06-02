// Tests for the context-arm eval (issue #278) — measures whether injected
// codebase context (context-on) reduces the agent's own tool calls vs the
// context-off control arm. Reuses the AB_TEST_MIN_RUNS gate so we don't draw
// conclusions from small samples.

import { describe, expect, it } from 'vitest';
import { computeContextArmDelta, formatContextArmDelta, groupEntriesByContextArm } from './eval-context-arm.js';
import type { HistoryEntry } from './history.js';
import { AB_TEST_MIN_RUNS } from './prompt-correlation.js';

function makeEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: '2026-06-01T10:00:00.000Z',
    repo: 'test-repo',
    issues: [{ number: 1, title: 't', success: true }],
    prsCreated: 1,
    cost: 0.5,
    duration: 60000,
    outcome: 'success',
    ...overrides,
  };
}

describe('groupEntriesByContextArm', () => {
  it('returns empty buckets for empty input', () => {
    const grouped = groupEntriesByContextArm([]);
    expect(grouped.on).toEqual([]);
    expect(grouped.off).toEqual([]);
  });

  it('groups entries by contextArm field', () => {
    const entries = [
      makeEntry({ contextArm: 'on', cost: 1 }),
      makeEntry({ contextArm: 'off', cost: 2 }),
      makeEntry({ contextArm: 'on', cost: 3 }),
    ];
    const grouped = groupEntriesByContextArm(entries);
    expect(grouped.on).toHaveLength(2);
    expect(grouped.off).toHaveLength(1);
    expect(grouped.on[0]?.cost).toBe(1);
    expect(grouped.off[0]?.cost).toBe(2);
  });

  it('skips entries without contextArm (backward compat)', () => {
    const entries = [makeEntry({ contextArm: 'on' }), makeEntry({}), makeEntry({ contextArm: 'off' })];
    const grouped = groupEntriesByContextArm(entries);
    expect(grouped.on).toHaveLength(1);
    expect(grouped.off).toHaveLength(1);
  });
});

describe('computeContextArmDelta', () => {
  it('returns insufficient when no runs in either arm', () => {
    const result = computeContextArmDelta([], []);
    expect(result.sufficient).toBe(false);
    expect(result.onRuns).toBe(0);
    expect(result.offRuns).toBe(0);
  });

  it('returns insufficient when only one arm has runs below threshold', () => {
    const on: HistoryEntry[] = [];
    const off: HistoryEntry[] = [];
    for (let i = 0; i < AB_TEST_MIN_RUNS; i++) {
      on.push(
        makeEntry({
          contextArm: 'on',
          toolCallCounts: { total: 10, reads: 5, byTool: { Read: 5 } },
        }),
      );
    }
    const result = computeContextArmDelta(on, off);
    expect(result.sufficient).toBe(false);
    expect(result.onRuns).toBe(AB_TEST_MIN_RUNS);
    expect(result.offRuns).toBe(0);
  });

  it('returns insufficient when both arms below AB_TEST_MIN_RUNS', () => {
    const on = Array.from({ length: AB_TEST_MIN_RUNS - 1 }, () =>
      makeEntry({ contextArm: 'on', toolCallCounts: { total: 5, reads: 2, byTool: { Read: 2 } } }),
    );
    const off = Array.from({ length: AB_TEST_MIN_RUNS - 1 }, () =>
      makeEntry({ contextArm: 'off', toolCallCounts: { total: 10, reads: 5, byTool: { Read: 5 } } }),
    );
    const result = computeContextArmDelta(on, off);
    expect(result.sufficient).toBe(false);
  });

  it('returns sufficient and computes deltas when both arms reach AB_TEST_MIN_RUNS', () => {
    // context-on: avg 5 tool calls, 2 reads, 100% success
    // context-off: avg 10 tool calls, 5 reads, 50% success
    // Expected: toolCallsDelta = 5-10 = -5; readsDelta = 2-5 = -3; passRateDelta = 100-50 = +50
    const on = Array.from({ length: AB_TEST_MIN_RUNS }, () =>
      makeEntry({
        contextArm: 'on',
        outcome: 'success',
        toolCallCounts: { total: 5, reads: 2, byTool: { Read: 2 } },
      }),
    );
    const off: HistoryEntry[] = [];
    for (let i = 0; i < AB_TEST_MIN_RUNS; i++) {
      off.push(
        makeEntry({
          contextArm: 'off',
          outcome: i < AB_TEST_MIN_RUNS / 2 ? 'success' : 'failure',
          toolCallCounts: { total: 10, reads: 5, byTool: { Read: 5 } },
        }),
      );
    }
    const result = computeContextArmDelta(on, off);
    expect(result.sufficient).toBe(true);
    expect(result.onRuns).toBe(AB_TEST_MIN_RUNS);
    expect(result.offRuns).toBe(AB_TEST_MIN_RUNS);
    expect(result.avgToolCallsOn).toBe(5);
    expect(result.avgToolCallsOff).toBe(10);
    expect(result.toolCallsDelta).toBe(-5);
    expect(result.avgReadsOn).toBe(2);
    expect(result.avgReadsOff).toBe(5);
    expect(result.readsDelta).toBe(-3);
    expect(result.firstPassPassRateOn).toBe(100);
    expect(result.firstPassPassRateOff).toBe(50);
    expect(result.firstPassPassRateDelta).toBe(50);
  });

  it('ignores entries missing toolCallCounts when computing averages', () => {
    // Half the on-arm entries have no counts (legacy); they should be skipped
    // for the tool-call/reads average but still count toward pass-rate denominator.
    const on: HistoryEntry[] = [];
    for (let i = 0; i < AB_TEST_MIN_RUNS; i++) {
      on.push(
        makeEntry({
          contextArm: 'on',
          outcome: 'success',
          ...(i % 2 === 0 ? { toolCallCounts: { total: 4, reads: 2, byTool: { Read: 2 } } } : {}),
        }),
      );
    }
    const off = Array.from({ length: AB_TEST_MIN_RUNS }, () =>
      makeEntry({
        contextArm: 'off',
        outcome: 'success',
        toolCallCounts: { total: 8, reads: 4, byTool: { Read: 4 } },
      }),
    );
    const result = computeContextArmDelta(on, off);
    expect(result.sufficient).toBe(true);
    expect(result.avgToolCallsOn).toBe(4); // averaged over the entries that have counts
    expect(result.avgToolCallsOff).toBe(8);
    expect(result.firstPassPassRateOn).toBe(100);
  });

  it('exposes AB_TEST_MIN_RUNS in the result so callers can display the gate', () => {
    const result = computeContextArmDelta([], []);
    expect(result.minRuns).toBe(AB_TEST_MIN_RUNS);
  });
});

describe('formatContextArmDelta', () => {
  it('reports insufficient runs when below the gate', () => {
    const out = formatContextArmDelta(computeContextArmDelta([], []));
    expect(out.toLowerCase()).toContain('insufficient');
    expect(out).toContain(String(AB_TEST_MIN_RUNS));
  });

  it('renders the delta numbers when sufficient', () => {
    const on = Array.from({ length: AB_TEST_MIN_RUNS }, () =>
      makeEntry({
        contextArm: 'on',
        outcome: 'success',
        toolCallCounts: { total: 5, reads: 2, byTool: { Read: 2 } },
      }),
    );
    const off = Array.from({ length: AB_TEST_MIN_RUNS }, () =>
      makeEntry({
        contextArm: 'off',
        outcome: 'success',
        toolCallCounts: { total: 10, reads: 5, byTool: { Read: 5 } },
      }),
    );
    const out = formatContextArmDelta(computeContextArmDelta(on, off));
    // Negative delta = context-on uses fewer tool calls (good signal).
    expect(out).toContain('-5');
    expect(out).toContain('-3');
    expect(out.toLowerCase()).toContain('tool-call');
    expect(out.toLowerCase()).toContain('read');
  });
});
