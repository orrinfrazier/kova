/**
 * Tests for pr-context.ts — PR fetching, formatting, and extraction.
 *
 * Uses the same mock $ pattern as github-gh.test.ts for fetchOpenPRsDetailed.
 * formatPRContext and extractPRFromResult are pure functions tested directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../types/index.js';

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

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const PR_LIST_FIXTURE = [
  {
    number: 10,
    title: 'fix: Login crash',
    headRefName: 'kova/fix-42',
    files: [{ path: 'src/auth/login.ts' }, { path: 'src/auth/login.test.ts' }],
  },
  {
    number: 11,
    title: 'feat: Dark mode',
    headRefName: 'kova/fix-99',
    files: [{ path: 'src/theme/dark.ts' }],
  },
];

const ISSUE_FIXTURE: Issue = {
  number: 42,
  title: 'Fix login bug',
  body: 'The login form crashes on empty input',
  labels: ['bug'],
  url: 'https://github.com/owner/repo/issues/42',
};

/* ------------------------------------------------------------------ */
/*  Import SUT after mock is installed                                 */
/* ------------------------------------------------------------------ */

const { fetchOpenPRsDetailed, formatPRContext, extractPRFromResult } = await import('./pr-context.js');

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('fetchOpenPRsDetailed', () => {
  beforeEach(() => resetMock());

  it('parses gh pr list JSON into OpenPR array', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify(PR_LIST_FIXTURE) });

    const result = await fetchOpenPRsDetailed('/tmp/repo');
    expect(result).toEqual([
      {
        number: 10,
        title: 'fix: Login crash',
        branch: 'kova/fix-42',
        files: ['src/auth/login.ts', 'src/auth/login.test.ts'],
      },
      {
        number: 11,
        title: 'feat: Dark mode',
        branch: 'kova/fix-99',
        files: ['src/theme/dark.ts'],
      },
    ]);
  });

  it('passes cwd to gh command', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify([]) });

    await fetchOpenPRsDetailed('/my/repo/path');
    expect(calls[0]?.cwd).toBe('/my/repo/path');
  });

  it('returns empty array when no PRs open', async () => {
    setResponse('gh pr list', { stdout: JSON.stringify([]) });

    const result = await fetchOpenPRsDetailed('/tmp/repo');
    expect(result).toEqual([]);
  });

  it('handles PRs with no files', async () => {
    setResponse('gh pr list', {
      stdout: JSON.stringify([{ number: 5, title: 'Empty PR', headRefName: 'kova/fix-5', files: [] }]),
    });

    const result = await fetchOpenPRsDetailed('/tmp/repo');
    expect(result).toEqual([{ number: 5, title: 'Empty PR', branch: 'kova/fix-5', files: [] }]);
  });
});

describe('formatPRContext', () => {
  it('returns empty string for empty PRs array', () => {
    expect(formatPRContext([])).toBe('');
  });

  it('formats single PR with files', () => {
    const result = formatPRContext([
      { number: 10, title: 'fix: Login crash', branch: 'kova/fix-42', files: ['src/login.ts'] },
    ]);

    expect(result).toContain('## Pending PRs (avoid conflicts)');
    expect(result).toContain('#10: fix: Login crash (branch: kova/fix-42, files: src/login.ts)');
  });

  it('formats multiple PRs', () => {
    const result = formatPRContext([
      { number: 10, title: 'fix: Login crash', branch: 'kova/fix-42', files: ['src/login.ts'] },
      { number: 11, title: 'feat: Dark mode', branch: 'kova/fix-99', files: ['src/theme.ts', 'src/dark.css'] },
    ]);

    expect(result).toContain('#10: fix: Login crash');
    expect(result).toContain('#11: feat: Dark mode');
    expect(result).toContain('files: src/theme.ts, src/dark.css');
  });

  it('shows "unknown" when PR has no files', () => {
    const result = formatPRContext([{ number: 5, title: 'Empty PR', branch: 'kova/fix-5', files: [] }]);

    expect(result).toContain('files: unknown');
  });
});

describe('extractPRFromResult', () => {
  it('extracts PR from successful result with PR URL', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: true,
      prUrl: 'https://github.com/owner/repo/pull/77',
      state: {
        waveResults: {
          ship: { artifact: { filesStaged: ['src/login.ts', 'src/login.test.ts'] } },
        },
      },
    });

    expect(result).toEqual({
      number: 77,
      title: 'Fix login bug',
      branch: 'kova/fix-42',
      files: ['src/login.ts', 'src/login.test.ts'],
    });
  });

  it('returns undefined for failed result', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: false,
      state: { waveResults: {} },
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when prUrl is missing', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: true,
      state: { waveResults: {} },
    });

    expect(result).toBeUndefined();
  });

  it('falls back to issue number when PR URL has no number', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: true,
      prUrl: 'https://github.com/owner/repo/pull/',
      state: { waveResults: {} },
    });

    expect(result).toEqual({
      number: 42,
      title: 'Fix login bug',
      branch: 'kova/fix-42',
      files: [],
    });
  });

  it('returns empty files when filesStaged is missing', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: true,
      prUrl: 'https://github.com/owner/repo/pull/77',
      state: { waveResults: { ship: { artifact: {} } } },
    });

    expect(result).toEqual({
      number: 77,
      title: 'Fix login bug',
      branch: 'kova/fix-42',
      files: [],
    });
  });

  it('returns empty files when ship wave result is missing', () => {
    const result = extractPRFromResult(ISSUE_FIXTURE, {
      success: true,
      prUrl: 'https://github.com/owner/repo/pull/77',
      state: { waveResults: {} },
    });

    expect(result).toEqual({
      number: 77,
      title: 'Fix login bug',
      branch: 'kova/fix-42',
      files: [],
    });
  });
});
