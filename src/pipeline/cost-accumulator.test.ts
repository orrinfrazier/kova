import { describe, expect, it, vi } from 'vitest';
import { CostAccumulator } from './cost-accumulator.js';

describe('CostAccumulator', () => {
  it('starts at zero', () => {
    const acc = new CostAccumulator();
    expect(acc.get()).toBe(0);
  });

  it('tracks cumulative cost across multiple add() calls', () => {
    const acc = new CostAccumulator();
    acc.add(1.5);
    acc.add(2.0);
    expect(acc.get()).toBe(3.5);
  });

  it('exceedsBudget returns true when accumulated cost equals budget', () => {
    const acc = new CostAccumulator();
    acc.add(5);
    acc.add(5);
    expect(acc.exceedsBudget(10)).toBe(true);
  });

  it('exceedsBudget returns false when accumulated cost is below budget', () => {
    const acc = new CostAccumulator();
    acc.add(3);
    expect(acc.exceedsBudget(10)).toBe(false);
  });

  it('exceedsBudget returns true when accumulated cost exceeds budget', () => {
    const acc = new CostAccumulator();
    acc.add(11);
    expect(acc.exceedsBudget(10)).toBe(true);
  });

  it('invokes metrics callback on each add()', () => {
    const onCostUpdate = vi.fn();
    const acc = new CostAccumulator({ onCostUpdate });
    acc.add(5);
    expect(onCostUpdate).toHaveBeenCalledTimes(1);
    expect(onCostUpdate).toHaveBeenCalledWith(5);
  });

  it('tracks turns via addTurns()', () => {
    const acc = new CostAccumulator();
    acc.addTurns(3);
    acc.addTurns(2);
    expect(acc.getTurns()).toBe(5);
  });

  it('tracks duration via addDuration()', () => {
    const acc = new CostAccumulator();
    acc.addDuration(1000);
    acc.addDuration(2000);
    expect(acc.getDuration()).toBe(3000);
  });
});
