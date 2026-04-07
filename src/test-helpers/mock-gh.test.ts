import { describe, expect, it } from 'vitest';
import { GH_FIXTURES, GhMock } from './mock-gh.js';

describe('GhMock', () => {
  it('records calls with command and cwd', async () => {
    const gh = new GhMock();
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    // Tagged template call
    await ($`gh issue list --state open` as Promise<{ stdout: string }>);

    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.command).toBe('gh issue list --state open');
    expect(gh.calls[0]?.cwd).toBeUndefined();
  });

  it('supports $({cwd})`cmd` syntax', async () => {
    const gh = new GhMock();
    const { $ } = gh.zxModule() as {
      $: (opts: {
        cwd: string;
      }) => (strings: TemplateStringsArray, ...values: unknown[]) => Promise<{ stdout: string }>;
    };

    await $({ cwd: '/my/repo' })`gh pr list`;

    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.cwd).toBe('/my/repo');
  });

  it('returns canned response matching string pattern', async () => {
    const gh = new GhMock();
    gh.setResponse('gh issue list', { stdout: '["found"]' });
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    const result = await ($`gh issue list --state open` as Promise<{ stdout: string }>);

    expect(result.stdout).toBe('["found"]');
  });

  it('returns canned response matching regex pattern', async () => {
    const gh = new GhMock();
    gh.setResponse(/gh pr view \d+/, { stdout: '{"status":"ok"}' });
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    const result = await ($`gh pr view 42` as Promise<{ stdout: string }>);

    expect(result.stdout).toBe('{"status":"ok"}');
  });

  it('rejects with Error when response is Error', async () => {
    const gh = new GhMock();
    gh.setResponse('gh pr create', new Error('branch has no commits'));
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    await expect($`gh pr create --title test` as Promise<unknown>).rejects.toThrow('branch has no commits');
  });

  it('returns empty stdout for unmatched commands', async () => {
    const gh = new GhMock();
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    const result = await ($`gh unknown command` as Promise<{ stdout: string }>);

    expect(result.stdout).toBe('');
  });

  it('reset() clears calls and responses', async () => {
    const gh = new GhMock();
    gh.setResponse('gh issue', { stdout: 'data' });
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };
    await ($`gh issue list` as Promise<unknown>);

    gh.reset();

    expect(gh.calls).toHaveLength(0);
    const result = await ($`gh issue list` as Promise<{ stdout: string }>);
    expect(result.stdout).toBe(''); // response cleared
  });

  it('interpolates template values into command string', async () => {
    const gh = new GhMock();
    gh.setResponse('gh issue view', { stdout: '{}' });
    const { $ } = gh.zxModule() as { $: (...args: unknown[]) => unknown };

    const issueNum = 42;
    await ($`gh issue view ${issueNum} --json title` as Promise<unknown>);

    expect(gh.calls[0]?.command).toBe('gh issue view 42 --json title');
  });
});

describe('GH_FIXTURES', () => {
  it('ISSUE has standard fields', () => {
    expect(GH_FIXTURES.ISSUE.number).toBe(42);
    expect(GH_FIXTURES.ISSUE.title).toBe('Fix login bug');
    expect(GH_FIXTURES.ISSUE.labels).toBeInstanceOf(Array);
  });

  it('ISSUE_LIST has multiple issues', () => {
    expect(GH_FIXTURES.ISSUE_LIST).toHaveLength(2);
  });

  it('PR_LIST has kova/ branch names', () => {
    expect(GH_FIXTURES.PR_LIST[0]?.headRefName).toMatch(/^kova\//);
  });
});
