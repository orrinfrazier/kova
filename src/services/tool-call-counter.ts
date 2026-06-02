// Per-wave tool-call counter (issue #278).
//
// Captures the agent's own tool calls (Read, Grep, Edit, Bash, …) so the
// retrieval-quality eval harness can answer "does injected codebase context
// actually reduce the agent's tool calls?". Each spawnWaveAgent run can
// instantiate a counter, wire it to the `tool_execution_start` runtime event,
// and surface the aggregated counts on the returned handoff.
//
// Pure data structure + tiny accumulator — no I/O, no side effects.

/** Aggregated tool-call telemetry for a single wave (or merged across waves). */
export interface ToolCallCounts {
  /** Total tool calls observed in this scope. */
  total: number;
  /**
   * Convenience field: total Read tool calls. Mirrors `byTool.Read ?? 0`.
   * Surfaced as a first-class metric because file reads dominate retrieval
   * cost — the eval harness primarily measures the Read delta.
   */
  reads: number;
  /** Per-tool-name counts. Keys are tool names as reported by the runtime. */
  byTool: Record<string, number>;
}

/** Construct a fresh zero-state {@link ToolCallCounts} object. */
export function emptyToolCallCounts(): ToolCallCounts {
  return { total: 0, reads: 0, byTool: {} };
}

/** Live counter handle returned by {@link createToolCallCounter}. */
export interface ToolCallCounter {
  /**
   * Record one tool-call event. `toolName` may be undefined when the runtime
   * does not surface a name (e.g. some claude-cli events) — those are skipped
   * silently so the counter stays defensive in production.
   */
  record(toolName: string | undefined): void;
  /** Return a fresh snapshot of the current counts. */
  snapshot(): ToolCallCounts;
}

/**
 * Create a per-wave tool-call counter.
 *
 * `record(toolName)` is the only mutator. `snapshot()` returns a deep copy so
 * callers can mutate the result without disturbing future increments.
 */
export function createToolCallCounter(): ToolCallCounter {
  let total = 0;
  let reads = 0;
  const byTool: Record<string, number> = {};

  return {
    record(toolName) {
      if (toolName == null || toolName === '') return;
      total += 1;
      byTool[toolName] = (byTool[toolName] ?? 0) + 1;
      if (toolName === 'Read') reads += 1;
    },
    snapshot() {
      return { total, reads, byTool: { ...byTool } };
    },
  };
}

/**
 * Sum two {@link ToolCallCounts} objects. Used by the eval harness when
 * aggregating across many history entries. Pure — does not mutate either input.
 */
export function mergeToolCallCounts(a: ToolCallCounts, b: ToolCallCounts): ToolCallCounts {
  const merged: Record<string, number> = { ...a.byTool };
  for (const [name, count] of Object.entries(b.byTool)) {
    merged[name] = (merged[name] ?? 0) + count;
  }
  return {
    total: a.total + b.total,
    reads: a.reads + b.reads,
    byTool: merged,
  };
}
