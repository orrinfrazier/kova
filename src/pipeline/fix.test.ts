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
    isolation: 'none', // Use 'none' so we control workDir via repoPath
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
    // Pre-save a checkpoint with assess + spec completed
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

    // Should NOT have called assess or spec waves (they were checkpointed)
    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).not.toContain('assess');
    expect(waveCalls).not.toContain('spec');
    // Should have called the remaining waves
    expect(waveCalls).toContain('test');
    expect(waveCalls).toContain('impl');
  });

  it('starts fresh when fresh option is true', async () => {
    // Pre-save a checkpoint
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

    // Checkpoint should have been cleared — all waves should run
    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toContain('assess');
    expect(waveCalls).toContain('spec');
    expect(waveCalls).toContain('test');

    // Verify checkpoint was cleared before run
    // (the new state should have all waves, not just the pre-existing ones)
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

    // Should print resume message mentioning completed waves
    const logMessages = consoleSpy.mock.calls.map((c) => c[0] as string);
    const resumeMsg = logMessages.find((m) => m.includes('Resuming'));
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg).toContain('assess');
    expect(resumeMsg).toContain('spec');

    consoleSpy.mockRestore();
  });
});
