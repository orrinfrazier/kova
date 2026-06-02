import { describe, expect, it } from 'vitest';
import type { Issue } from '../types/index.js';
import { extractFootprint, partitionTierByFootprint } from './file-footprint.js';

function makeIssue(number: number, body: string): Issue {
  return {
    number,
    title: `Issue #${number}`,
    body,
    labels: [],
    url: `https://github.com/test/repo/issues/${number}`,
  };
}

describe('extractFootprint', () => {
  it('returns empty array for body with no file paths', () => {
    const issue = makeIssue(1, 'Just a description with no file references.');
    expect(extractFootprint(issue)).toEqual([]);
  });

  it('extracts plain file paths from prose', () => {
    const issue = makeIssue(1, 'The bug is in src/pipeline/loop.ts and also in src/services/conflict-check.ts.');
    const result = extractFootprint(issue);
    expect(result).toContain('src/pipeline/loop.ts');
    expect(result).toContain('src/services/conflict-check.ts');
  });

  it('extracts paths from inline backticks', () => {
    const issue = makeIssue(1, 'Look at `src/pipeline/loop.ts` for details.');
    expect(extractFootprint(issue)).toContain('src/pipeline/loop.ts');
  });

  it('strips line-range suffixes (path:N or path:N-M)', () => {
    const issue = makeIssue(1, 'src/pipeline/loop.ts:120-122 and src/pipeline/issue-scheduler.ts:109');
    const result = extractFootprint(issue);
    expect(result).toContain('src/pipeline/loop.ts');
    expect(result).toContain('src/pipeline/issue-scheduler.ts');
    // No path should retain the :N or :N-M suffix
    expect(result.every((p) => !/:\d/.test(p))).toBe(true);
  });

  it('extracts paths from a comma-separated evidence line', () => {
    const issue = makeIssue(
      1,
      '## Evidence\nsrc/pipeline/loop.ts:120-122,136, src/pipeline/issue-scheduler.ts:109-191, src/services/conflict-check.ts',
    );
    const result = extractFootprint(issue);
    expect(result).toContain('src/pipeline/loop.ts');
    expect(result).toContain('src/pipeline/issue-scheduler.ts');
    expect(result).toContain('src/services/conflict-check.ts');
  });

  it('deduplicates repeated paths', () => {
    const issue = makeIssue(1, 'src/pipeline/loop.ts is bad. Fix src/pipeline/loop.ts. Also `src/pipeline/loop.ts`.');
    const result = extractFootprint(issue);
    expect(result.filter((p) => p === 'src/pipeline/loop.ts')).toHaveLength(1);
  });

  it('ignores URLs that look like paths', () => {
    const issue = makeIssue(1, 'See https://example.com/path/file.ts and http://foo.bar/x.ts for context.');
    const result = extractFootprint(issue);
    expect(result).not.toContain('path/file.ts');
    expect(result).not.toContain('x.ts');
    expect(result).not.toContain('https://example.com/path/file.ts');
  });

  it('handles realistic kova issue body (issue #289)', () => {
    const body = [
      '## Problem',
      'With concurrency>1 the loop runs sibling fixes in a tier concurrently and shares pendingPRs only best-effort (loop.ts:120-122) with no detection of two fixes editing the same files.',
      '## Proposed change',
      "Before launching a tier with concurrency>1, predict each issue's file footprint (from spec / conflict-check.ts) and serialize issues whose footprints overlap; disjoint ones stay concurrent.",
      '## Evidence',
      'src/pipeline/loop.ts:120-122,136, src/pipeline/issue-scheduler.ts:109-191, src/services/conflict-check.ts',
    ].join('\n');
    const issue = makeIssue(289, body);
    const result = extractFootprint(issue);
    expect(result).toContain('src/pipeline/loop.ts');
    expect(result).toContain('src/pipeline/issue-scheduler.ts');
    expect(result).toContain('src/services/conflict-check.ts');
  });

  it('handles undefined or empty body gracefully', () => {
    const empty = makeIssue(1, '');
    expect(extractFootprint(empty)).toEqual([]);
  });
});

describe('partitionTierByFootprint', () => {
  it('returns single sub-tier when all footprints are disjoint', () => {
    const tier = [0, 1, 2];
    const footprints = new Map<number, string[]>([
      [0, ['src/a.ts']],
      [1, ['src/b.ts']],
      [2, ['src/c.ts']],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([0, 1, 2]);
  });

  it('splits overlapping issues into separate sub-tiers', () => {
    const tier = [0, 1];
    const footprints = new Map<number, string[]>([
      [0, ['src/shared.ts']],
      [1, ['src/shared.ts']],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0]);
    expect(result[1]).toEqual([1]);
  });

  it('groups disjoint issues into the same sub-tier and serializes overlapping ones', () => {
    // 0 and 2 are disjoint; 1 overlaps with 0 on shared.ts
    const tier = [0, 1, 2];
    const footprints = new Map<number, string[]>([
      [0, ['src/a.ts', 'src/shared.ts']],
      [1, ['src/shared.ts', 'src/b.ts']],
      [2, ['src/c.ts']],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    // 0 and 2 disjoint → same sub-tier. 1 conflicts with 0 → next sub-tier.
    expect(result).toHaveLength(2);
    expect(result[0]).toContain(0);
    expect(result[0]).toContain(2);
    expect(result[1]).toEqual([1]);
  });

  it('places issues with empty footprint in the same sub-tier (allow-parallel default)', () => {
    const tier = [0, 1];
    const footprints = new Map<number, string[]>([
      [0, []],
      [1, []],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([0, 1]);
  });

  it('mixes empty-footprint issues with footprinted ones without serializing them', () => {
    // Issue 0 has footprint, 1 is unknown (empty). They should stay parallel.
    const tier = [0, 1];
    const footprints = new Map<number, string[]>([
      [0, ['src/a.ts']],
      [1, []],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([0, 1]);
  });

  it('preserves input order within sub-tiers (deterministic)', () => {
    const tier = [10, 20, 30];
    const footprints = new Map<number, string[]>([
      [10, ['src/x.ts']],
      [20, ['src/x.ts']],
      [30, ['src/y.ts']],
    ]);
    const result = partitionTierByFootprint(tier, (idx) => footprints.get(idx) ?? []);
    // 10 and 30 disjoint → sub-tier [10, 30] in that order; 20 → next sub-tier
    expect(result[0]).toEqual([10, 30]);
    expect(result[1]).toEqual([20]);
  });

  it('handles empty tier', () => {
    expect(partitionTierByFootprint([], () => [])).toEqual([]);
  });

  it('handles single-issue tier', () => {
    expect(partitionTierByFootprint([42], () => ['src/x.ts'])).toEqual([[42]]);
  });
});
