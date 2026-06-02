// Tests for cross-repo dependency awareness (issue #287).
//
// The cross-repo scheduler builds tiers of repos: every repo in tier N must
// finish before any dependent repo in tier N+1 can start. Intra-repo
// dependencies are still resolved downstream via buildDependencyTiers.

import { describe, expect, it } from 'vitest';
import type { Issue } from '../types/index.js';
import { buildCrossRepoTiers, type RepoTierEntry } from './cross-repo-scheduler.js';

function makeIssue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue #${overrides.number}`,
    body: '',
    labels: [],
    url: `https://github.com/test/repo/issues/${overrides.number}`,
    ...overrides,
  };
}

describe('buildCrossRepoTiers', () => {
  it('returns empty when no repos given', () => {
    expect(buildCrossRepoTiers({ reposByName: new Map(), slugByName: new Map() })).toEqual([]);
  });

  it('returns single tier with all repos when no cross-repo deps exist', () => {
    const repoA: Issue[] = [makeIssue({ number: 1 })];
    const repoB: Issue[] = [makeIssue({ number: 2 })];
    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', repoA],
        ['repo-b', repoB],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
      ]),
    });

    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.map((e: RepoTierEntry) => e.repoName).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('orders blocker repo before dependent repo (2-tier chain)', () => {
    const repoA: Issue[] = [makeIssue({ number: 1 })];
    const repoB: Issue[] = [makeIssue({ number: 2, body: 'blocked by owner/repo-a#1' })];

    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', repoA],
        ['repo-b', repoB],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
      ]),
    });

    expect(tiers).toHaveLength(2);
    expect(tiers[0]?.map((e: RepoTierEntry) => e.repoName)).toEqual(['repo-a']);
    expect(tiers[1]?.map((e: RepoTierEntry) => e.repoName)).toEqual(['repo-b']);
  });

  it('preserves all input issues on each repo tier entry', () => {
    const issueA1 = makeIssue({ number: 1, title: 'A1' });
    const issueA2 = makeIssue({ number: 2, title: 'A2' });
    const issueB1 = makeIssue({ number: 5, title: 'B1', body: 'blocked by owner/repo-a#1' });

    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', [issueA1, issueA2]],
        ['repo-b', [issueB1]],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
      ]),
    });

    const tier0Names = tiers[0]?.map((e) => e.repoName);
    expect(tier0Names).toContain('repo-a');
    const entryA = tiers[0]?.find((e) => e.repoName === 'repo-a');
    expect(entryA?.issues).toHaveLength(2);
    const entryB = tiers[1]?.find((e) => e.repoName === 'repo-b');
    expect(entryB?.issues).toHaveLength(1);
    expect(entryB?.issues[0]?.number).toBe(5);
  });

  it('handles 3-tier chain: a -> b -> c', () => {
    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', [makeIssue({ number: 1 })]],
        ['repo-b', [makeIssue({ number: 2, body: 'blocked by owner/repo-a#1' })]],
        ['repo-c', [makeIssue({ number: 3, body: 'depends on owner/repo-b#2' })]],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
        ['repo-c', 'owner/repo-c'],
      ]),
    });

    expect(tiers).toHaveLength(3);
    expect(tiers[0]?.map((e) => e.repoName)).toEqual(['repo-a']);
    expect(tiers[1]?.map((e) => e.repoName)).toEqual(['repo-b']);
    expect(tiers[2]?.map((e) => e.repoName)).toEqual(['repo-c']);
  });

  it('groups parallel repos with no cross-repo blockers into the same tier', () => {
    // a is a blocker for b. c is independent. Tier 0: {a, c}, Tier 1: {b}.
    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', [makeIssue({ number: 1 })]],
        ['repo-b', [makeIssue({ number: 2, body: 'blocked by owner/repo-a#1' })]],
        ['repo-c', [makeIssue({ number: 3 })]],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
        ['repo-c', 'owner/repo-c'],
      ]),
    });

    expect(tiers).toHaveLength(2);
    expect(tiers[0]?.map((e) => e.repoName).sort()).toEqual(['repo-a', 'repo-c']);
    expect(tiers[1]?.map((e) => e.repoName)).toEqual(['repo-b']);
  });

  it('ignores deps that reference repos not in the configured set', () => {
    // repo-b references owner/external#99, which is not configured.
    // External repos are out of scope; repo-b should run in tier 0.
    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', [makeIssue({ number: 1 })]],
        ['repo-b', [makeIssue({ number: 2, body: 'blocked by owner/external#99' })]],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
      ]),
    });

    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.map((e) => e.repoName).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('breaks cycles by forcing remaining repos into the final tier', () => {
    // repo-a blocked by repo-b; repo-b blocked by repo-a. Cycle.
    const tiers = buildCrossRepoTiers({
      reposByName: new Map([
        ['repo-a', [makeIssue({ number: 1, body: 'blocked by owner/repo-b#2' })]],
        ['repo-b', [makeIssue({ number: 2, body: 'blocked by owner/repo-a#1' })]],
      ]),
      slugByName: new Map([
        ['repo-a', 'owner/repo-a'],
        ['repo-b', 'owner/repo-b'],
      ]),
    });

    // Should not throw, should include both repos somewhere
    const allNames = tiers.flatMap((t) => t.map((e) => e.repoName)).sort();
    expect(allNames).toEqual(['repo-a', 'repo-b']);
  });
});
