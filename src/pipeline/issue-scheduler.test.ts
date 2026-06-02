import { describe, expect, it } from 'vitest';
import type { Issue } from '../types/index.js';
import {
  buildDependencyTiers,
  type ConcurrencyOptions,
  type DependencyInfo,
  type FixExecutor,
  runFixesWithConcurrency,
} from './issue-scheduler.js';

function makeIssue(number: number): Issue {
  return {
    number,
    title: `Issue #${number}`,
    body: `Body for issue ${number}`,
    labels: [],
    url: `https://github.com/test/repo/issues/${number}`,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('runFixesWithConcurrency', () => {
  it('enforces max concurrency — 5 issues with concurrency=3 never exceeds 3 active', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1));
    let activeCount = 0;
    let maxActiveCount = 0;

    const executor: FixExecutor = async (_issue) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await delay(30);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 3, costAccumulator };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2, 3, 4]], executor, options);

    expect(maxActiveCount).toBeLessThanOrEqual(3);
    expect(maxActiveCount).toBeGreaterThanOrEqual(2); // actually used concurrency
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('runs sequentially when concurrency=1', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1));
    let activeCount = 0;
    let maxActiveCount = 0;
    const executionOrder: number[] = [];

    const executor: FixExecutor = async (issue) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      executionOrder.push(issue.number);
      await delay(10);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 1, costAccumulator };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2, 3, 4]], executor, options);

    expect(maxActiveCount).toBe(1);
    expect(executionOrder).toEqual([1, 2, 3, 4, 5]);
    expect(results).toHaveLength(5);
  });

  it('respects dependency ordering — blocked issue waits for dependency to complete', async () => {
    // Issue A (index 1) depends on Issue B (index 0)
    // dependencyTiers: tier 0 = [0], tier 1 = [1]
    const issueB = makeIssue(10);
    const issueA = makeIssue(20);
    const issues = [issueB, issueA];

    const timeline: Array<{ issueNumber: number; event: 'start' | 'end'; time: number }> = [];

    const executor: FixExecutor = async (issue) => {
      timeline.push({ issueNumber: issue.number, event: 'start', time: Date.now() });
      await delay(30);
      timeline.push({ issueNumber: issue.number, event: 'end', time: Date.now() });
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 3, costAccumulator };

    // Tier 0: issue B (index 0), Tier 1: issue A (index 1)
    await runFixesWithConcurrency(issues, [[0], [1]], executor, options);

    const bEnd = timeline.find((e) => e.issueNumber === 10 && e.event === 'end');
    const aStart = timeline.find((e) => e.issueNumber === 20 && e.event === 'start');

    expect(bEnd).toBeDefined();
    expect(aStart).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by toBeDefined assertions above
    expect(bEnd!.time).toBeLessThanOrEqual(aStart!.time);
  });

  it('skips remaining issues when budget is exceeded mid-batch', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1));
    const costAccumulator = { current: 0 };
    const fixCost = 2;

    const executor: FixExecutor = async (_issue) => {
      costAccumulator.current += fixCost;
      await delay(10);
      return { success: true };
    };

    const options: ConcurrencyOptions = {
      concurrency: 1, // sequential to make budget accounting predictable
      budget: 5,
      costAccumulator,
    };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2, 3, 4]], executor, options);

    // With budget=5, cost per fix=2:
    // Fix 1: cost=2 (ok), Fix 2: cost=4 (ok), Fix 3: cost=6 (exceeds) — 3rd starts but after completion remaining skipped
    const succeededCount = results.filter((r) => r.success).length;
    // At least 2 should succeed (cost 4), fix 3 starts (cost 6 exceeds), then remaining skipped
    expect(succeededCount).toBeGreaterThanOrEqual(2);
    // Not all 5 should have run
    expect(results.filter((r) => r.success).length).toBeLessThan(5);
    // Total results should still account for all issues (succeeded + skipped)
    expect(results).toHaveLength(5);
  });

  it('stops starting new fixes when shutdownRequested returns true between tiers', async () => {
    const issues = Array.from({ length: 4 }, (_, i) => makeIssue(i + 1));
    let fixCount = 0;

    const executor: FixExecutor = async (_issue) => {
      fixCount++;
      await delay(10);
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = {
      concurrency: 3,
      costAccumulator,
      shutdownRequested: () => fixCount >= 2,
    };

    // Two tiers: tier 0 has 2 issues, tier 1 has 2 issues
    const results = await runFixesWithConcurrency(
      issues,
      [
        [0, 1],
        [2, 3],
      ],
      executor,
      options,
    );

    // Tier 0 runs (2 fixes), then shutdown is true, tier 1 should not start
    const succeededResults = results.filter((r) => r.success);
    expect(succeededResults.length).toBe(2);
    // Results array should still have all 4 entries (2 succeeded, 2 skipped)
    expect(results).toHaveLength(4);
  });

  it('isolates failures — error in one fix does not abort siblings', async () => {
    const issues = Array.from({ length: 3 }, (_, i) => makeIssue(i + 1));

    const executor: FixExecutor = async (issue) => {
      await delay(10);
      if (issue.number === 2) {
        throw new Error('fix for issue 2 exploded');
      }
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 3, costAccumulator };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2]], executor, options);

    expect(results).toHaveLength(3);

    // Issue 1 and 3 should succeed
    const result1 = results.find((r) => r.issueNumber === 1);
    const result3 = results.find((r) => r.issueNumber === 3);
    expect(result1?.success).toBe(true);
    expect(result3?.success).toBe(true);

    // Issue 2 should fail with the error
    const result2 = results.find((r) => r.issueNumber === 2);
    expect(result2?.success).toBe(false);
    expect(result2?.error).toBe('fix for issue 2 exploded');
  });

  it('returns results array with correct succeeded/failed counts', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1));

    const executor: FixExecutor = async (issue) => {
      await delay(5);
      // Issues 2 and 4 fail
      if (issue.number === 2 || issue.number === 4) {
        throw new Error(`issue ${issue.number} failed`);
      }
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 3, costAccumulator };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2, 3, 4]], executor, options);

    expect(results).toHaveLength(5);

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(2);

    // Each result should have an issueNumber
    for (const r of results) {
      expect(r.issueNumber).toBeTypeOf('number');
    }

    // Failed results should have error messages
    for (const r of failed) {
      expect(r.error).toBeTypeOf('string');
      expect(r.error?.length).toBeGreaterThan(0);
    }
  });
});

