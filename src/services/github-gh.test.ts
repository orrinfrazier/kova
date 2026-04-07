/**
 * Tests for github.ts functions that call the `gh` CLI.
 *
 * Uses a mock $ that records calls and returns fixture data so we can
 * validate argument construction and JSON parsing without hitting GitHub.
 *
 * branchExistsOnRemote is tested separately in github.test.ts with real git.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  gh CLI mock helper                                                 */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  command: string;
  cwd: string | undefined;
}

/** Reconstruct the shell command from a tagged-template invocation. */
function buildCommand(strings: TemplateStringsArray, values: unknown[]): string {
  let cmd = '';
  for (let i = 0; i < strings.length; i++) {
    cmd += strings[i];
    if (i < values.length) {
      const val = values[i];
      cmd += Array.isArray(val) ? val.join(' ') : String(val);
    }
  }
  return cmd;
}

const calls: RecordedCall[] = [];
let responses: Array<{ pattern: string | RegExp; value: { stdout: string } | Error }> = [];

function setResponse(pattern: string | RegExp, value: { stdout: string } | Error): void {
  responses.push({ pattern, value });
}

function findResponse(command: string): { stdout: string } | Error {
  for (const { pattern, value } of responses) {
    if (typeof pattern === 'string' ? command.includes(pattern) : pattern.test(command)) {
      return value;
    }
  }
  return { stdout: '' };
}

function resetMock(): void {
  calls.length = 0;
  responses = [];
}

function handleCall(
  options: Record<string, unknown> | null,
  strings: TemplateStringsArray,
  values: unknown[],
): Promise<{ stdout: string }> {
  const command = buildCommand(strings, values);
  calls.push({ command, cwd: (options?.cwd as string) ?? undefined });
  const response = findResponse(command);
  if (response instanceof Error) return Promise.reject(response);
  return Promise.resolve(response);
}

/* vi.mock is hoisted — must use inline factory */
vi.mock('zx', () => {
  // Build a $ that works as both tagged-template and $({cwd})`...`
  const $ = new Proxy(() => {}, {
    apply(
      _target: unknown,
      _thisArg: unknown,
      argsList: [TemplateStringsArray | Record<string, unknown>, ...unknown[]],
    ) {
      const first = argsList[0];
      // Tagged-template: first arg has .raw
      if (first != null && typeof first === 'object' && 'raw' in first) {
        return handleCall(null, first as TemplateStringsArray, argsList.slice(1));
      }
      // Options call: $({ cwd }) → returns tagged-template fn
      const options = first as Record<string, unknown>;
      return (strings: TemplateStringsArray, ...values: unknown[]) => handleCall(options, strings, values);
    },
    set() {
      return true;
    }, // absorb $.verbose = false
    get(_target: unknown, prop: string | symbol) {
      if (prop === 'verbose') return false;
      return undefined;
    },
  });
  return { $ };
});

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ISSUE_FIXTURE = {
  number: 42,
  title: 'Fix login bug',
  body: 'The login form crashes on empty input',
  labels: [{ name: 'bug' }, { name: 'urgent' }],
  url: 'https://github.com/owner/repo/issues/42',
};

const ISSUE_LIST_FIXTURE = [
  ISSUE_FIXTURE,
  {
    number: 99,
    title: 'Add dark mode',
    body: 'Support dark mode theme',
    labels: [{ name: 'feature' }],
    url: 'https://github.com/owner/repo/issues/99',
  },
];

const PR_LIST_FIXTURE = [
  { number: 10, title: 'fix: Login crash', headRefName: 'kova/fix-42' },
  { number: 11, title: 'feat: Dark mode', headRefName: 'kova/fix-99' },
];

/* ------------------------------------------------------------------ */
/*  Import SUT after mock is installed                                 */
/* ------------------------------------------------------------------ */

const {
  fetchIssues,
  fetchIssue,
  commentOnIssue,
  createPR,
  createIssue,
  createIssueComment,
  editIssueComment,
  listOpenPRs,
  findOpenPR,
  hasExistingWork,
  fetchKovaPRsWithStatus,
  mergePR,
  rebasePROnDefault,
  fetchPRDependencies,
} = await import('./github.js');

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => resetMock());

