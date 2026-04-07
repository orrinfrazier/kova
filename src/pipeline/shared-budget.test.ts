import { describe, expect, it } from 'vitest';
import { createSharedBudget } from './shared-budget.js';

describe('SharedBudgetTracker', () => {
  it('starts with zero spent', () => {
    const tracker = createSharedBudget(10);
    expect(tracker.totalSpent()).toBe(0);
    expect(tracker.isExceeded()).toBe(false);
  });

  it('tracks cumulative cost', () => {
    const tracker = createSharedBudget(10);
    tracker.addCost(3);
    tracker.addCost(4);
    expect(tracker.totalSpent()).toBe(7);
    expect(tracker.isExceeded()).toBe(false);
  });

  it('reports exceeded when cost reaches limit', () => {
    const tracker = createSharedBudget(10);
    tracker.addCost(10);
    expect(tracker.isExceeded()).toBe(true);
  });

  it('reports exceeded when cost exceeds limit', () => {
    const tracker = createSharedBudget(5);
    tracker.addCost(3);
    tracker.addCost(3);
    expect(tracker.totalSpent()).toBe(6);
    expect(tracker.isExceeded()).toBe(true);
  });

  it('exposes limitUsd', () => {
    const tracker = createSharedBudget(42);
    expect(tracker.limitUsd).toBe(42);
  });
});
