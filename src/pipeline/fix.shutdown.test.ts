import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

// Mock the AI layer — returns wave-appropriate structured output
function waveStructuredOutput(wave?: string): unknown {
  if (wave === 'review') {
    return { verdict: 'pass', findings: [], summary: 'all good' };
  }
  return {
    grade: 'A',
    surface_area: { files: [], estimated_lines: 10, modules_affected: [] },
    risk: 'low',
    reasoning: 'simple',
    should_proceed: true,
  };
}

vi.mock('../ai/index.js', () => ({
  executeWaveWithRetry: vi.fn().mockImplementation((opts: { wave?: string }) => ({
    result: 'done',
    success: true,
    duration: 100,
    turns: 1,
    cost: 0.01,
    model: 'test-model',
    structuredOutput: waveStructuredOutput(opts.wave),
  })),
}));

// Mock github
vi.mock('../services/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  hasExistingWork: vi.fn().mockResolvedValue(false),
}));

// Mock pr-context
vi.mock('../services/pr-context.js', () => ({
  formatPRContext: vi.fn().mockReturnValue(''),
}));

// Mock language detection (needed by review loop's resolveTestCommand)
vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest' }),
}));

// Mock prompt loading
vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock system prompt'),
}));

// Mock worktree
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
const { loadCheckpoint } = await import('../services/checkpoint.js');
const { executeWaveWithRetry } = await import('../ai/index.js');
const { installSignalHandlers, removeSignalHandlers, resetShutdown } = await import('../services/shutdown.js');
const mockExecute = vi.mocked(executeWaveWithRetry);

function makeIssue(n: number): Issue {
  return { number: n, title: `Test issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
}

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
    model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
    isolation: 'none',
  };
}

describe('fix — graceful shutdown', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-shutdown-'));
    resetShutdown();
    // Reset mock to default wave-appropriate implementation (prevents test leakage)
    mockExecute.mockReset();
    mockExecute.mockImplementation(async (opts: { wave?: string }) => ({
      result: 'done',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'test-model',
      structuredOutput: waveStructuredOutput(opts.wave),
    }));
  });

  afterEach(async () => {
    resetShutdown();
    removeSignalHandlers();
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns interrupted result when shutdown requested between waves', async () => {
    // Trigger shutdown after the first wave (assess) completes
    let callCount = 0;
    mockExecute.mockImplementation(async (opts: { wave?: string }) => {
      callCount++;
      if (callCount === 1) {
        // After assess completes, request shutdown
        installSignalHandlers();
        process.emit('SIGINT', 'SIGINT');
      }
      return {
        result: 'done',
        success: true,
        duration: 100,
        turns: 1,
        cost: 0.01,
        model: 'test-model',
        structuredOutput: waveStructuredOutput(opts.wave),
      };
    });

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Interrupted by signal');
    expect(result.state.status).toBe('interrupted');
    // Should have only run assess (1 wave) before stopping
    expect(callCount).toBe(1);
  });

  it('saves checkpoint with interrupted status', async () => {
    let callCount = 0;
    mockExecute.mockImplementation(async (opts: { wave?: string }) => {
      callCount++;
      if (callCount === 2) {
        // After spec wave, trigger shutdown
        installSignalHandlers();
        process.emit('SIGINT', 'SIGINT');
      }
      return {
        result: 'done',
        success: true,
        duration: 100,
        turns: 1,
        cost: 0.01,
        model: 'test-model',
        structuredOutput: waveStructuredOutput(opts.wave),
      };
    });

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    // Verify checkpoint was saved with interrupted status
    const checkpoint = await loadCheckpoint(workDir);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.status).toBe('interrupted');
    expect(checkpoint?.completedWaves).toContain('assess');
    expect(checkpoint?.completedWaves).toContain('spec');
    expect(checkpoint?.completedWaves).not.toContain('test');
  });

  it('completes all waves when no shutdown requested', async () => {
    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.success).toBe(true);
    expect(result.state.status).toBe('completed');
  });
});
