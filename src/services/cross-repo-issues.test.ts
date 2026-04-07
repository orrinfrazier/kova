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

const { fetchCrossRepoIssues, formatCrossRepoContext } = await import('./cross-repo-issues.js');

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
