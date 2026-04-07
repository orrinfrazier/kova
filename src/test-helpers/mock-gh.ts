/**
 * Reusable mock for `gh` CLI via zx — records calls and returns fixture data.
 *
 * This module provides the plumbing for vi.mock('zx'). Because vi.mock is
 * hoisted, the actual mock installation must happen in the test file, but the
 * recording logic and helpers live here for reuse.
 *
 * Usage:
 *   import { GhMock } from '../test-helpers/mock-gh.js';
 *   const gh = new GhMock();
 *   vi.mock('zx', () => gh.zxModule());
 *
 *   // In tests:
 *   gh.setResponse('gh issue list', { stdout: JSON.stringify([...]) });
 *   gh.reset();
 *   gh.calls // recorded calls
 */

export interface RecordedCall {
  command: string;
  cwd: string | undefined;
}

interface ResponseEntry {
  pattern: string | RegExp;
  value: { stdout: string } | Error;
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

export class GhMock {
  calls: RecordedCall[] = [];
  private responses: ResponseEntry[] = [];

  /** Register a canned response for commands matching the pattern. */
  setResponse(pattern: string | RegExp, value: { stdout: string } | Error): void {
    this.responses.push({ pattern, value });
  }

  /** Clear all recorded calls and registered responses. */
  reset(): void {
    this.calls.length = 0;
    this.responses = [];
  }

  private findResponse(command: string): { stdout: string } | Error {
    for (const { pattern, value } of this.responses) {
      if (typeof pattern === 'string' ? command.includes(pattern) : pattern.test(command)) {
        return value;
      }
    }
    return { stdout: '' };
  }

  private handleCall(
    options: Record<string, unknown> | null,
    strings: TemplateStringsArray,
    values: unknown[],
  ): Promise<{ stdout: string }> {
    const command = buildCommand(strings, values);
    this.calls.push({ command, cwd: (options?.cwd as string) ?? undefined });
    const response = this.findResponse(command);
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  }

  /**
   * Returns the module shape expected by `vi.mock('zx', () => gh.zxModule())`.
   * The `$` works as both tagged-template `$\`cmd\`` and options call `$({cwd})\`cmd\``.
   */
  zxModule(): { $: unknown } {
    const self = this;
    const $ = new Proxy(() => {}, {
      apply(
        _target: unknown,
        _thisArg: unknown,
        argsList: [TemplateStringsArray | Record<string, unknown>, ...unknown[]],
      ) {
        const first = argsList[0];
        if (first != null && typeof first === 'object' && 'raw' in first) {
          return self.handleCall(null, first as TemplateStringsArray, argsList.slice(1));
        }
        const options = first as Record<string, unknown>;
        return (strings: TemplateStringsArray, ...values: unknown[]) => self.handleCall(options, strings, values);
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
  }
}

// ---------------------------------------------------------------------------
// Common GitHub fixtures — reusable across test files
// ---------------------------------------------------------------------------

export const GH_FIXTURES = {
  ISSUE: {
    number: 42,
    title: 'Fix login bug',
    body: 'The login form crashes on empty input',
    labels: [{ name: 'bug' }, { name: 'urgent' }],
    url: 'https://github.com/owner/repo/issues/42',
  },

  ISSUE_LIST: [
    {
      number: 42,
      title: 'Fix login bug',
      body: 'The login form crashes on empty input',
      labels: [{ name: 'bug' }, { name: 'urgent' }],
      url: 'https://github.com/owner/repo/issues/42',
    },
    {
      number: 99,
      title: 'Add dark mode',
      body: 'Support dark mode theme',
      labels: [{ name: 'feature' }],
      url: 'https://github.com/owner/repo/issues/99',
    },
  ],

  PR_LIST: [
    { number: 10, title: 'fix: Login crash', headRefName: 'kova/fix-42' },
    { number: 11, title: 'feat: Dark mode', headRefName: 'kova/fix-99' },
  ],

  PR_URL: 'https://github.com/owner/repo/pull/10',
} as const;
