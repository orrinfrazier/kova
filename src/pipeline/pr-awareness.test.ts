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

// --- Module-level mocks for fix() pipeline tests ---

const mockSpawnWaveAgent = vi.fn();
const mockRunParallelPieceTILoop = vi.fn();

vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    resolveWaveModel: vi.fn().mockReturnValue({ id: 'test-model', provider: 'anthropic' }),
    isLocalProvider: actual.isLocalProvider,
    spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
    spawnWaveAgentWithFallback: (...args: unknown[]) => mockSpawnWaveAgent(...args),
    isLocalModel: vi.fn().mockReturnValue(false),
    getApiFallbackModelString: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    getWaveTools: vi.fn().mockReturnValue([]),
    resolveThinkingLevel: actual.resolveThinkingLevel,
  };
});

vi.mock('./loops.js', () => ({
  runParallelPieceTILoop: (...args: unknown[]) => mockRunParallelPieceTILoop(...args),
  runReviewLoop: vi.fn().mockResolvedValue({
    reviewWaveResult: {
      wave: 'review',
      success: true,
      artifact: { verdict: 'pass', findings: [], summary: 'ok' },
      duration: 100,
      cost: 0.01,
      turns: 1,
      model: 'test-model',
    },
    totalCost: 0.01,
    iterations: 1,
    knownIssues: [],
  }),
}));

// Test that fix() passes PR context to spec and impl waves
describe('fix — PR context injection', () => {
  vi.mock('../services/github.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/github.js')>();
    return {
      ...original,
      listOpenPRs: vi.fn().mockResolvedValue([]),
      createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    };
  });

  vi.mock('../services/language-detect.js', () => ({
    detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest' }),
    formatToolingContext: vi.fn().mockReturnValue('Language: typescript'),
  }));

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

  function setupMocks(): void {
    mockSpawnWaveAgent.mockImplementation(async (config: { wave: string }) => ({
      wave: config.wave,
      timestamp: new Date().toISOString(),
      model: 'test-model',
      cost: 0.01,
      turns: 1,
      confidence: 'high',
      artifact:
        config.wave === 'assess'
          ? {
              grade: 'A',
              surface_area: { files: [], estimated_lines: 10, modules_affected: [] },
              risk: 'low',
              reasoning: 'simple',
              should_proceed: true,
            }
          : config.wave === 'spec'
            ? { summary: 'spec', pieces: [], dependency_order: [], constraints: [] }
            : { lint: 'pass', typecheck: 'pass', tests: 'pass', coverage: 90, audit: 'pass', all_passing: true },
      approach_notes: '',
    }));
    mockRunParallelPieceTILoop.mockResolvedValue({
      testWaveResult: {
        wave: 'test',
        success: true,
        artifact: 'tests written',
        duration: 100,
        cost: 0.01,
        turns: 1,
        model: 'test-model',
      },
      implWaveResult: {
        wave: 'impl',
        success: true,
        artifact: { tests_passing: true },
        duration: 100,
        cost: 0.01,
        turns: 1,
        model: 'test-model',
      },
      testsPassing: true,
      totalCost: 0.02,
      attempts: 1,
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    });
  }

  it('includes PR context in spec wave userMessage when pendingPRs provided', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-pr-'));

    try {
      const { fix } = await import('./fix.js');
      setupMocks();
      mockSpawnWaveAgent.mockClear();

      const pendingPRs: OpenPR[] = [{ number: 10, title: 'Fix auth', branch: 'kova/fix-10', files: ['src/auth.ts'] }];

      await fix({
        issue: { number: 42, title: 'Test', body: 'body', labels: [], url: 'https://example.com/42' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const },
          model: {
            assess: 'large',
            spec: 'large',
            test: 'medium',
            impl: 'medium',
            quality: 'small',
            review: 'large',
            brainstorm: 'large',
          },
          isolation: 'none',
        },
        pendingPRs,
      });

      // spec is called via spawnWaveAgent — check userMessage contains PR context
      const specCall = mockSpawnWaveAgent.mock.calls.find((c: unknown[]) => (c[0] as { wave: string }).wave === 'spec');
      expect(specCall).toBeDefined();
      expect((specCall?.[0] as { userMessage: string }).userMessage).toContain('Pending PRs');
      expect((specCall?.[0] as { userMessage: string }).userMessage).toContain('#10');
      expect((specCall?.[0] as { userMessage: string }).userMessage).toContain('src/auth.ts');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('includes PR context in TI loop config when pendingPRs provided', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-pr-'));

    try {
      const { fix } = await import('./fix.js');
      setupMocks();
      mockRunParallelPieceTILoop.mockClear();

      const pendingPRs: OpenPR[] = [
        { number: 11, title: 'Add logger', branch: 'kova/fix-11', files: ['src/logger.ts'] },
      ];

      await fix({
        issue: { number: 43, title: 'Test', body: 'body', labels: [], url: 'https://example.com/43' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const },
          model: {
            assess: 'large',
            spec: 'large',
            test: 'medium',
            impl: 'medium',
            quality: 'small',
            review: 'large',
            brainstorm: 'large',
          },
          isolation: 'none',
        },
        pendingPRs,
      });

      // impl runs via runTILoop — check prContext is passed in config
      expect(mockRunParallelPieceTILoop).toHaveBeenCalled();
      const tiConfig = mockRunParallelPieceTILoop.mock.calls[0]?.[0] as { prContext?: string };
      expect(tiConfig.prContext).toBeDefined();
      expect(tiConfig.prContext).toContain('Pending PRs');
      expect(tiConfig.prContext).toContain('#11');
      expect(tiConfig.prContext).toContain('src/logger.ts');
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
      setupMocks();
      mockSpawnWaveAgent.mockClear();

      await fix({
        issue: { number: 44, title: 'Test', body: 'body', labels: [], url: 'https://example.com/44' },
        repoPath: workDir,
        repoName: 'test-repo',
        config: {
          path: workDir,
          rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const },
          model: {
            assess: 'large',
            spec: 'large',
            test: 'medium',
            impl: 'medium',
            quality: 'small',
            review: 'large',
            brainstorm: 'large',
          },
          isolation: 'none',
        },
        pendingPRs: [],
      });

      const specCall = mockSpawnWaveAgent.mock.calls.find((c: unknown[]) => (c[0] as { wave: string }).wave === 'spec');
      expect(specCall).toBeDefined();
      expect((specCall?.[0] as { userMessage: string }).userMessage).not.toContain('Pending PRs');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
