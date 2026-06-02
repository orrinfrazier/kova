import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock zx $ ---
// zx uses $({ cwd })`command` — options call returns a tagged template function.
const mock$ = vi.fn();
vi.mock('zx', () => ({
  $: Object.assign(
    (opts: Record<string, unknown>) =>
      (..._templateArgs: unknown[]) =>
        mock$(opts),
    { verbose: false },
  ),
}));

const {
  fetchCrossRepoIssues,
  formatCrossRepoContext,
  fetchSameRepoIssues,
  formatSameRepoContext,
  classifyProposalsAgainstOpenIssues,
} = await import('./cross-repo-issues.js');

describe('fetchCrossRepoIssues', () => {
  beforeEach(() => {
    mock$.mockReset();
  });

  it('fetches open issues from sibling repos, excluding current repo', async () => {
    const config = {
      repos: {
        'repo-a': { path: '/dev/repo-a' },
        'repo-b': { path: '/dev/repo-b' },
        current: { path: '/dev/current' },
      },
    };

    // Mock gh issue list for repo-a
    mock$.mockImplementation((opts: { cwd: string }) => {
      if (opts.cwd === '/dev/repo-a') {
        return Promise.resolve({
          stdout: JSON.stringify([
            { number: 1, title: 'Fix auth bug', labels: [{ name: 'bug' }] },
            { number: 2, title: 'Add caching layer', labels: [{ name: 'enhancement' }] },
          ]),
        });
      }
      if (opts.cwd === '/dev/repo-b') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 5, title: 'Improve logging', labels: [{ name: 'tech-debt' }] }]),
        });
      }
      return Promise.resolve({ stdout: '[]' });
    });

    const result = await fetchCrossRepoIssues('/dev/current', config);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.repo === 'repo-a')?.issues).toHaveLength(2);
    expect(result.find((r) => r.repo === 'repo-b')?.issues).toHaveLength(1);
    // Current repo should not be included
    expect(result.find((r) => r.repo === 'current')).toBeUndefined();
  });

  it('returns only titles and labels (lightweight)', async () => {
    const config = {
      repos: {
        sibling: { path: '/dev/sibling' },
        current: { path: '/dev/current' },
      },
    };

    mock$.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify([{ number: 1, title: 'Fix auth bug', labels: [{ name: 'bug' }, { name: 'security' }] }]),
      }),
    );

    const result = await fetchCrossRepoIssues('/dev/current', config);

    const issue = result[0]?.issues[0];
    expect(issue).toEqual({
      title: 'Fix auth bug',
      labels: ['bug', 'security'],
    });
    // Should NOT include body, number, or url
    expect(issue).not.toHaveProperty('body');
    expect(issue).not.toHaveProperty('number');
    expect(issue).not.toHaveProperty('url');
  });

  it('returns empty array when config has only the current repo', async () => {
    const config = {
      repos: {
        current: { path: '/dev/current' },
      },
    };

    const result = await fetchCrossRepoIssues('/dev/current', config);

    expect(result).toHaveLength(0);
    expect(mock$).not.toHaveBeenCalled();
  });

  it('returns empty array when no config provided', async () => {
    const result = await fetchCrossRepoIssues('/dev/current', undefined);

    expect(result).toHaveLength(0);
  });

  it('gracefully handles fetch failures for individual repos', async () => {
    const config = {
      repos: {
        'repo-a': { path: '/dev/repo-a' },
        'repo-b': { path: '/dev/repo-b' },
        current: { path: '/dev/current' },
      },
    };

    mock$.mockImplementation((opts: { cwd: string }) => {
      if (opts.cwd === '/dev/repo-a') {
        return Promise.reject(new Error('gh: not a git repo'));
      }
      return Promise.resolve({
        stdout: JSON.stringify([{ number: 5, title: 'Improve logging', labels: [{ name: 'tech-debt' }] }]),
      });
    });

    const result = await fetchCrossRepoIssues('/dev/current', config);

    // repo-a failed silently, repo-b succeeded
    expect(result).toHaveLength(1);
    expect(result[0]?.repo).toBe('repo-b');
  });

  it('matches current repo by resolved path', async () => {
    const config = {
      repos: {
        myrepo: { path: '/dev/current' },
        sibling: { path: '/dev/sibling' },
      },
    };

    mock$.mockImplementation(() => Promise.resolve({ stdout: JSON.stringify([]) }));

    const result = await fetchCrossRepoIssues('/dev/current', config);

    // myrepo should be excluded (same path as currentRepoPath)
    expect(result).toHaveLength(1);
    expect(result[0]?.repo).toBe('sibling');
  });
});

describe('formatCrossRepoContext', () => {
  it('formats issues as injectable context string', () => {
    const crossRepoIssues = [
      {
        repo: 'repo-a',
        issues: [
          { title: 'Fix auth bug', labels: ['bug', 'security'] },
          { title: 'Add caching layer', labels: ['enhancement'] },
        ],
      },
      {
        repo: 'repo-b',
        issues: [{ title: 'Improve logging', labels: ['tech-debt'] }],
      },
    ];

    const context = formatCrossRepoContext(crossRepoIssues);

    expect(context).toContain('repo-a');
    expect(context).toContain('Fix auth bug');
    expect(context).toContain('[bug, security]');
    expect(context).toContain('repo-b');
    expect(context).toContain('Improve logging');
    expect(context).toContain('already exist in related repos');
  });

  it('returns empty string when no cross-repo issues exist', () => {
    const context = formatCrossRepoContext([]);

    expect(context).toBe('');
  });

  it('returns empty string when all repos have empty issue lists', () => {
    const context = formatCrossRepoContext([
      { repo: 'repo-a', issues: [] },
      { repo: 'repo-b', issues: [] },
    ]);

    expect(context).toBe('');
  });
});

