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

describe('scoreIssue — base priority (canonical 80/60/30/10)', () => {
  it('scores critical label at 80 (bare)', () => {
    const issue = makeIssue({ number: 1, labels: ['critical'] });
    expect(scoreIssue(issue, [])).toBe(80);
  });

  it('scores priority:critical label at 80 (prefixed)', () => {
    const issue = makeIssue({ number: 1, labels: ['priority:critical'] });
    expect(scoreIssue(issue, [])).toBe(80);
  });

  it('scores high label at 60 (bare)', () => {
    const issue = makeIssue({ number: 1, labels: ['high'] });
    expect(scoreIssue(issue, [])).toBe(60);
  });

  it('scores priority:high label at 60 (prefixed)', () => {
    const issue = makeIssue({ number: 1, labels: ['priority:high'] });
    expect(scoreIssue(issue, [])).toBe(60);
  });

  it('scores medium label at 30 (canonical, was 40)', () => {
    const issue = makeIssue({ number: 1, labels: ['medium'] });
    expect(scoreIssue(issue, [])).toBe(30);
  });

  it('scores priority:medium label at 30 (prefixed)', () => {
    const issue = makeIssue({ number: 1, labels: ['priority:medium'] });
    expect(scoreIssue(issue, [])).toBe(30);
  });

  it('scores low label at 10 (canonical, was 20)', () => {
    const issue = makeIssue({ number: 1, labels: ['low'] });
    expect(scoreIssue(issue, [])).toBe(10);
  });

  it('scores priority:low label at 10 (prefixed)', () => {
    const issue = makeIssue({ number: 1, labels: ['priority:low'] });
    expect(scoreIssue(issue, [])).toBe(10);
  });

  it('defaults to 30 (medium) when no priority label', () => {
    const issue = makeIssue({ number: 1, labels: ['bug'] });
    expect(scoreIssue(issue, [])).toBe(30);
  });

  it('is case-insensitive for priority labels', () => {
    const issue = makeIssue({ number: 1, labels: ['Priority:Critical'] });
    expect(scoreIssue(issue, [])).toBe(80);
  });

  it('first matching priority label wins', () => {
    const issue = makeIssue({ number: 1, labels: ['priority:high', 'priority:low'] });
    expect(scoreIssue(issue, [])).toBe(60);
  });
});

describe('scoreIssue — dependency bonus (+5 per distinct dependent, capped)', () => {
  it('adds +5 for one downstream dependent', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const dep1 = makeIssue({ number: 2, body: 'blocked by #1' });
    expect(scoreIssue(blocker, [blocker, dep1])).toBe(65); // 60 + 5
  });

  it('adds +10 for two distinct downstream dependents', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const dep1 = makeIssue({ number: 2, body: 'blocked by #1' });
    const dep2 = makeIssue({ number: 3, body: 'depends on #1' });
    expect(scoreIssue(blocker, [blocker, dep1, dep2])).toBe(70); // 60 + 5 + 5
  });

  it('adds +15 for three distinct downstream dependents', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const dep1 = makeIssue({ number: 2, body: 'blocked by #1' });
    const dep2 = makeIssue({ number: 3, body: 'depends on #1' });
    const dep3 = makeIssue({ number: 4, body: 'blocked by #1' });
    expect(scoreIssue(blocker, [blocker, dep1, dep2, dep3])).toBe(75); // 60 + 15
  });

  it('caps dependency bonus at 5 dependents (+25 max)', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const deps = Array.from({ length: 10 }, (_, i) => makeIssue({ number: i + 2, body: 'blocked by #1' }));
    // 60 + 25 (capped at 5 deps) = 85
    expect(scoreIssue(blocker, [blocker, ...deps])).toBe(85);
  });

  it('counts each dependent only once even if mentioned twice in same body', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const dep = makeIssue({ number: 2, body: 'blocked by #1 and again depends on #1' });
    expect(scoreIssue(blocker, [blocker, dep])).toBe(65); // 60 + 5 (one distinct dep)
  });

  it('does not double-count: a dependent is +5 once not flat +10', () => {
    const blocker = makeIssue({ number: 1, labels: ['high'] });
    const dep = makeIssue({ number: 2, body: 'blocked by #1' });
    // Old formula: +10 flat. New: +5 per dependent = +5
    expect(scoreIssue(blocker, [blocker, dep])).toBe(65);
  });
});

