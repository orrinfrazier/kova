// Tests for the tool-call counter — parses per-wave tool-execution events and
// aggregates counts by tool name. Used by the retrieval-quality eval harness
// (issue #278) to measure whether injected context reduces the agent's own
// tool calls.

import { describe, expect, it } from 'vitest';
import {
  createToolCallCounter,
  emptyToolCallCounts,
  mergeToolCallCounts,
  type ToolCallCounts,
} from './tool-call-counter.js';

describe('emptyToolCallCounts', () => {
  it('returns a zero-state object', () => {
    const counts = emptyToolCallCounts();
    expect(counts.total).toBe(0);
    expect(counts.reads).toBe(0);
    expect(counts.byTool).toEqual({});
  });

  it('returns a fresh object each call (no shared state)', () => {
    const a = emptyToolCallCounts();
    const b = emptyToolCallCounts();
    a.total = 5;
    a.byTool.Read = 5;
    expect(b.total).toBe(0);
    expect(b.byTool).toEqual({});
  });
});

describe('createToolCallCounter', () => {
  it('counts a single tool call', () => {
    const counter = createToolCallCounter();
    counter.record('Read');
    const counts = counter.snapshot();
    expect(counts.total).toBe(1);
    expect(counts.byTool.Read).toBe(1);
  });

  it('counts multiple calls to the same tool', () => {
    const counter = createToolCallCounter();
    counter.record('Read');
    counter.record('Read');
    counter.record('Read');
    const counts = counter.snapshot();
    expect(counts.total).toBe(3);
    expect(counts.byTool.Read).toBe(3);
    expect(counts.reads).toBe(3);
  });

  it('counts calls across different tools', () => {
    const counter = createToolCallCounter();
    counter.record('Read');
    counter.record('Read');
    counter.record('Grep');
    counter.record('Edit');
    counter.record('Bash');
    const counts = counter.snapshot();
    expect(counts.total).toBe(5);
    expect(counts.byTool).toEqual({ Read: 2, Grep: 1, Edit: 1, Bash: 1 });
  });

  it('tracks Read count separately as the `reads` field', () => {
    // Per the issue: "Read Δ" is a first-class metric since file reads dominate
    // retrieval cost. `reads` must mirror byTool.Read exactly.
    const counter = createToolCallCounter();
    counter.record('Read');
    counter.record('Read');
    counter.record('Grep');
    const counts = counter.snapshot();
    expect(counts.reads).toBe(2);
    expect(counts.reads).toBe(counts.byTool.Read);
  });

  it('reads is zero when no Read calls happened', () => {
    const counter = createToolCallCounter();
    counter.record('Grep');
    counter.record('Bash');
    expect(counter.snapshot().reads).toBe(0);
  });

  it('ignores undefined/empty tool names defensively', () => {
    // Per runtime/types.ts: `tool_execution_start.toolName` is optional, so the
    // counter must not panic when a runtime omits it (e.g. claude-cli adapter).
    const counter = createToolCallCounter();
    counter.record(undefined);
    counter.record('');
    counter.record('Read');
    const counts = counter.snapshot();
    expect(counts.total).toBe(1);
    expect(counts.byTool.Read).toBe(1);
  });

  it('snapshot returns a fresh copy each call (no mutation surprise)', () => {
    const counter = createToolCallCounter();
    counter.record('Read');
    const snap1 = counter.snapshot();
    counter.record('Read');
    const snap2 = counter.snapshot();
    expect(snap1.total).toBe(1);
    expect(snap2.total).toBe(2);
    // Mutating snap1 must not affect counter or future snapshots.
    snap1.total = 999;
    snap1.byTool.Read = 999;
    expect(counter.snapshot().total).toBe(2);
  });
});

describe('mergeToolCallCounts', () => {
  it('merges two zero-state objects', () => {
    const merged = mergeToolCallCounts(emptyToolCallCounts(), emptyToolCallCounts());
    expect(merged.total).toBe(0);
    expect(merged.reads).toBe(0);
    expect(merged.byTool).toEqual({});
  });

  it('sums totals and per-tool counts', () => {
    const a: ToolCallCounts = { total: 3, reads: 2, byTool: { Read: 2, Grep: 1 } };
    const b: ToolCallCounts = { total: 4, reads: 1, byTool: { Read: 1, Edit: 3 } };
    const merged = mergeToolCallCounts(a, b);
    expect(merged.total).toBe(7);
    expect(merged.reads).toBe(3);
    expect(merged.byTool).toEqual({ Read: 3, Grep: 1, Edit: 3 });
  });

  it('does not mutate either input', () => {
    const a: ToolCallCounts = { total: 1, reads: 1, byTool: { Read: 1 } };
    const b: ToolCallCounts = { total: 1, reads: 0, byTool: { Grep: 1 } };
    const snapshotA = JSON.stringify(a);
    const snapshotB = JSON.stringify(b);
    mergeToolCallCounts(a, b);
    expect(JSON.stringify(a)).toBe(snapshotA);
    expect(JSON.stringify(b)).toBe(snapshotB);
  });
});
