/**
 * Tests for fetchPRReviewState and replyToReviewComment in github.ts (issue #256).
 *
 * Mirrors the mock-`$` pattern used by pr-review-comments.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  gh CLI mock helper                                                 */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  command: string;
  cwd: string | undefined;
}

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

vi.mock('zx', () => {
  const $ = new Proxy(() => {}, {
    apply(
      _target: unknown,
      _thisArg: unknown,
      argsList: [TemplateStringsArray | Record<string, unknown>, ...unknown[]],
    ) {
      const first = argsList[0];
      if (first != null && typeof first === 'object' && 'raw' in first) {
        return handleCall(null, first as TemplateStringsArray, argsList.slice(1));
      }
      const options = first as Record<string, unknown>;
      return (strings: TemplateStringsArray, ...values: unknown[]) => handleCall(options, strings, values);
    },
    set() {
      return true;
    },
    get(_target: unknown, prop: string | symbol) {
      if (prop === 'verbose') return false;
      return undefined;
    },
  });
  return { $ };
});

const { fetchPRReviewState, replyToReviewComment } = await import('./github.js');

beforeEach(() => resetMock());

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const CHANGES_REQUESTED_FIXTURE = {
  reviewDecision: 'CHANGES_REQUESTED',
  reviewThreads: [
    {
      id: 'PRRT_1',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            databaseId: 9001,
            author: { login: 'alice' },
            body: 'rename this',
            path: 'src/foo.ts',
            line: 12,
          },
        ],
      },
    },
    {
      id: 'PRRT_2',
      isResolved: true, // resolved → excluded
      isOutdated: false,
      comments: { nodes: [{ databaseId: 9002, author: { login: 'bob' }, body: 'old' }] },
    },
    {
      id: 'PRRT_3',
      isResolved: false,
      isOutdated: true, // outdated → excluded
      comments: { nodes: [{ databaseId: 9003, author: { login: 'carol' }, body: 'stale' }] },
    },
  ],
};

const APPROVED_NO_THREADS_FIXTURE = {
  reviewDecision: 'APPROVED',
  reviewThreads: [],
};

const NULL_DECISION_FIXTURE = {
  reviewDecision: null,
  reviewThreads: [],
};

const BOT_THREADS_FIXTURE = {
  reviewDecision: 'CHANGES_REQUESTED',
  reviewThreads: [
    {
      id: 'PRRT_BOT',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [{ databaseId: 1, author: { login: 'github-actions' }, body: 'auto', path: null, line: null }],
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('fetchPRReviewState', () => {
  it('returns CHANGES_REQUESTED decision and only unresolved non-outdated threads', async () => {
    setResponse('gh pr view', { stdout: JSON.stringify(CHANGES_REQUESTED_FIXTURE) });
    const state = await fetchPRReviewState('/repo', 42);

    expect(state.decision).toBe('CHANGES_REQUESTED');
    expect(state.blockingThreads).toHaveLength(1);
    expect(state.blockingThreads[0]).toEqual({
      threadId: 'PRRT_1',
      rootCommentId: 9001,
      path: 'src/foo.ts',
      line: 12,
      body: 'rename this',
      author: 'alice',
    });
  });

  it('returns APPROVED decision and empty blockingThreads when nothing pending', async () => {
    setResponse('gh pr view', { stdout: JSON.stringify(APPROVED_NO_THREADS_FIXTURE) });
    const state = await fetchPRReviewState('/repo', 42);

    expect(state.decision).toBe('APPROVED');
    expect(state.blockingThreads).toEqual([]);
  });

  it('returns undefined decision when reviewDecision is null', async () => {
    setResponse('gh pr view', { stdout: JSON.stringify(NULL_DECISION_FIXTURE) });
    const state = await fetchPRReviewState('/repo', 42);

    expect(state.decision).toBeUndefined();
    expect(state.blockingThreads).toEqual([]);
  });

  it('filters out bot-authored threads (github-actions, kova)', async () => {
    setResponse('gh pr view', { stdout: JSON.stringify(BOT_THREADS_FIXTURE) });
    const state = await fetchPRReviewState('/repo', 42);

    expect(state.blockingThreads).toEqual([]);
  });

  it('returns safe defaults on gh CLI error', async () => {
    setResponse('gh pr view', new Error('boom'));
    const state = await fetchPRReviewState('/repo', 9999);

    expect(state.decision).toBeUndefined();
    expect(state.blockingThreads).toEqual([]);
  });

  it('passes repo path as cwd and PR number to gh', async () => {
    setResponse('gh pr view', { stdout: JSON.stringify(APPROVED_NO_THREADS_FIXTURE) });
    await fetchPRReviewState('/some/repo', 4242);

    const ghCall = calls.find((c) => c.command.includes('gh pr view'));
    expect(ghCall?.cwd).toBe('/some/repo');
    expect(ghCall?.command).toContain('4242');
    expect(ghCall?.command).toContain('reviewDecision');
    expect(ghCall?.command).toContain('reviewThreads');
  });
});

describe('replyToReviewComment', () => {
  it('issues a gh api POST against the replies endpoint', async () => {
    setResponse('gh api', { stdout: '{}' });
    await replyToReviewComment('/repo', 'owner/repo', 7, 9001, 'Fixed.');

    const ghCall = calls.find((c) => c.command.includes('gh api'));
    expect(ghCall).toBeDefined();
    expect(ghCall?.command).toContain('owner/repo');
    expect(ghCall?.command).toContain('/pulls/7/comments/9001/replies');
    expect(ghCall?.command).toContain('Fixed.');
  });

  it('does not throw when gh api fails', async () => {
    setResponse('gh api', new Error('rate limited'));
    await expect(replyToReviewComment('/repo', 'owner/repo', 7, 9001, 'Fixed.')).resolves.toBeUndefined();
  });
});
