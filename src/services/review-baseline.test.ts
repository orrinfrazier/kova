// Tests for the baseline-regression gate.

import { describe, expect, it } from 'vitest';
import { compareBaselineFailures } from './review-baseline.js';

describe('compareBaselineFailures', () => {
  it('returns no regressions when current failures are a subset of baseline', () => {
    const result = compareBaselineFailures(['testA', 'testB'], ['testA']);

    expect(result.newRegressions).toEqual([]);
    expect(result.preexisting).toEqual(['testA']);
    expect(result.blocking).toBe(false);
  });

  it('flags as blocking when a current failure is not in baseline (regression)', () => {
    const result = compareBaselineFailures(['testA'], ['testA', 'testB']);

    expect(result.newRegressions).toEqual(['testB']);
    expect(result.blocking).toBe(true);
  });

  it('separates pre-existing failures from new regressions', () => {
    const result = compareBaselineFailures(['testA'], ['testA', 'testB', 'testC']);

    expect(result.newRegressions).toEqual(['testB', 'testC']);
    expect(result.preexisting).toEqual(['testA']);
    expect(result.blocking).toBe(true);
  });

  it('returns blocking=false when both baseline and current are empty', () => {
    const result = compareBaselineFailures([], []);

    expect(result.newRegressions).toEqual([]);
    expect(result.preexisting).toEqual([]);
    expect(result.blocking).toBe(false);
  });

  it('returns blocking=false when baseline had failures but current passes', () => {
    const result = compareBaselineFailures(['testA', 'testB'], []);

    expect(result.newRegressions).toEqual([]);
    expect(result.preexisting).toEqual([]);
    expect(result.blocking).toBe(false);
  });

  it('produces a summary mentioning the regression count', () => {
    const result = compareBaselineFailures(['testA'], ['testA', 'testB', 'testC']);

    expect(result.summary).toMatch(/regression/i);
    expect(result.summary).toMatch(/2/);
  });

  it('summary mentions pre-existing failures separately', () => {
    const result = compareBaselineFailures(['testA', 'testB'], ['testA', 'testB']);

    expect(result.summary).toMatch(/pre-?existing/i);
  });

  it('deduplicates the baseline and current lists', () => {
    const result = compareBaselineFailures(['testA', 'testA'], ['testA', 'testA', 'testB']);

    expect(result.newRegressions).toEqual(['testB']);
    expect(result.preexisting).toEqual(['testA']);
  });
});
