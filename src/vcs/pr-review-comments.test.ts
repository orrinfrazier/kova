/**
 * Tests for fetchPRReviewComments in github.ts.
 *
 * Uses the same mock $ pattern as github-gh.test.ts to validate
 * argument construction, JSON parsing, bot filtering, and graceful
 * error handling without hitting GitHub.
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

const REVIEW_COMMENTS_FIXTURE = [
  {
    author: { login: 'alice' },
    body: 'This function needs better error handling.',
    path: 'src/services/github.ts',
    line: 42,
    createdAt: '2026-04-05T10:00:00Z',
  },
  {
    author: { login: 'bob' },
    body: 'Consider using a more descriptive variable name here.',
    path: 'src/utils/logger.ts',
    line: 15,
    createdAt: '2026-04-05T11:30:00Z',
  },
];

const MIXED_COMMENTS_FIXTURE = [
  {
    author: { login: 'alice' },
    body: 'Looks good overall, but fix the type.',
    path: 'src/index.ts',
    line: 10,
    createdAt: '2026-04-05T10:00:00Z',
  },
  {
    author: { login: 'kova' },
    body: 'Auto-generated comment: pipeline started.',
    path: null,
    line: null,
    createdAt: '2026-04-05T10:01:00Z',
  },
  {
    author: { login: 'github-actions' },
    body: 'Coverage report: 85%',
    path: null,
    line: null,
    createdAt: '2026-04-05T10:02:00Z',
  },
  {
    author: { login: 'charlie' },
    body: 'This edge case should be tested.',
    path: 'src/services/github.ts',
    line: 55,
    createdAt: '2026-04-05T12:00:00Z',
  },
];

const GENERAL_COMMENT_FIXTURE = [
  {
    author: { login: 'dave' },
    body: 'Overall the PR looks great.',
    path: null,
    line: null,
    createdAt: '2026-04-06T09:00:00Z',
  },
];

/* ------------------------------------------------------------------ */
/*  Import SUT after mock is installed                                 */
/* ------------------------------------------------------------------ */

const { fetchPRReviewComments } = await import('./github.js');

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => resetMock());

describe('fetchPRReviewComments', () => {
  it('returns structured review comments from a PR', async () => {
    setResponse('gh pr', { stdout: JSON.stringify(REVIEW_COMMENTS_FIXTURE) });
    const comments = await fetchPRReviewComments('/repo', 42);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      author: 'alice',
      body: 'This function needs better error handling.',
      path: 'src/services/github.ts',
      line: 42,
      createdAt: '2026-04-05T10:00:00Z',
    });
    expect(comments[1]).toEqual({
      author: 'bob',
      body: 'Consider using a more descriptive variable name here.',
      path: 'src/utils/logger.ts',
      line: 15,
      createdAt: '2026-04-05T11:30:00Z',
    });
  });

  it('filters out bot comments (kova, github-actions)', async () => {
    setResponse('gh pr', { stdout: JSON.stringify(MIXED_COMMENTS_FIXTURE) });
    const comments = await fetchPRReviewComments('/repo', 10);

    expect(comments).toHaveLength(2);
    const authors = comments.map((c: { author: string }) => c.author);
    expect(authors).toContain('alice');
    expect(authors).toContain('charlie');
    expect(authors).not.toContain('kova');
    expect(authors).not.toContain('github-actions');
  });

  it('returns empty array on gh CLI error (graceful degradation)', async () => {
    setResponse('gh pr', new Error('GraphQL: Could not resolve to a PullRequest'));
    const comments = await fetchPRReviewComments('/repo', 9999);

    expect(comments).toEqual([]);
  });

  it('returns empty array when no comments exist', async () => {
    setResponse('gh pr', { stdout: JSON.stringify([]) });
    const comments = await fetchPRReviewComments('/repo', 5);

    expect(comments).toEqual([]);
  });

  it('handles comments without path and line (general PR comments)', async () => {
    setResponse('gh pr', { stdout: JSON.stringify(GENERAL_COMMENT_FIXTURE) });
    const comments = await fetchPRReviewComments('/repo', 20);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      author: 'dave',
      body: 'Overall the PR looks great.',
      path: undefined,
      line: undefined,
      createdAt: '2026-04-06T09:00:00Z',
    });
  });

  it('passes the correct repo path as cwd', async () => {
    setResponse('gh pr', { stdout: JSON.stringify([]) });
    await fetchPRReviewComments('/some/other/repo', 7);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const ghCall = calls.find((c) => c.command.includes('gh'));
    expect(ghCall?.cwd).toBe('/some/other/repo');
  });

  it('passes the PR number to the gh command', async () => {
    setResponse('gh pr', { stdout: JSON.stringify([]) });
    await fetchPRReviewComments('/repo', 123);

    const ghCall = calls.find((c) => c.command.includes('gh'));
    expect(ghCall?.command).toContain('123');
  });
});
