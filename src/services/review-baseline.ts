// Baseline regression gate — compares failing-test sets to surface new regressions
// while ignoring pre-existing failures. Used by the review wave to fail-closed
// on regressions introduced by the impl wave, independent of the model's judgment.

export interface BaselineComparison {
  /** Failing tests that did NOT fail in the baseline — these are regressions and block. */
  newRegressions: string[];
  /** Failing tests that failed in both baseline and current — surfaced but non-blocking. */
  preexisting: string[];
  /** True iff there is at least one new regression. */
  blocking: boolean;
  /** Human-readable summary suitable for injecting into the reviewer's user message. */
  summary: string;
}

/**
 * Compare baseline failing-test names to current failing-test names.
 *
 * Semantics:
 * - newRegressions = current \ baseline (deduped). If non-empty, blocking = true.
 * - preexisting = current ∩ baseline (deduped). Non-blocking; surfaced for context.
 * - Failures that disappeared (baseline \ current) are silently ignored — they
 *   represent improvements, not gaps.
 *
 * The summary embeds counts so the reviewer prompt can surface them as data.
 */
export function compareBaselineFailures(baseline: string[], current: string[]): BaselineComparison {
  const baselineSet = new Set(baseline);
  const currentSet = new Set(current);

  const newRegressions: string[] = [];
  const preexisting: string[] = [];

  for (const name of currentSet) {
    if (baselineSet.has(name)) {
      preexisting.push(name);
    } else {
      newRegressions.push(name);
    }
  }

  // Sort for stable summary output.
  newRegressions.sort();
  preexisting.sort();

  const blocking = newRegressions.length > 0;

  const lines: string[] = [];
  if (newRegressions.length > 0) {
    lines.push(`regression: ${newRegressions.length} newly failing`);
    for (const name of newRegressions) {
      lines.push(`  - ${name}`);
    }
  } else {
    lines.push('regression: 0 newly failing');
  }
  if (preexisting.length > 0) {
    lines.push(`pre-existing failures: ${preexisting.length} (non-blocking)`);
    for (const name of preexisting) {
      lines.push(`  - ${name}`);
    }
  }
  const summary = lines.join('\n');

  return { newRegressions, preexisting, blocking, summary };
}