/* ---------- fetchIssues ------------------------------------------ */

describe('fetchIssues', () => {
  it('constructs correct gh arguments without filter', async () => {
    setResponse('gh issue list', { stdout: JSON.stringify(ISSUE_LIST_FIXTURE) });
    await fetchIssues('/repo');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh issue list --state open --json number,title,body,labels,url --limit 50');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('adds --label flag when filter is provided', async () => {
    setResponse('gh issue list', { stdout: JSON.stringify(ISSUE_LIST_FIXTURE) });
    await fetchIssues('/repo', 'bug');

    expect(calls[0]?.command).toContain('--label bug');
  });

  it('maps raw labels to string array', async () => {
    setResponse('gh issue list', { stdout: JSON.stringify(ISSUE_LIST_FIXTURE) });
    const issues = await fetchIssues('/repo');

    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      number: 42,
      title: 'Fix login bug',
      body: 'The login form crashes on empty input',
      labels: ['bug', 'urgent'],
      url: 'https://github.com/owner/repo/issues/42',
    });
    expect(issues[1]?.labels).toEqual(['feature']);
  });

  it('returns empty array for empty list', async () => {
    setResponse('gh issue list', { stdout: '[]' });
    const issues = await fetchIssues('/repo');
    expect(issues).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    setResponse('gh issue list', { stdout: 'not json' });
    await expect(fetchIssues('/repo')).rejects.toThrow();
  });
});

/* ---------- fetchIssue ------------------------------------------- */

describe('fetchIssue', () => {
  it('constructs correct gh arguments with issue number', async () => {
    setResponse('gh issue view', { stdout: JSON.stringify(ISSUE_FIXTURE) });
    await fetchIssue('/repo', 42);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh issue view 42 --json number,title,body,labels,url');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('maps raw labels to string array', async () => {
    setResponse('gh issue view', { stdout: JSON.stringify(ISSUE_FIXTURE) });
    const issue = await fetchIssue('/repo', 42);

    expect(issue).toEqual({
      number: 42,
      title: 'Fix login bug',
      body: 'The login form crashes on empty input',
      labels: ['bug', 'urgent'],
      url: 'https://github.com/owner/repo/issues/42',
    });
  });

  it('throws on malformed JSON', async () => {
    setResponse('gh issue view', { stdout: '{invalid' });
    await expect(fetchIssue('/repo', 1)).rejects.toThrow();
  });

  it('throws on non-zero exit (gh error)', async () => {
    setResponse('gh issue view', new Error('issue not found'));
    await expect(fetchIssue('/repo', 9999)).rejects.toThrow('issue not found');
  });
});

/* ---------- commentOnIssue --------------------------------------- */

describe('commentOnIssue', () => {
  it('constructs correct gh arguments', async () => {
    setResponse('gh issue comment', { stdout: '' });
    await commentOnIssue('/repo', 42, 'Pipeline started');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh issue comment 42 --body Pipeline started');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('passes body with special characters', async () => {
    setResponse('gh issue comment', { stdout: '' });
    await commentOnIssue('/repo', 7, 'Line 1\nLine 2');

    expect(calls[0]?.command).toContain('Line 1\nLine 2');
  });

  it('throws on gh error', async () => {
    setResponse('gh issue comment', new Error('permission denied'));
    await expect(commentOnIssue('/repo', 42, 'test')).rejects.toThrow('permission denied');
  });
});

/* ---------- createPR --------------------------------------------- */

describe('createPR', () => {
  it('constructs correct gh arguments', async () => {
    setResponse('gh pr create', { stdout: 'https://github.com/owner/repo/pull/10\n' });
    await createPR('/repo', 'kova/fix-42', 'fix: Login crash', 'Fixes #42');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh pr create --title fix: Login crash --body Fixes #42 --head kova/fix-42');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('returns trimmed PR URL', async () => {
    setResponse('gh pr create', { stdout: '  https://github.com/owner/repo/pull/10  \n' });
    const url = await createPR('/repo', 'kova/fix-42', 'title', 'body');
    expect(url).toBe('https://github.com/owner/repo/pull/10');
  });

  it('throws on gh error', async () => {
    setResponse('gh pr create', new Error('branch has no commits'));
    await expect(createPR('/repo', 'empty', 'title', 'body')).rejects.toThrow('branch has no commits');
  });
});

