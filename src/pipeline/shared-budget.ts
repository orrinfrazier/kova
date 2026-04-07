/**
 * SharedBudgetTracker — coordinates a budget cap across parallel repo runs.
 * Node.js is single-threaded so no atomics needed, but the abstraction
 * centralises cost tracking for concurrent fixLoop() invocations.
 */

export interface SharedBudgetTracker {
  /** Record cost spent by a repo. */
  addCost(amount: number): void;
  /** Whether the shared budget has been exceeded. */
  isExceeded(): boolean;
  /** Total spent across all repos so far. */
  totalSpent(): number;
  /** The budget limit in USD. */
  readonly limitUsd: number;
}

export function createSharedBudget(limitUsd: number): SharedBudgetTracker {
  let spent = 0;
  return {
    limitUsd,
    addCost(amount: number) {
      spent += amount;
    },
    isExceeded() {
      return spent >= limitUsd;
    },
    totalSpent() {
      return spent;
    },
  };
}
