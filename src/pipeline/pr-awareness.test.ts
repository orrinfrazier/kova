import { describe, expect, it, vi } from 'vitest';
import { extractPRFromResult, formatPRContext, type OpenPR } from '../services/pr-context.js';
import type { Issue } from '../types/index.js';

// Test formatPRContext independently
describe('formatPRContext', () => {
  it('returns empty string when no PRs', () => {
    expect(formatPRContext([])).toBe('');
  });

  it('formats single PR with files', () => {
    const prs: OpenPR[] = [
      { number: 10, title: 'Fix auth bug', branch: 'kova/fix-10', files: ['src/auth.ts', 'src/middleware.ts'] },
    ];
    const result = formatPRContext(prs);
    expect(result).toContain('Pending PRs');
    expect(result).toContain('#10');
    expect(result).toContain('Fix auth bug');
    expect(result).toContain('kova/fix-10');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('src/middleware.ts');
  });

  it('formats multiple PRs', () => {
    const prs: OpenPR[] = [
      { number: 10, title: 'Fix auth', branch: 'kova/fix-10', files: ['src/auth.ts'] },
      { number: 11, title: 'Add logging', branch: 'kova/fix-11', files: ['src/logger.ts'] },
    ];
    const result = formatPRContext(prs);
    expect(result).toContain('#10');
    expect(result).toContain('#11');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('src/logger.ts');
  });

  it('shows unknown when PR has no files', () => {
    const prs: OpenPR[] = [{ number: 10, title: 'Fix something', branch: 'kova/fix-10', files: [] }];
    const result = formatPRContext(prs);
    expect(result).toContain('unknown');
  });

  it('includes conflict avoidance instruction', () => {
    const prs: OpenPR[] = [{ number: 10, title: 'Fix auth', branch: 'kova/fix-10', files: ['src/auth.ts'] }];
    const result = formatPRContext(prs);
    expect(result).toContain('avoid');
    expect(result).toContain('conflict');
  });
});

// Test extractPRFromResult
describe('extractPRFromResult', () => {
  function makeIssue(n: number): Issue {
    return { number: n, title: `Issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
  }

  it('extracts PR from successful fix result', () => {
    const result = {
      success: true,
      prUrl: 'https://github.com/test/repo/pull/42',
      state: {
        waveResults: {
          ship: {
            artifact: { filesStaged: ['src/a.ts', 'src/b.ts'], prUrl: 'url', commitMessage: 'msg' },
          },
        },
      },
    };
    const pr = extractPRFromResult(makeIssue(5), result);
    expect(pr).toBeDefined();
    expect(pr?.number).toBe(42);
    expect(pr?.title).toBe('Issue 5');
    expect(pr?.branch).toBe('kova/fix-5');
    expect(pr?.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns undefined for failed fix', () => {
    const result = {
      success: false,
      state: { waveResults: {} },
    };
    expect(extractPRFromResult(makeIssue(5), result)).toBeUndefined();
  });

  it('returns undefined when no prUrl', () => {
    const result = {
      success: true,
      state: { waveResults: {} },
    };
    expect(extractPRFromResult(makeIssue(5), result)).toBeUndefined();
  });

  it('falls back to issue number when PR URL cannot be parsed', () => {
    const result = {
      success: true,
      prUrl: 'some-invalid-url',
      state: {
        waveResults: {
          ship: { artifact: {} },
        },
      },
    };
    const pr = extractPRFromResult(makeIssue(7), result);
    expect(pr?.number).toBe(7);
  });
});

// Test that fix() passes PR context to spec and impl waves
describe('fix — PR context injection', () => {
  vi.mock('../ai/index.js', () => ({
    executeWaveWithRetry: vi.fn().mockResolvedValue({
      result: 'done',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'test-model',
      structuredOutput: {
        grade: 'A',
        surface_area: { files: [], estimated_lines: 10, modules_affected: [] },
        risk: 'low',
        reasoning: 'simple',
        should_proceed: true,
      },
    }),
  }));

  vi.mock('../services/github.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/github.js')>();
    return {
      ...original,
      listOpenPRs: vi.fn().mockResolvedValue([]),
      createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    };
  });

  vi.mock('../services/worktree.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/worktree.js')>();
    return {
      ...original,
      createWorktree: vi.fn().mockImplementation((_repoPath: string, issueNumber: number) => ({
        path: `/tmp/test-worktree-${issueNumber}`,
        branch: `kova/fix-${issueNumber}`,
      })),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      commitAndPush: vi.fn().mockResolvedValue({
        committed: true,
        filesStaged: ['src/fix.ts'],
        commitMessage: 'fix: Test issue (#42)',
      }),
    };
  });

  it('includes PR context in spec wave userMessage when pendingPRs provided', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-pr-'));

    try {
      const { fix } = await import('./fix.js');
      const { executeWaveWithRetry } = await import('../ai/index.js');
      const mockExecute = vi.mocked(executeWaveWithRetry);
      mockExecute.mockClear();

      const pendingPRs: OpenPR[] = [{ number: 10, title: 'Fix auth', branch: 'kova/fix-10', files: ['src/auth.ts'] }];

      await fix({
        issue: { number: 42, title: 'Test', body: 'body', labels: [], url: 'https://example.com/42' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
          model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
          isolation: 'none',
        },
        pendingPRs,
      });

      const specCall = mockExecute.mock.calls.find((c) => c[0].wave === 'spec');
      expect(specCall).toBeDefined();
      expect(specCall?.[0].userMessage).toContain('Pending PRs');
      expect(specCall?.[0].userMessage).toContain('#10');
      expect(specCall?.[0].userMessage).toContain('src/auth.ts');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('includes PR context in impl wave userMessage when pendingPRs provided', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-pr-'));

    try {
      const { fix } = await import('./fix.js');
      const { executeWaveWithRetry } = await import('../ai/index.js');
      const mockExecute = vi.mocked(executeWaveWithRetry);
      mockExecute.mockClear();

      const pendingPRs: OpenPR[] = [
        { number: 11, title: 'Add logger', branch: 'kova/fix-11', files: ['src/logger.ts'] },
      ];

      await fix({
        issue: { number: 43, title: 'Test', body: 'body', labels: [], url: 'https://example.com/43' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
          model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
          isolation: 'none',
        },
        pendingPRs,
      });

      const implCall = mockExecute.mock.calls.find((c) => c[0].wave === 'impl');
      expect(implCall).toBeDefined();
      expect(implCall?.[0].userMessage).toContain('Pending PRs');
      expect(implCall?.[0].userMessage).toContain('#11');
      expect(implCall?.[0].userMessage).toContain('src/logger.ts');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('does not include PR section when pendingPRs is empty', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-pr-'));

    try {
      const { fix } = await import('./fix.js');
      const { executeWaveWithRetry } = await import('../ai/index.js');
      const mockExecute = vi.mocked(executeWaveWithRetry);
      mockExecute.mockClear();

      await fix({
        issue: { number: 44, title: 'Test', body: 'body', labels: [], url: 'https://example.com/44' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
          model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
          isolation: 'none',
        },
        pendingPRs: [],
      });

      const specCall = mockExecute.mock.calls.find((c) => c[0].wave === 'spec');
      expect(specCall?.[0].userMessage).not.toContain('Pending PRs');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