/* ---------- listOpenPRs ------------------------------------------ */

describe('listOpenPRs', () => {
  it('constructs correct gh arguments', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify(PR_LIST_FIXTURE) });
    await listOpenPRs('/repo');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh pr list --state open --json number,title,headRefName --limit 20');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('formats PR entries as "#N: title (branch)"', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify(PR_LIST_FIXTURE) });
    const prs = await listOpenPRs('/repo');

    expect(prs).toEqual(['#10: fix: Login crash (kova/fix-42)', '#11: feat: Dark mode (kova/fix-99)']);
  });

  it('returns empty array when no open PRs', async () => {
    setResponse('gh pr list', { stdout: '[]' });
    const prs = await listOpenPRs('/repo');
    expect(prs).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    setResponse('gh pr list', { stdout: 'bad' });
    await expect(listOpenPRs('/repo')).rejects.toThrow();
  });
});

/* ---------- findOpenPR ------------------------------------------- */

describe('findOpenPR', () => {
  it('constructs correct gh arguments with branch filter', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/10' }]),
    });
    await findOpenPR('/repo', 'kova/fix-42');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gh pr list --state open --head kova/fix-42 --json url --limit 1');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('returns URL when PR exists', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/10' }]),
    });
    const url = await findOpenPR('/repo', 'kova/fix-42');
    expect(url).toBe('https://github.com/owner/repo/pull/10');
  });

  it('returns undefined when no PR exists', async () => {
    setResponse('gh pr list', { stdout: '[]' });
    const url = await findOpenPR('/repo', 'kova/fix-999');
    expect(url).toBeUndefined();
  });

  it('throws on malformed JSON', async () => {
    setResponse('gh pr list', { stdout: '{{' });
    await expect(findOpenPR('/repo', 'x')).rejects.toThrow();
  });
});

/* ---------- hasExistingWork -------------------------------------- */

describe('hasExistingWork', () => {
  it('returns undefined when no branch and no PR exist', async () => {
    // branchExistsOnRemote: git ls-remote exits with error → false
    setResponse('git ls-remote', new Error('not found'));
    // findOpenPR: gh pr list returns empty
    setResponse('gh pr list', { stdout: '[]' });

    const result = await hasExistingWork('/repo', 42);
    expect(result).toBeUndefined();
  });

  it('returns PR reason when open PR exists', async () => {
    setResponse('git ls-remote', new Error('not found'));
    setResponse('gh pr list', {
      stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/10' }]),
    });

    const result = await hasExistingWork('/repo', 42);
    expect(result).toEqual({
      reason: 'Open PR exists for kova/fix-42: https://github.com/owner/repo/pull/10',
      prUrl: 'https://github.com/owner/repo/pull/10',
    });
  });

  it('returns branch reason when branch exists but no PR', async () => {
    // branchExistsOnRemote succeeds (git ls-remote exits 0)
    setResponse('git ls-remote', { stdout: 'abc123\trefs/heads/kova/fix-42' });
    setResponse('gh pr list', { stdout: '[]' });

    const result = await hasExistingWork('/repo', 42);
    expect(result).toEqual({
      reason: 'Branch kova/fix-42 already exists on remote',
    });
  });

  it('prefers PR reason over branch-only reason', async () => {
    // Both branch and PR exist
    setResponse('git ls-remote', { stdout: 'abc123\trefs/heads/kova/fix-42' });
    setResponse('gh pr list', {
      stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/5' }]),
    });

    const result = await hasExistingWork('/repo', 42);
    expect(result?.prUrl).toBe('https://github.com/owner/repo/pull/5');
    expect(result?.reason).toContain('Open PR exists');
  });

  it('uses correct branch name pattern kova/fix-{issueNumber}', async () => {
    setResponse('git ls-remote', new Error('not found'));
    setResponse('gh pr list', { stdout: '[]' });

    await hasExistingWork('/repo', 777);

    const gitCall = calls.find((c) => c.command.includes('git ls-remote'));
    expect(gitCall?.command).toContain('kova/fix-777');

    const ghCall = calls.find((c) => c.command.includes('gh pr list'));
    expect(ghCall?.command).toContain('--head kova/fix-777');
  });
});

