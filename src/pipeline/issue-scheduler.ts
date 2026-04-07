import type { Issue } from '../types/index.js';

export interface IssueFixResult {
  issueNumber: number;
  success: boolean;
  error?: string;
}

export type FixExecutor = (issue: Issue) => Promise<{ success: boolean }>;

export interface ConcurrencyOptions {
  concurrency: number;
  budget?: number;
  costAccumulator: { current: number };
  shutdownRequested?: () => boolean;
}

/**
 * Run fix executors for issues respecting dependency tiers and concurrency limits.
 *
 * - Issues within a tier run concurrently up to the concurrency limit (semaphore pattern).
 * - All issues in a tier must complete before the next tier starts.
 * - Budget is checked after each fix completes; remaining issues are skipped if exceeded.
 * - shutdownRequested is checked between tiers.
 * - Failures are isolated: one fix throwing does not abort siblings in the same tier.
 */
export async function runFixesWithConcurrency(
  issues: Issue[],
  dependencyTiers: number[][],
  executor: FixExecutor,
  options: ConcurrencyOptions,
): Promise<IssueFixResult[]> {
  const { concurrency, budget, costAccumulator, shutdownRequested } = options;

  const resultMap = new Map<number, IssueFixResult>();

  const isBudgetExceeded = (): boolean => budget !== undefined && costAccumulator.current >= budget;

  for (let tierIdx = 0; tierIdx < dependencyTiers.length; tierIdx++) {
    const tier = dependencyTiers[tierIdx];
    if (!tier || tier.length === 0) continue;

    // Check shutdown between tiers (not before the first tier)
    if (tierIdx > 0 && shutdownRequested?.()) {
      for (let t = tierIdx; t < dependencyTiers.length; t++) {
        const remainingTier = dependencyTiers[t];
        if (!remainingTier) continue;
        for (const idx of remainingTier) {
          const issue = issues[idx];
          if (issue && !resultMap.has(issue.number)) {
            resultMap.set(issue.number, {
              issueNumber: issue.number,
              success: false,
              error: 'skipped: shutdown requested',
            });
          }
        }
      }
      break;
    }

    // Also check budget before starting a new tier
    if (isBudgetExceeded()) {
      for (let t = tierIdx; t < dependencyTiers.length; t++) {
        const remainingTier = dependencyTiers[t];
        if (!remainingTier) continue;
        for (const idx of remainingTier) {
          const issue = issues[idx];
          if (issue && !resultMap.has(issue.number)) {
            resultMap.set(issue.number, {
              issueNumber: issue.number,
              success: false,
              error: 'skipped: budget exceeded',
            });
          }
        }
      }
      break;
    }

    const tierResults = await runTierWithSemaphore(
      tier,
      issues,
      executor,
      concurrency,
      isBudgetExceeded,
      shutdownRequested,
    );

    for (const result of tierResults) {
      resultMap.set(result.issueNumber, result);
    }
  }

  // Build final results for ALL issues, filling in skipped ones
  const results: IssueFixResult[] = [];
  for (const issue of issues) {
    const existing = resultMap.get(issue.number);
    if (existing) {
      results.push(existing);
    } else {
      results.push({ issueNumber: issue.number, success: false, error: 'skipped' });
    }
  }

  return results;
}

async function runTierWithSemaphore(
  tierIndices: number[],
  issues: Issue[],
  executor: FixExecutor,
  maxConcurrent: number,
  isBudgetExceeded: () => boolean,
  isShutdownRequested?: () => boolean,
): Promise<IssueFixResult[]> {
  const results: IssueFixResult[] = [];
  let activeCount = 0;
  let nextIdx = 0;
  const total = tierIndices.length;

  return new Promise((resolve) => {
    const tryStartNext = (): void => {
      // Skip remaining if shutdown requested
      while (nextIdx < total && isShutdownRequested?.()) {
        const issueIdx = tierIndices[nextIdx];
        const issue = issueIdx !== undefined ? issues[issueIdx] : undefined;
        if (issue) {
          results.push({
            issueNumber: issue.number,
            success: false,
            error: 'skipped: shutdown requested',
          });
        }
        nextIdx++;
      }

      // Skip remaining if budget exceeded
      while (nextIdx < total && isBudgetExceeded()) {
        const issueIdx = tierIndices[nextIdx];
        const issue = issueIdx !== undefined ? issues[issueIdx] : undefined;
        if (issue) {
          results.push({
            issueNumber: issue.number,
            success: false,
            error: 'skipped: budget exceeded',
          });
        }
        nextIdx++;
      }

      while (activeCount < maxConcurrent && nextIdx < total) {
        const currentIdx = nextIdx;
        nextIdx++;
        const issueIdx = tierIndices[currentIdx];
        const issue = issueIdx !== undefined ? issues[issueIdx] : undefined;

        if (!issue) {
          continue;
        }

        activeCount++;

        executor(issue)
          .then((result) => {
            results.push({ issueNumber: issue.number, success: result.success });
          })
          .catch((err: unknown) => {
            results.push({
              issueNumber: issue.number,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            activeCount--;
            tryStartNext();
            if (activeCount === 0 && nextIdx >= total) {
              resolve(results);
            }
          });
      }

      if (activeCount === 0 && nextIdx >= total) {
        resolve(results);
      }
    };

    tryStartNext();
  });
}

export interface DependencyInfo {
  issueNumber: number;
  blockedBy: number[];
}

/**
 * Build dependency tiers from issue dependency info.
 * Issues whose blockers have all been placed in earlier tiers go in the current tier.
 * Cycles are broken by forcing remaining issues into the last tier.
 */
export function buildDependencyTiers(issues: Issue[], dependencies: DependencyInfo[]): number[][] {
  if (issues.length === 0) return [];

  const indexByNumber = new Map<number, number>();
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (issue) indexByNumber.set(issue.number, i);
  }

  const blockerMap = new Map<number, Set<number>>();
  for (const dep of dependencies) {
    const idx = indexByNumber.get(dep.issueNumber);
    if (idx === undefined) continue;
    const blockerIndices = new Set<number>();
    for (const blockerNum of dep.blockedBy) {
      const blockerIdx = indexByNumber.get(blockerNum);
      if (blockerIdx !== undefined) {
        blockerIndices.add(blockerIdx);
      }
    }
    if (blockerIndices.size > 0) {
      blockerMap.set(idx, blockerIndices);
    }
  }

  const placed = new Set<number>();
  const tiers: number[][] = [];

  while (placed.size < issues.length) {
    const tier: number[] = [];
    for (let i = 0; i < issues.length; i++) {
      if (placed.has(i)) continue;
      const blockers = blockerMap.get(i);
      if (!blockers || [...blockers].every((b) => placed.has(b))) {
        tier.push(i);
      }
    }
    if (tier.length === 0) {
      for (let i = 0; i < issues.length; i++) {
        if (!placed.has(i)) tier.push(i);
      }
    }
    tiers.push(tier);
    for (const idx of tier) placed.add(idx);
  }

  return tiers;
}
