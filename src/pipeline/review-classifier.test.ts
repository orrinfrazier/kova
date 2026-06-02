/**
 * Tests for review-classifier — buffer-then-classify pass that splits review
 * findings into "real review" (post) and "probe" (telemetry only).
 *
 * Borrowed from claude-code-action `classify_inline_comments`
 * (oss/claude-code-action/action.yml:116-119): buffer inline comments without
 * confirmed=true and classify them before posting after the session ends.
 *
 * Heuristic rules tested below — the goal is "few false positives in the
 * 'probe' bucket". When unsure, classify as `real` (post it).
 *
 *   - severity critical | high                 → always real
 *   - category needs_new_tests with test_code  → always real (concrete repro)
 *   - description hedged with "might"/"maybe"/"possibly"/"could"/"unclear"
 *     AND severity ∈ {low, medium}             → probe
 *   - description starts "consider " or "you might want to" AND severity low
 *                                              → probe
 *   - default                                  → real
 */

import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../types/index.js';
import { classifyReviewFindings, isProbe } from './review-classifier.js';

function f(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    category: 'mechanical_fix',
    file: 'src/foo.ts',
    description: 'something',
    severity: 'medium',
    ...partial,
  };
}

describe('isProbe', () => {
  it('returns false for critical findings even when hedged', () => {
    expect(isProbe(f({ severity: 'critical', description: 'this might be a problem' }))).toBe(false);
  });

  it('returns false for high findings even when hedged', () => {
    expect(isProbe(f({ severity: 'high', description: 'this might be a problem' }))).toBe(false);
  });

  it('returns false when needs_new_tests carries test_code', () => {
    expect(
      isProbe(
        f({
          category: 'needs_new_tests',
          severity: 'low',
          description: 'maybe missing edge case',
          test_code: 'expect(foo()).toBe(1);',
        }),
      ),
    ).toBe(false);
  });

  it('returns true for hedged low/medium findings without test code', () => {
    expect(isProbe(f({ severity: 'low', description: 'this might be incorrect' }))).toBe(true);
    expect(isProbe(f({ severity: 'medium', description: 'possibly leaks a handle' }))).toBe(true);
    expect(isProbe(f({ severity: 'low', description: 'could potentially be unsafe' }))).toBe(true);
    expect(isProbe(f({ severity: 'low', description: 'unclear whether this is needed' }))).toBe(true);
  });

  it('returns true for "consider"-style suggestions at low severity', () => {
    expect(isProbe(f({ severity: 'low', description: 'consider refactoring this loop' }))).toBe(true);
  });

  it('returns false for definite low-severity findings (no hedges)', () => {
    expect(isProbe(f({ severity: 'low', description: 'missing input validation on user-supplied data' }))).toBe(false);
  });

  it('hedge detection is case-insensitive', () => {
    expect(isProbe(f({ severity: 'low', description: 'This MIGHT crash on null' }))).toBe(true);
  });

  it('defaults to false (real) when nothing flags the finding as a probe', () => {
    expect(isProbe(f({ severity: 'medium', description: 'duplicate import' }))).toBe(false);
  });
});

describe('classifyReviewFindings', () => {
  it('partitions findings into real and probe buckets', () => {
    const findings: ReviewFinding[] = [
      f({ severity: 'critical', description: 'SQL injection' }),
      f({ severity: 'low', description: 'might be unsafe' }),
      f({ severity: 'medium', description: 'duplicate import' }),
      f({ severity: 'low', description: 'consider extracting helper' }),
    ];

    const { real, probe } = classifyReviewFindings(findings);
    expect(real.map((x) => x.description)).toEqual(['SQL injection', 'duplicate import']);
    expect(probe.map((x) => x.description)).toEqual(['might be unsafe', 'consider extracting helper']);
  });

  it('handles empty input', () => {
    expect(classifyReviewFindings([])).toEqual({ real: [], probe: [] });
  });

  it('preserves order within each bucket', () => {
    const findings: ReviewFinding[] = [
      f({ severity: 'low', description: 'might A' }),
      f({ severity: 'critical', description: 'real A' }),
      f({ severity: 'low', description: 'might B' }),
      f({ severity: 'critical', description: 'real B' }),
    ];
    const { real, probe } = classifyReviewFindings(findings);
    expect(real.map((x) => x.description)).toEqual(['real A', 'real B']);
    expect(probe.map((x) => x.description)).toEqual(['might A', 'might B']);
  });

  it('returns originals (no mutation)', () => {
    const findings: ReviewFinding[] = [f({ severity: 'critical', description: 'leave me alone' })];
    const before = JSON.parse(JSON.stringify(findings));
    classifyReviewFindings(findings);
    expect(findings).toEqual(before);
  });
});