describe('fetchSameRepoIssues', () => {
  beforeEach(() => {
    mock$.mockReset();
  });

  it('fetches open issues from the current repo path', async () => {
    mock$.mockImplementation((opts: { cwd: string }) => {
      if (opts.cwd === '/dev/current') {
        return Promise.resolve({
          stdout: JSON.stringify([
            { number: 10, title: 'Same-repo issue A', labels: [{ name: 'bug' }] },
            { number: 11, title: 'Same-repo issue B', labels: [{ name: 'enhancement' }] },
          ]),
        });
      }
      return Promise.resolve({ stdout: '[]' });
    });

    const result = await fetchSameRepoIssues('/dev/current');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: 'Same-repo issue A', labels: ['bug'] });
    expect(result[1]).toEqual({ title: 'Same-repo issue B', labels: ['enhancement'] });
  });

  it('returns lightweight title+labels summaries only', async () => {
    mock$.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify([{ number: 1, title: 'Open issue', labels: [{ name: 'bug' }, { name: 'p1' }] }]),
      }),
    );

    const result = await fetchSameRepoIssues('/dev/current');

    expect(result[0]).toEqual({ title: 'Open issue', labels: ['bug', 'p1'] });
    expect(result[0]).not.toHaveProperty('body');
    expect(result[0]).not.toHaveProperty('number');
  });

  it('returns empty array gracefully when gh fails', async () => {
    mock$.mockImplementation(() => Promise.reject(new Error('gh: command failed')));

    const result = await fetchSameRepoIssues('/dev/current');

    expect(result).toEqual([]);
  });

  it('runs gh in the provided repo path as cwd', async () => {
    mock$.mockImplementation((opts: { cwd: string }) => {
      expect(opts.cwd).toBe('/dev/my-repo');
      return Promise.resolve({ stdout: '[]' });
    });

    await fetchSameRepoIssues('/dev/my-repo');

    expect(mock$).toHaveBeenCalled();
  });
});

describe('formatSameRepoContext', () => {
  it('formats issues as injectable context string', () => {
    const issues = [
      { title: 'Add dedup', labels: ['enhancement'] },
      { title: 'Fix race', labels: ['bug', 'p1'] },
    ];

    const context = formatSameRepoContext(issues);

    expect(context).toContain('already tracked');
    expect(context).toContain('Add dedup');
    expect(context).toContain('Fix race');
    expect(context).toContain('[bug, p1]');
  });

  it('returns empty string when no issues exist', () => {
    expect(formatSameRepoContext([])).toBe('');
  });
});

describe('classifyProposalsAgainstOpenIssues', () => {
  const makeProposal = (title: string, overrides: Record<string, unknown> = {}) => ({
    title,
    body: 'body',
    labels: [],
    priority: 'medium' as const,
    category: 'tech-debt' as const,
    confidence: 0.9,
    ...overrides,
  });

  it('classifies proposal matching an open-issue title as skipped (OPEN)', () => {
    const proposals = [makeProposal('Fix auth bug in middleware')];
    const openIssues = [{ title: 'Fix auth bug in middleware', labels: ['bug'] }];

    const result = classifyProposalsAgainstOpenIssues(proposals, openIssues);

    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.proposal.title).toBe('Fix auth bug in middleware');
    expect(result.skipped[0]?.matchedTitle).toBe('Fix auth bug in middleware');
  });

  it('classifies proposal with no similar open issue as kept (GAP)', () => {
    const proposals = [makeProposal('Add brand-new feature X')];
    const openIssues = [{ title: 'Fix auth bug', labels: [] }];

    const result = classifyProposalsAgainstOpenIssues(proposals, openIssues);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.title).toBe('Add brand-new feature X');
    expect(result.skipped).toHaveLength(0);
  });

  it('uses titleSimilarity threshold 0.7 by default', () => {
    // titleSimilarity is jaccard on word sets; "fetch open issues" vs "fetch open issues from gh"
    // → words: {fetch, open, issues} vs {fetch, open, issues, from, gh} → 3/5 = 0.6 → below default 0.7 → kept
    const proposals = [makeProposal('fetch open issues')];
    const openIssues = [{ title: 'fetch open issues from gh', labels: [] }];

    const result = classifyProposalsAgainstOpenIssues(proposals, openIssues);

    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('honors a custom threshold', () => {
    // Same setup as above (0.6 similarity) but lower the threshold to 0.5 → now skipped
    const proposals = [makeProposal('fetch open issues')];
    const openIssues = [{ title: 'fetch open issues from gh', labels: [] }];

    const result = classifyProposalsAgainstOpenIssues(proposals, openIssues, 0.5);

    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('returns all proposals as kept when openIssues is empty', () => {
    const proposals = [makeProposal('A'), makeProposal('B')];

    const result = classifyProposalsAgainstOpenIssues(proposals, []);

    expect(result.kept).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('skipped entry records the matched open-issue title', () => {
    const proposals = [makeProposal('Refactor brainstorm dedup logic')];
    const openIssues = [
      { title: 'Unrelated thing entirely', labels: [] },
      { title: 'Refactor brainstorm dedup logic', labels: ['tech-debt'] },
    ];

    const result = classifyProposalsAgainstOpenIssues(proposals, openIssues);

    expect(result.skipped[0]?.matchedTitle).toBe('Refactor brainstorm dedup logic');
  });
});