/* ---------- createIssue ----------------------------------------- */

describe('createIssue', () => {
  it('constructs correct gh arguments', async () => {
    setResponse('gh issue create', {
      stdout: JSON.stringify({ number: 50, url: 'https://github.com/owner/repo/issues/50' }),
    });
    await createIssue('/repo', 'New bug', 'Bug description', ['bug', 'urgent']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toContain('gh issue create');
    expect(calls[0]?.command).toContain('--title New bug');
    expect(calls[0]?.command).toContain('--body Bug description');
    expect(calls[0]?.command).toContain('--label bug');
    expect(calls[0]?.command).toContain('--label urgent');
    expect(calls[0]?.cwd).toBe('/repo');
  });

  it('returns created issue number and URL', async () => {
    setResponse('gh issue create', {
      stdout: JSON.stringify({ number: 50, url: 'https://github.com/owner/repo/issues/50' }),
    });
    const result = await createIssue('/repo', 'Title', 'Body', []);

    expect(result.number).toBe(50);
    expect(result.url).toBe('https://github.com/owner/repo/issues/50');
  });

  it('handles issues with no labels', async () => {
    setResponse('gh issue create', {
      stdout: JSON.stringify({ number: 51, url: 'https://github.com/owner/repo/issues/51' }),
    });
    await createIssue('/repo', 'No labels', 'Body', []);

    expect(calls[0]?.command).not.toContain('--label');
  });

  it('throws on gh error', async () => {
    setResponse('gh issue create', new Error('permission denied'));
    await expect(createIssue('/repo', 'Title', 'Body', [])).rejects.toThrow('permission denied');
  });
});

/* ---------- createIssueComment ---------------------------------- */

describe('createIssueComment', () => {
  it('calls gh api to create comment and returns comment ID', async () => {
    setResponse('gh api', { stdout: JSON.stringify({ id: 12345 }) });
    const id = await createIssueComment('owner/repo', 42, 'Progress update');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toContain('repos/owner/repo/issues/42/comments');
    expect(calls[0]?.command).toContain('-f body=');
    expect(id).toBe(12345);
  });

  it('throws on API error', async () => {
    setResponse('gh api', new Error('Not Found'));
    await expect(createIssueComment('owner/repo', 42, 'test')).rejects.toThrow('Not Found');
  });
});

/* ---------- editIssueComment ------------------------------------ */

describe('editIssueComment', () => {
  it('calls gh api to patch comment by ID', async () => {
    setResponse('gh api', { stdout: JSON.stringify({ id: 12345 }) });
    await editIssueComment('owner/repo', 12345, 'Updated body');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toContain('repos/owner/repo/issues/comments/12345');
    expect(calls[0]?.command).toContain('-X PATCH');
    expect(calls[0]?.command).toContain('-f body=');
  });

  it('throws on API error', async () => {
    setResponse('gh api', new Error('Forbidden'));
    await expect(editIssueComment('owner/repo', 12345, 'test')).rejects.toThrow('Forbidden');
  });
});

/* ------------------------------------------------------------------ */
/*  New fixtures for PR status tests                                   */
/* ------------------------------------------------------------------ */

const KOVA_PR_LIST_FIXTURE = [
  { number: 10, title: 'fix: Login crash', headRefName: 'kova/fix-42', url: 'https://github.com/owner/repo/pull/10' },
  { number: 11, title: 'feat: Dark mode', headRefName: 'kova/fix-99', url: 'https://github.com/owner/repo/pull/11' },
  { number: 12, title: 'chore: cleanup', headRefName: 'main', url: 'https://github.com/owner/repo/pull/12' }, // should be filtered
];

const PR_VIEW_SUCCESS_FIXTURE = {
  number: 10,
  statusCheckRollup: [{ state: 'SUCCESS' }, { state: 'SUCCESS' }],
};

const PR_VIEW_FAILURE_FIXTURE = {
  number: 11,
  statusCheckRollup: [{ state: 'SUCCESS' }, { state: 'FAILURE' }],
};

const PR_VIEW_PENDING_FIXTURE = {
  number: 10,
  statusCheckRollup: [{ state: 'PENDING' }],
};

const PR_VIEW_EMPTY_FIXTURE = {
  number: 10,
  statusCheckRollup: [],
};

/* ---------- fetchKovaPRsWithStatus --------------------------------- */

describe('fetchKovaPRsWithStatus', () => {
  it('fetches kova PRs and enriches with CI status', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify(KOVA_PR_LIST_FIXTURE) });
    setResponse(/gh pr view 10/, { stdout: JSON.stringify(PR_VIEW_SUCCESS_FIXTURE) });
    setResponse(/gh pr view 11/, { stdout: JSON.stringify(PR_VIEW_SUCCESS_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs).toHaveLength(2); // PR #12 on 'main' filtered out
    for (const pr of prs) {
      expect(pr).toHaveProperty('ciStatus');
    }
  });

  it('returns ciStatus "success" when all checks pass', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 10,
          title: 'fix: Login crash',
          headRefName: 'kova/fix-42',
          url: 'https://github.com/owner/repo/pull/10',
        },
      ]),
    });
    setResponse(/gh pr view 10/, { stdout: JSON.stringify(PR_VIEW_SUCCESS_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs[0]?.ciStatus).toBe('success');
  });

  it('returns ciStatus "failure" when any check fails', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 11,
          title: 'feat: Dark mode',
          headRefName: 'kova/fix-99',
          url: 'https://github.com/owner/repo/pull/11',
        },
      ]),
    });
    setResponse(/gh pr view 11/, { stdout: JSON.stringify(PR_VIEW_FAILURE_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs[0]?.ciStatus).toBe('failure');
  });

  it('returns ciStatus "pending" when checks are running', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 10,
          title: 'fix: Login crash',
          headRefName: 'kova/fix-42',
          url: 'https://github.com/owner/repo/pull/10',
        },
      ]),
    });
    setResponse(/gh pr view 10/, { stdout: JSON.stringify(PR_VIEW_PENDING_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs[0]?.ciStatus).toBe('pending');
  });

  it('returns ciStatus "unknown" when no statusCheckRollup data', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 10,
          title: 'fix: Login crash',
          headRefName: 'kova/fix-42',
          url: 'https://github.com/owner/repo/pull/10',
        },
      ]),
    });
    setResponse(/gh pr view 10/, { stdout: JSON.stringify(PR_VIEW_EMPTY_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs[0]?.ciStatus).toBe('unknown');
  });

  it('filters to only kova/ and fix/issue- branches', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 10,
          title: 'fix: Login crash',
          headRefName: 'kova/fix-42',
          url: 'https://github.com/owner/repo/pull/10',
        },
        {
          number: 11,
          title: 'feat: Dark mode',
          headRefName: 'fix/issue-99',
          url: 'https://github.com/owner/repo/pull/11',
        },
        { number: 12, title: 'chore: cleanup', headRefName: 'main', url: 'https://github.com/owner/repo/pull/12' },
        {
          number: 13,
          title: 'docs: update',
          headRefName: 'feature/new-ui',
          url: 'https://github.com/owner/repo/pull/13',
        },
      ]),
    });
    setResponse(/gh pr view 10/, { stdout: JSON.stringify(PR_VIEW_SUCCESS_FIXTURE) });
    setResponse(/gh pr view 11/, { stdout: JSON.stringify(PR_VIEW_SUCCESS_FIXTURE) });

    const prs = await fetchKovaPRsWithStatus('/repo');

    expect(prs).toHaveLength(2);
    const branches = prs.map((pr) => pr.branch);
    expect(branches).toContain('kova/fix-42');
    expect(branches).toContain('fix/issue-99');
  });
});