describe('buildDependencyTiers', () => {
  it('returns empty array for empty issues', () => {
    expect(buildDependencyTiers([], [])).toEqual([]);
  });

  it('puts all issues in one tier when no dependencies', () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const tiers = buildDependencyTiers(issues, []);
    expect(tiers).toEqual([[0, 1, 2]]);
  });

  it('separates dependent issues into sequential tiers', () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const deps: DependencyInfo[] = [{ issueNumber: 2, blockedBy: [1] }];
    const tiers = buildDependencyTiers(issues, deps);
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toContain(0); // issue 1 in tier 0
    expect(tiers[0]).toContain(2); // issue 3 in tier 0 (no deps)
    expect(tiers[1]).toContain(1); // issue 2 in tier 1
  });

  it('breaks cycles by forcing remaining issues into last tier', () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const deps: DependencyInfo[] = [
      { issueNumber: 1, blockedBy: [2] },
      { issueNumber: 2, blockedBy: [1] },
    ];
    const tiers = buildDependencyTiers(issues, deps);
    const allPlaced = tiers.flat();
    expect(allPlaced).toHaveLength(2);
    expect(allPlaced).toContain(0);
    expect(allPlaced).toContain(1);
  });

  it('ignores dependencies on issues not in the list', () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const deps: DependencyInfo[] = [{ issueNumber: 2, blockedBy: [999] }];
    const tiers = buildDependencyTiers(issues, deps);
    expect(tiers).toEqual([[0, 1]]);
  });
});

