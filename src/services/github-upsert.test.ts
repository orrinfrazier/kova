/**
 * Tests for upsertTrackingComment — finds-or-creates a comment by author + HTML
 * marker so a fresh checkout (no stored commentId) can still update an existing
 * tracking comment.
 *
 * Borrowed from claude-code-action's `use_sticky_comment` pattern:
 * `oss/claude-code-action/action.yml:112-115`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  gh CLI mock helper (same shape as github-gh.test.ts)               */
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

const { upsertTrackingComment, DEFAULT_TRACKING_MARKER } = await import('./github.js');

beforeEach(() => resetMock());

describe('upsertTrackingComment', () => {
  it('exports DEFAULT_TRACKING_MARKER as a hidden HTML marker', () => {
    expect(DEFAULT_TRACKING_MARKER).toBe('<!-- kova-tracking -->');
  });

  it('creates a new comment when no existing comment carries the marker', async () => {
    // Authenticated user
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    // POST response (create) — pattern must match before the broader list pattern
    setResponse(/-f body=/, { stdout: JSON.stringify({ id: 12345 }) });
    // No existing comments (list call)
    setResponse('gh api repos/owner/repo/issues/42/comments', { stdout: JSON.stringify([]) });

    const id = await upsertTrackingComment('owner/repo', 42, 'Body line A');
    expect(id).toBe(12345);

    // The created body should include the marker.
    const createCall = calls.find((c) => c.command.includes('POST') || c.command.includes('-f body='));
    expect(createCall?.command).toContain(DEFAULT_TRACKING_MARKER);
    expect(createCall?.command).toContain('Body line A');
  });

  it('updates the existing tracking comment when a marker-tagged comment exists by the bot', async () => {
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    setResponse('gh api repos/owner/repo/issues/42/comments', {
      stdout: JSON.stringify([
        { id: 11, body: 'unrelated comment by someone else', user: { login: 'alice' } },
        {
          id: 22,
          body: `Body line A\n\n${DEFAULT_TRACKING_MARKER}`,
          user: { login: 'kova-bot' },
        },
        { id: 33, body: 'a later unrelated comment', user: { login: 'bob' } },
      ]),
    });
    // PATCH response
    setResponse('issues/comments/22', { stdout: JSON.stringify({ id: 22 }) });

    const id = await upsertTrackingComment('owner/repo', 42, 'updated body');
    expect(id).toBe(22);

    const editCall = calls.find((c) => c.command.includes('issues/comments/22'));
    expect(editCall).toBeDefined();
    expect(editCall?.command).toContain('PATCH');
    expect(editCall?.command).toContain(DEFAULT_TRACKING_MARKER);
    expect(editCall?.command).toContain('updated body');
  });

  it('ignores marker-tagged comments authored by other users', async () => {
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    // POST response (must create, not update) — must take precedence over list-call pattern
    setResponse(/-f body=/, { stdout: JSON.stringify({ id: 555 }) });
    setResponse('gh api repos/owner/repo/issues/42/comments', {
      stdout: JSON.stringify([
        {
          id: 99,
          body: `someone else's body\n${DEFAULT_TRACKING_MARKER}`,
          user: { login: 'mallory' },
        },
      ]),
    });

    const id = await upsertTrackingComment('owner/repo', 42, 'fresh body');
    expect(id).toBe(555);
    expect(calls.find((c) => c.command.includes('issues/comments/99'))).toBeUndefined();
  });

  it('honors a custom marker', async () => {
    const customMarker = '<!-- kova-status -->';
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    setResponse('gh api repos/owner/repo/issues/42/comments', {
      stdout: JSON.stringify([
        {
          id: 77,
          body: `prev\n${customMarker}`,
          user: { login: 'kova-bot' },
        },
      ]),
    });
    setResponse('issues/comments/77', { stdout: JSON.stringify({ id: 77 }) });

    const id = await upsertTrackingComment('owner/repo', 42, 'new', customMarker);
    expect(id).toBe(77);
    const editCall = calls.find((c) => c.command.includes('issues/comments/77'));
    expect(editCall?.command).toContain(customMarker);
    expect(editCall?.command).not.toContain(DEFAULT_TRACKING_MARKER);
  });

  it('does not double-append marker when body already contains it', async () => {
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    setResponse(/-f body=/, { stdout: JSON.stringify({ id: 1 }) });
    setResponse('gh api repos/owner/repo/issues/42/comments', { stdout: JSON.stringify([]) });

    const bodyWithMarker = `Status\n${DEFAULT_TRACKING_MARKER}`;
    await upsertTrackingComment('owner/repo', 42, bodyWithMarker);
    const createCall = calls.find((c) => c.command.includes('-f body='));
    expect(createCall).toBeDefined();
    // The marker must appear exactly once.
    const cmd = createCall?.command ?? '';
    const occurrences = cmd.split(DEFAULT_TRACKING_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('falls back to creating a new comment when the list call fails', async () => {
    setResponse('gh api user', { stdout: JSON.stringify({ login: 'kova-bot' }) });
    // POST pattern must come first — first-match-wins in the mock, and the CREATE
    // command also contains the list-call substring.
    setResponse(/-f body=/, { stdout: JSON.stringify({ id: 999 }) });
    // List call (no -f body=) → fails with the error below
    setResponse(/gh api repos\/owner\/repo\/issues\/42\/comments$/, new Error('rate limit'));

    const id = await upsertTrackingComment('owner/repo', 42, 'body');
    expect(id).toBe(999);
  });
});
