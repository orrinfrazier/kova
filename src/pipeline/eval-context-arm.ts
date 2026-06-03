// Context-arm eval (issue #278) — measures whether injecting codebaseContext
// into the agent's prompts reduces the agent's own tool calls (Read, Grep,
// Edit, …) AND/OR improves first-pass pass-rate, vs the context-off control.
//
// Borrowed from codegraph's A/B matrix (docs/benchmarks/codegraph-ab-matrix.md):
// the right metric is tool-call/Read reduction, not just task success. Reuses
// the AB_TEST_MIN_RUNS gate from prompt-correlation so we don't draw
// conclusions from small samples.
//
// Pure data-reduction module — no I/O, no side effects.

import type { HistoryEntry } from '../telemetry/history.js';
import { AB_TEST_MIN_RUNS } from '../telemetry/prompt-correlation.js';

export interface ContextArmGroups {
  on: HistoryEntry[];
  off: HistoryEntry[];
}

/**
 * Partition history entries into the context-on / context-off arms.
 * Entries without a `contextArm` field are skipped (legacy / non-eval runs).
 */
export function groupEntriesByContextArm(entries: readonly HistoryEntry[]): ContextArmGroups {
  const on: HistoryEntry[] = [];
  const off: HistoryEntry[] = [];
  for (const e of entries) {
    if (e.contextArm === 'on') on.push(e);
    else if (e.contextArm === 'off') off.push(e);
  }
  return { on, off };
}

export interface ContextArmDelta {
  onRuns: number;
  offRuns: number;
  /** Minimum runs per arm required before deltas are considered meaningful. */
  minRuns: number;
  /** Whether both arms have at least `minRuns` entries. */
  sufficient: boolean;

  /** Average total tool calls per run, context-on. NaN-safe (0 when no data). */
  avgToolCallsOn: number;
  avgToolCallsOff: number;
  /** `avgToolCallsOn - avgToolCallsOff`. Negative = injected context reduced tool calls (the desired signal). */
  toolCallsDelta: number;

  /** Average Read calls per run. */
  avgReadsOn: number;
  avgReadsOff: number;
  /** `avgReadsOn - avgReadsOff`. */
  readsDelta: number;

  /** First-pass pass rate (`outcome === 'success'`) as a 0-100 percentage. */
  firstPassPassRateOn: number;
  firstPassPassRateOff: number;
  /** `firstPassPassRateOn - firstPassPassRateOff` (percentage points). */
  firstPassPassRateDelta: number;
}

/**
 * Compute the on-vs-off delta for the retrieval-quality eval.
 *
 * Inputs are pre-filtered entries (typically from `groupEntriesByContextArm`).
 * The function is robust to entries missing `toolCallCounts`: those are
 * counted toward pass-rate denominators but ignored when averaging tool calls.
 *
 * Sufficiency gate: both arms must have ≥ `AB_TEST_MIN_RUNS` entries before
 * `sufficient` flips true. Callers should display the "insufficient runs"
 * message until then.
 */
export function computeContextArmDelta(on: readonly HistoryEntry[], off: readonly HistoryEntry[]): ContextArmDelta {
  const onRuns = on.length;
  const offRuns = off.length;
  const sufficient = onRuns >= AB_TEST_MIN_RUNS && offRuns >= AB_TEST_MIN_RUNS;

  const onCounts = on.map((e) => e.toolCallCounts).filter((c): c is NonNullable<typeof c> => c != null);
  const offCounts = off.map((e) => e.toolCallCounts).filter((c): c is NonNullable<typeof c> => c != null);

  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  const avgToolCallsOn = avg(onCounts.map((c) => c.total));
  const avgToolCallsOff = avg(offCounts.map((c) => c.total));
  const avgReadsOn = avg(onCounts.map((c) => c.reads));
  const avgReadsOff = avg(offCounts.map((c) => c.reads));

  const passRate = (entries: readonly HistoryEntry[]): number => {
    if (entries.length === 0) return 0;
    const successes = entries.filter((e) => e.outcome === 'success').length;
    return (successes / entries.length) * 100;
  };

  const firstPassPassRateOn = passRate(on);
  const firstPassPassRateOff = passRate(off);

  return {
    onRuns,
    offRuns,
    minRuns: AB_TEST_MIN_RUNS,
    sufficient,
    avgToolCallsOn,
    avgToolCallsOff,
    toolCallsDelta: avgToolCallsOn - avgToolCallsOff,
    avgReadsOn,
    avgReadsOff,
    readsDelta: avgReadsOn - avgReadsOff,
    firstPassPassRateOn,
    firstPassPassRateOff,
    firstPassPassRateDelta: firstPassPassRateOn - firstPassPassRateOff,
  };
}

/**
 * Render the eval delta as a human-readable table. When insufficient runs are
 * available, emit a clear "insufficient" message instead of the deltas so
 * operators don't act on noise.
 */
export function formatContextArmDelta(delta: ContextArmDelta): string {
  if (!delta.sufficient) {
    return [
      `## Retrieval-quality eval (context-on vs context-off)`,
      ``,
      `Insufficient runs: need ≥${delta.minRuns} per arm.`,
      `Currently: context-on=${delta.onRuns}, context-off=${delta.offRuns}.`,
    ].join('\n');
  }

  const fmtNum = (n: number, digits = 2): string => {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(digits)}`;
  };

  return [
    `## Retrieval-quality eval (context-on vs context-off)`,
    ``,
    `Runs: context-on=${delta.onRuns}, context-off=${delta.offRuns} (min=${delta.minRuns})`,
    ``,
    `| Metric                | context-on | context-off | Δ        |`,
    `|-----------------------|------------|-------------|----------|`,
    `| Avg tool-calls / run  | ${delta.avgToolCallsOn.toFixed(2).padStart(10)} | ${delta.avgToolCallsOff.toFixed(2).padStart(11)} | ${fmtNum(delta.toolCallsDelta).padStart(8)} |`,
    `| Avg Read calls / run  | ${delta.avgReadsOn.toFixed(2).padStart(10)} | ${delta.avgReadsOff.toFixed(2).padStart(11)} | ${fmtNum(delta.readsDelta).padStart(8)} |`,
    `| First-pass pass rate  | ${`${delta.firstPassPassRateOn.toFixed(1)}%`.padStart(10)} | ${`${delta.firstPassPassRateOff.toFixed(1)}%`.padStart(11)} | ${`${fmtNum(delta.firstPassPassRateDelta, 1)}pp`.padStart(8)} |`,
    ``,
    `Negative Δ on tool-calls / Read means injected context reduced the agent's own retrieval (the desired signal).`,
  ].join('\n');
}