describe('runFixesWithConcurrency — file-overlap conflict avoidance', () => {
  it('serializes issues with overlapping file footprints (concurrency=2)', async () => {
    // Two issues both touching src/shared.ts. With concurrency=2 they would normally
    // run in parallel; the footprint map MUST cause them to run sequentially.
    const issues = [makeIssue(1), makeIssue(2)];
    let activeCount = 0;
    let maxActiveCount = 0;

    const executor: FixExecutor = async (_issue) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await delay(30);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const footprints = new Map<number, string[]>([
      [1, ['src/shared.ts']],
      [2, ['src/shared.ts']],
    ]);
    const options: ConcurrencyOptions = {
      concurrency: 2,
      costAccumulator,
      footprints,
    };

    await runFixesWithConcurrency(issues, [[0, 1]], executor, options);

    expect(maxActiveCount).toBe(1);
  });

  it('runs disjoint-footprint issues in parallel (concurrency=2)', async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    let activeCount = 0;
    let maxActiveCount = 0;

    const executor: FixExecutor = async (_issue) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await delay(30);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const footprints = new Map<number, string[]>([
      [1, ['src/a.ts']],
      [2, ['src/b.ts']],
    ]);
    const options: ConcurrencyOptions = {
      concurrency: 2,
      costAccumulator,
      footprints,
    };

    await runFixesWithConcurrency(issues, [[0, 1]], executor, options);

    expect(maxActiveCount).toBe(2);
  });

  it('mixes disjoint and overlapping: serializes only the overlapping pair', async () => {
    // 3 issues, concurrency=3. Issues 1&2 share a file; issue 3 is disjoint.
    // Expected: {1, 3} parallel, then 2 alone.
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const concurrentSamples: number[] = [];
    let activeCount = 0;

    const executor: FixExecutor = async (_issue) => {
      activeCount++;
      concurrentSamples.push(activeCount);
      await delay(30);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const footprints = new Map<number, string[]>([
      [1, ['src/shared.ts']],
      [2, ['src/shared.ts']],
      [3, ['src/other.ts']],
    ]);
    const options: ConcurrencyOptions = {
      concurrency: 3,
      costAccumulator,
      footprints,
    };

    await runFixesWithConcurrency(issues, [[0, 1, 2]], executor, options);

    const maxConcurrent = Math.max(...concurrentSamples);
    // Issues 1 and 3 should be parallel; 2 must wait
    expect(maxConcurrent).toBe(2);
  });

  it('preserves existing behavior when footprints is omitted', async () => {
    // No footprints map — should behave exactly like before, allowing full parallelism.
    const issues = [makeIssue(1), makeIssue(2)];
    let activeCount = 0;
    let maxActiveCount = 0;

    const executor: FixExecutor = async (_issue) => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await delay(30);
      activeCount--;
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const options: ConcurrencyOptions = { concurrency: 2, costAccumulator };

    await runFixesWithConcurrency(issues, [[0, 1]], executor, options);

    // Two issues, concurrency=2, no footprints → parallel allowed
    expect(maxActiveCount).toBe(2);
  });

  it('preserves existing behavior when concurrency=1 even with overlapping footprints', async () => {
    // concurrency=1 already serializes — footprints map has no effect on max concurrency
    // but result shape should be identical.
    const issues = [makeIssue(1), makeIssue(2)];
    const executionOrder: number[] = [];

    const executor: FixExecutor = async (issue) => {
      executionOrder.push(issue.number);
      await delay(10);
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const footprints = new Map<number, string[]>([
      [1, ['src/shared.ts']],
      [2, ['src/shared.ts']],
    ]);
    const options: ConcurrencyOptions = { concurrency: 1, costAccumulator, footprints };

    const results = await runFixesWithConcurrency(issues, [[0, 1]], executor, options);

    expect(executionOrder).toEqual([1, 2]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('returns correct result shape with footprint-partitioned sub-tiers', async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];

    const executor: FixExecutor = async (issue) => {
      await delay(5);
      if (issue.number === 2) throw new Error('issue 2 failed');
      return { success: true };
    };

    const costAccumulator = { current: 0 };
    const footprints = new Map<number, string[]>([
      [1, ['src/shared.ts']],
      [2, ['src/shared.ts']],
      [3, ['src/other.ts']],
    ]);
    const options: ConcurrencyOptions = { concurrency: 3, costAccumulator, footprints };

    const results = await runFixesWithConcurrency(issues, [[0, 1, 2]], executor, options);

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.issueNumber === 1)?.success).toBe(true);
    expect(results.find((r) => r.issueNumber === 2)?.success).toBe(false);
    expect(results.find((r) => r.issueNumber === 3)?.success).toBe(true);
  });
});
