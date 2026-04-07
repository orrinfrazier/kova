import { describe, expect, it } from 'vitest';
import type { Issue } from '../types/index.js';
import { parseDependencies, prioritizeIssues, scoreIssue } from './prioritize.js';

function makeIssue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue #${overrides.number}`,
    body: '',
    labels: [],
    url: `https://github.com/test/repo/issues/${overrides.number}`,
    ...overrides,
  };
}

describe('parseDependencies', () => {
  it('extracts single blocked-by reference', () => {
    expect(parseDependencies('blocked by #5')).toEqual([5]);
  });

  it('extracts multiple blocked-by references', () => {
    expect(parseDependencies('blocked by #5, blocked by #10')).toEqual([5, 10]);
  });

  it('handles "depends on" syntax', () => {
    expect(parseDependencies('depends on #3')).toEqual([3]);
  });

  it('is case-insensitive', () => {
    expect(parseDependencies('Blocked By #7')).toEqual([7]);
  });

  it('returns empty array when no dependencies', () => {
    expect(parseDependencies('no dependencies here')).toEqual([]);
  });

  it('handles mixed text with dependency references', () => {
    expect(parseDependencies('This is blocked by #2 and also depends on #4')).toEqual([2, 4]);
  });

  it('deduplicates references', () => {
    expect(parseDependencies('blocked by #3, depends on #3')).toEqual([3]);
  });
});

describe('scoreIssue', () => {
  it('scores critical label at 80', () => {
    const issue = makeIssue({ number: 1, labels: ['critical'] });
    expect(scoreIssue(issue, [])).toBe(80);
  });

  it('scores high label at 60', () => {
    const issue = makeIssue({ number: 1, labels: ['high'] });
    expect(scoreIssue(issue, [])).toBe(60);
  });

  it('scores medium label at 40', () => {
    const issue = makeIssue({ number: 1, labels: ['medium'] });
    expect(scoreIssue(issue, [])).toBe(40);
  });

  it('scores low label at 20', () => {
    const issue = makeIssue({ number: 1, labels: ['low'] });
    expect(scoreIssue(issue, [])).toBe(20);
  });

  it('defaults to 40 when no priority label', () => {
    const issue = makeIssue({ number: 1, labels: ['bug'] });
    expect(scoreIssue(issue, [])).toBe(40);
  });

  it('adds +10 when issue blocks others', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const blocked = makeIssue({ number: 2, body: 'blocked by #1' });
    expect(scoreIssue(blocker, [blocker, blocked])).toBe(70); // 60 + 10
  });

  it('subtracts -10 when issue is blocked by open issue', () => {
    const blocker = makeIssue({ number: 1 });
    const blocked = makeIssue({ number: 2, labels: ['high'], body: 'blocked by #1' });
    expect(scoreIssue(blocked, [blocker, blocked])).toBe(50); // 60 - 10
  });

  it('adds +5 for low-complexity label', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'low-complexity'] });
    expect(scoreIssue(issue, [])).toBe(45); // 40 + 5
  });

  it('adds +5 for good-first-issue label', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'good first issue'] });
    expect(scoreIssue(issue, [])).toBe(45); // 40 + 5
  });
});

describe('prioritizeIssues', () => {
  it('returns empty array for empty input', () => {
    expect(prioritizeIssues([])).toEqual([]);
  });

  it('sorts by score descending', () => {
    const issues = [
      makeIssue({ number: 1, labels: ['low'] }),
      makeIssue({ number: 2, labels: ['critical'] }),
      makeIssue({ number: 3, labels: ['high'] }),
    ];
    const result = prioritizeIssues(issues);
    expect(result.map((r) => r.issue.number)).toEqual([2, 3, 1]);
  });

  it('respects dependency ordering — blocker before blocked', () => {
    const issues = [
      makeIssue({ number: 1, labels: ['low'], body: 'blocked by #2' }),
      makeIssue({ number: 2, labels: ['low'] }),
    ];
    const result = prioritizeIssues(issues);
    // #2 must come before #1 regardless of equal score
    expect(result.map((r) => r.issue.number)).toEqual([2, 1]);
  });

  it('handles dependency chain: A blocks B blocks C', () => {
    const issues = [
      makeIssue({ number: 3, labels: ['critical'], body: 'blocked by #2' }),
      makeIssue({ number: 1, labels: ['low'] }),
      makeIssue({ number: 2, labels: ['high'], body: 'blocked by #1' }),
    ];
    const result = prioritizeIssues(issues);
    // Topo order: 1 → 2 → 3
    const numbers = result.map((r) => r.issue.number);
    expect(numbers.indexOf(1)).toBeLessThan(numbers.indexOf(2));
    expect(numbers.indexOf(2)).toBeLessThan(numbers.indexOf(3));
  });

  it('includes score in result', () => {
    const issues = [makeIssue({ number: 1, labels: ['critical'] })];
    const result = prioritizeIssues(issues);
    expect(result[0]?.score).toBe(80);
  });

  it('includes blockedBy in result', () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2, body: 'blocked by #1' })];
    const result = prioritizeIssues(issues);
    const issue2 = result.find((r) => r.issue.number === 2);
    expect(issue2?.blockedBy).toEqual([1]);
  });

  it('ignores dependencies on issues not in the input set', () => {
    const issues = [makeIssue({ number: 5, body: 'blocked by #999' })];
    const result = prioritizeIssues(issues);
    expect(result).toHaveLength(1);
    // #999 not in set, so #5 is not actually blocked
    expect(result[0]?.blockedBy).toEqual([999]);
  });

  it('handles circular dependencies gracefully', () => {
    const issues = [makeIssue({ number: 1, body: 'blocked by #2' }), makeIssue({ number: 2, body: 'blocked by #1' })];
    // Should not throw, should return both issues
    const result = prioritizeIssues(issues);
    expect(result).toHaveLength(2);
  });
});