describe('scoreIssue — blocked penalty (-10)', () => {
  it('subtracts -10 when issue is blocked by an open issue in the set', () => {
    const blocker = makeIssue({ number: 1 });
    const blocked = makeIssue({ number: 2, labels: ['high'], body: 'blocked by #1' });
    expect(scoreIssue(blocked, [blocker, blocked])).toBe(50); // 60 - 10
  });

  it('subtracts -10 when label is "blocked"', () => {
    const issue = makeIssue({ number: 1, labels: ['high', 'blocked'] });
    expect(scoreIssue(issue, [issue])).toBe(50); // 60 - 10
  });

  it('does not subtract when dependency is not in the input set', () => {
    const issue = makeIssue({ number: 1, labels: ['high'], body: 'blocked by #999' });
    expect(scoreIssue(issue, [issue])).toBe(60); // not blocked, blocker not open
  });
});

describe('scoreIssue — quick win bonus (+5)', () => {
  it('adds +5 for low-complexity label', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'low-complexity'] });
    expect(scoreIssue(issue, [])).toBe(35); // 30 + 5
  });

  it('adds +5 for good-first-issue label (hyphenated)', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'good-first-issue'] });
    expect(scoreIssue(issue, [])).toBe(35); // 30 + 5
  });

  it('adds +5 for "good first issue" label (spaced)', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'good first issue'] });
    expect(scoreIssue(issue, [])).toBe(35); // 30 + 5
  });

  it('adds +5 for quick-win label', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'quick-win'] });
    expect(scoreIssue(issue, [])).toBe(35); // 30 + 5
  });
});

describe('scoreIssue — rescope bonus (+20)', () => {
  it('adds +20 for rescoped label', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'rescoped'] });
    expect(scoreIssue(issue, [])).toBe(50); // 30 + 20
  });

  it('rescope bonus stacks with priority + quick-win', () => {
    const issue = makeIssue({ number: 1, labels: ['high', 'rescoped', 'quick-win'] });
    expect(scoreIssue(issue, [])).toBe(85); // 60 + 20 + 5
  });

  it('does not double-apply when multiple rescope-style labels present', () => {
    const issue = makeIssue({ number: 1, labels: ['medium', 'rescoped'] });
    expect(scoreIssue(issue, [])).toBe(50);
  });
});

describe('scoreIssue — combined factors', () => {
  it('critical + one dependent + quick-win = 80 + 5 + 5 = 90', () => {
    const blocker = makeIssue({ number: 1, labels: ['priority:critical', 'quick-win'] });
    const dep = makeIssue({ number: 2, body: 'blocked by #1' });
    expect(scoreIssue(blocker, [blocker, dep])).toBe(90);
  });

  it('high + blocked + rescoped = 60 - 10 + 20 = 70', () => {
    const blocker = makeIssue({ number: 1 });
    const issue = makeIssue({
      number: 2,
      labels: ['priority:high', 'rescoped'],
      body: 'blocked by #1',
    });
    expect(scoreIssue(issue, [blocker, issue])).toBe(70);
  });
});

describe('prioritizeIssues — breakdown surfaced', () => {
  it('returns empty array for empty input', () => {
    expect(prioritizeIssues([])).toEqual([]);
  });

  it('includes per-factor breakdown on each PrioritizedIssue', () => {
    const issues = [makeIssue({ number: 1, labels: ['priority:critical'] })];
    const result = prioritizeIssues(issues);
    expect(result[0]?.breakdown).toBeDefined();
    expect(result[0]?.breakdown.base_priority).toBe(80);
    expect(result[0]?.breakdown.dependency_bonus).toBe(0);
    expect(result[0]?.breakdown.blocked_penalty).toBe(0);
    expect(result[0]?.breakdown.quick_win_bonus).toBe(0);
    expect(result[0]?.breakdown.rescope_bonus).toBe(0);
  });

  it('breakdown sum equals score', () => {
    const blocker = makeIssue({ number: 1, labels: ['priority:high', 'rescoped', 'quick-win'] });
    const dep = makeIssue({ number: 2, body: 'blocked by #1' });
    const result = prioritizeIssues([blocker, dep]);
    const first = result.find((r) => r.issue.number === 1);
    expect(first).toBeDefined();
    if (first === undefined) return;
    const sum =
      first.breakdown.base_priority +
      first.breakdown.dependency_bonus +
      first.breakdown.blocked_penalty +
      first.breakdown.quick_win_bonus +
      first.breakdown.rescope_bonus;
    expect(sum).toBe(first.score);
  });

  it('breakdown reflects dependency bonus per dependent', () => {
    const blocker = makeIssue({ number: 1, labels: ['priority:high'] });
    const dep1 = makeIssue({ number: 2, body: 'blocked by #1' });
    const dep2 = makeIssue({ number: 3, body: 'blocked by #1' });
    const result = prioritizeIssues([blocker, dep1, dep2]);
    const first = result.find((r) => r.issue.number === 1);
    expect(first?.breakdown.dependency_bonus).toBe(10); // 2 deps × +5
  });
});

describe('prioritizeIssues', () => {
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
