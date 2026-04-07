import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, Issue, RepoConfig } from '../types/index.js';

// Mock the AI layer — we can't make real Agent SDK calls in tests
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

// Mock github service — no real API calls in tests
vi.mock('../services/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
}));

// Mock worktree — tests don't have real git repos
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

const { fix } = await import('./fix.js');
const { saveCheckpoint } = await import('../services/checkpoint.js');

function makeIssue(n: number): Issue {
  return { number: n, title: `Test issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
}

function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
    model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
    isolation: 'none',
    ...overrides,
  };
}

describe('fix — resume from checkpoint', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('skips completed waves when checkpoint exists', async () => {
    const existingState: FixState = {
      issue: makeIssue(42),
      repo: 'test-repo',
      repoPath: workDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWaves: ['assess', 'spec'],
      waveResults: {
        assess: {
          wave: 'assess',
          success: true,
          artifact: { grade: 'A', should_proceed: true },
          duration: 100,
          cost: 0.01,
        },
        spec: {
          wave: 'spec',
          success: true,
          artifact: { summary: 'test', pieces: [], dependency_order: [], constraints: [] },
          duration: 100,
          cost: 0.01,
        },
      },
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);

    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).not.toContain('assess');
    expect(waveCalls).not.toContain('spec');
    expect(waveCalls).toContain('test');
    expect(waveCalls).toContain('impl');
  });

  it('starts fresh when fresh option is true', async () => {
    const existingState: FixState = {
      issue: makeIssue(42),
      repo: 'test-repo',
      repoPath: workDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWaves: ['assess', 'spec', 'test'],
      waveResults: {},
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);

    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
      fresh: true,
    });

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toContain('assess');
    expect(waveCalls).toContain('spec');
    expect(waveCalls).toContain('test');
  });

  it('prints resume message when loading checkpoint', async () => {
    const existingState: FixState = {
      issue: makeIssue(42),
      repo: 'test-repo',
      repoPath: workDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWaves: ['assess', 'spec'],
      waveResults: {
        assess: {
          wave: 'assess',
          success: true,
          artifact: { grade: 'A', should_proceed: true },
          duration: 100,
          cost: 0.01,
        },
        spec: { wave: 'spec', success: true, artifact: {}, duration: 100, cost: 0.01 },
      },
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);

    const consoleSpy = vi.spyOn(console, 'log');

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    const logMessages = consoleSpy.mock.calls.map((c) => c[0] as string);
    const resumeMsg = logMessages.find((m) => m.includes('Resuming'));
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg).toContain('assess');
    expect(resumeMsg).toContain('spec');

    consoleSpy.mockRestore();
  });
});

describe('fix — grade D/F issue comment', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('posts GitHub comment when assess returns grade D', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();
    mockExecute.mockResolvedValueOnce({
      result: 'done',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'test-model',
      structuredOutput: {
        grade: 'D',
        surface_area: { files: ['src/a.ts', 'src/b.ts'], estimated_lines: 500, modules_affected: ['core', 'api'] },
        risk: 'high',
        reasoning: 'Too many interconnected changes required',
        should_proceed: false,
      },
    });

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.success).toBe(false);
    expect(mockComment).toHaveBeenCalledOnce();

    const commentBody = mockComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('D');
    expect(commentBody).toContain('high');
    expect(commentBody).toContain('src/a.ts');
    expect(commentBody).toContain('Too many interconnected changes');
  });

  it('posts GitHub comment when assess returns grade F', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();
    mockExecute.mockResolvedValueOnce({
      result: 'done',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'test-model',
      structuredOutput: {
        grade: 'F',
        surface_area: { files: [], estimated_lines: 2000, modules_affected: ['everything'] },
        risk: 'critical',
        reasoning: 'Complete rewrite needed',
        should_proceed: false,
      },
    });

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    const result = await fix({
      issue: makeIssue(99),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.success).toBe(false);
    expect(mockComment).toHaveBeenCalledOnce();
    const commentBody = mockComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('F');
    expect(commentBody).toContain('critical');
  });

  it('does NOT post comment when noComment option is true', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();
    mockExecute.mockResolvedValueOnce({
      result: 'done',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'test-model',
      structuredOutput: {
        grade: 'D',
        surface_area: { files: [], estimated_lines: 500, modules_affected: [] },
        risk: 'high',
        reasoning: 'Too complex',
        should_proceed: false,
      },
    });

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
      noComment: true,
    });

    expect(mockComment).not.toHaveBeenCalled();
  });

  it('does NOT post comment when assess grade allows proceeding', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(mockComment).not.toHaveBeenCalled();
  });
});