/* ---------- mergePR ------------------------------------------------ */

describe('mergePR', () => {
  it('calls gh pr merge with --squash --delete-branch', async () => {
    setResponse(/gh pr merge/, { stdout: '' });

    await mergePR('/repo', 10);

    const mergeCall = calls.find((c) => c.command.includes('gh pr merge'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall?.command).toContain('--squash');
    expect(mergeCall?.command).toContain('--delete-branch');
  });

  it('uses correct prNumber in command', async () => {
    setResponse(/gh pr merge/, { stdout: '' });

    await mergePR('/repo', 42);

    const mergeCall = calls.find((c) => c.command.includes('gh pr merge'));
    expect(mergeCall?.command).toContain('42');
  });

  it('uses correct cwd', async () => {
    setResponse(/gh pr merge/, { stdout: '' });

    await mergePR('/my/repo/path', 10);

    const mergeCall = calls.find((c) => c.command.includes('gh pr merge'));
    expect(mergeCall?.cwd).toBe('/my/repo/path');
  });

  it('returns { merged: true, sha } on success', async () => {
    setResponse(/gh pr merge/, { stdout: '' });

    const result = await mergePR('/repo', 10);

    expect(result.merged).toBe(true);
    expect(typeof result.sha).toBe('string');
  });

  it('throws on gh error (e.g., PR has conflicts)', async () => {
    setResponse(/gh pr merge/, new Error('Pull request is not mergeable'));

    await expect(mergePR('/repo', 10)).rejects.toThrow('Pull request is not mergeable');
  });
});

/* ---------- rebasePROnDefault -------------------------------------- */

describe('rebasePROnDefault', () => {
  it('calls gh pr update-branch with correct prNumber', async () => {
    setResponse(/gh pr update-branch/, { stdout: '' });

    await rebasePROnDefault('/repo', 10);

    const rebaseCall = calls.find((c) => c.command.includes('gh pr update-branch'));
    expect(rebaseCall).toBeDefined();
    expect(rebaseCall?.command).toContain('10');
  });

  it('uses correct cwd', async () => {
    setResponse(/gh pr update-branch/, { stdout: '' });

    await rebasePROnDefault('/my/repo/path', 10);

    const rebaseCall = calls.find((c) => c.command.includes('gh pr update-branch'));
    expect(rebaseCall?.cwd).toBe('/my/repo/path');
  });

  it('does not throw when branch is already up to date', async () => {
    setResponse(/gh pr update-branch/, { stdout: 'Already up to date' });

    await expect(rebasePROnDefault('/repo', 10)).resolves.not.toThrow();
  });

  it('throws on git error', async () => {
    setResponse(/gh pr update-branch/, new Error('merge conflict'));

    await expect(rebasePROnDefault('/repo', 10)).rejects.toThrow('merge conflict');
  });
});

/* ---------- fetchPRDependencies ------------------------------------ */

describe('fetchPRDependencies', () => {
  it('parses "Depends on #5" from body', () => {
    const deps = fetchPRDependencies('This PR depends on work from another branch.\n\nDepends on #5\n\nPlease review.');
    expect(deps).toContain(5);
  });

  it('parses "Closes #3" from body', () => {
    const deps = fetchPRDependencies('This PR closes another issue.\n\nCloses #3\n');
    expect(deps).toContain(3);
  });

  it('parses multiple dependencies: "Depends on #5, Depends on #7"', () => {
    const deps = fetchPRDependencies('Depends on #5\nDepends on #7\n');
    expect(deps).toContain(5);
    expect(deps).toContain(7);
    expect(deps).toHaveLength(2);
  });

  it('returns empty array for body with no dependency markers', () => {
    const deps = fetchPRDependencies('This is a standalone PR with no dependencies.');
    expect(deps).toEqual([]);
  });

  it('handles case-insensitive matching ("depends on #5")', () => {
    const deps = fetchPRDependencies('depends on #5');
    expect(deps).toContain(5);
  });

  it('handles case-insensitive matching ("DEPENDS ON #5")', () => {
    const deps = fetchPRDependencies('DEPENDS ON #5');
    expect(deps).toContain(5);
  });

  it('handles mixed formats in same body', () => {
    const body = 'Depends on #5\nCloses #3\nSome other text\nDepends on #7';
    const deps = fetchPRDependencies(body);
    expect(deps).toContain(5);
    expect(deps).toContain(3);
    expect(deps).toContain(7);
  });

  it('returns unique numbers (no duplicates)', () => {
    const body = 'Depends on #5\nDepends on #5\nCloses #5';
    const deps = fetchPRDependencies(body);
    const fivesCount = deps.filter((n) => n === 5).length;
    expect(fivesCount).toBe(1);
  });
});
