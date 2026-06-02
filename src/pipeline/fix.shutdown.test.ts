import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

// --- Default artifacts ---

const DEFAULT_ASSESS = {
  grade: 'A',
  surface_area: { files: [], estimated_lines: 10, modules_affected: [] },
  risk: 'low',
  reasoning: 'simple',
  should_proceed: true,
};

const DEFAULT_SPEC = { summary: 'test spec', pieces: [], dependency_order: [], constraints: [] };
const DEFAULT_QUALITY = {
  lint: 'pass',
  typecheck: 'pass',
  tests: 'pass',
  coverage: 90,
  audit: 'pass',
  all_passing: true,
};
const DEFAULT_REVIEW = { verdict: 'pass', findings: [], summary: 'all good' };

function makeHandoff(wave: WaveName, artifact: unknown): WaveHandoff {
  return {
    wave,
    timestamp: new Date().toISOString(),
    model: 'test-model',
    cost: 0.01,
    turns: 1,
    confidence: 'high',
    artifact,
    approach_notes: '',
  };
}

function makeWaveResult(wave: WaveName, artifact: unknown): WaveResult {
  return { wave, success: true, artifact, duration: 100, cost: 0.01, turns: 1, model: 'test-model' };
}

// --- Mocks ---

const mockSpawnWaveAgent = vi.fn();
vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    resolveWaveModel: vi.fn().mockReturnValue({ id: 'test-model', provider: 'anthropic' }),
    isConsensusPool: actual.isConsensusPool,
    isLocalProvider: actual.isLocalProvider,
    spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
    spawnWaveAgentWithFallback: (...args: unknown[]) => mockSpawnWaveAgent(...args),
    isLocalModel: vi.fn().mockReturnValue(false),
    getApiFallbackModelString: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    getModelString: actual.getModelString,
    getWaveTools: vi.fn().mockReturnValue([]),
    resolveThinkingLevel: actual.resolveThinkingLevel,
  };
});

const mockRunParallelPieceTILoop = vi.fn();
const mockRunReviewLoop = vi.fn();
vi.mock('./loops.js', () => ({
  runParallelPieceTILoop: (...args: unknown[]) => mockRunParallelPieceTILoop(...args),
  runReviewLoop: (...args: unknown[]) => mockRunReviewLoop(...args),
}));

vi.mock('../services/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  hasExistingWork: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/pr-context.js', () => ({
  formatPRContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest' }),
}));

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock system prompt'),
  resolvePromptsDir: vi.fn().mockReturnValue(undefined),
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
    rebaseOnDefault: vi.fn().mockResolvedValue({ success: true, conflicted: false }),
  };
});

vi.mock('../services/conflict-check.js', () => ({
  checkForConflicts: vi.fn().mockResolvedValue({
    hasConflicts: false,
    conflictingFiles: [],
    overlapping: [],
    nonOverlapping: [],
  }),
}));

vi.mock('../services/conflict-resolver.js', () => ({
  resolveConflicts: vi.fn().mockResolvedValue({ resolved: true, filesResolved: [] }),
}));

const { fix } = await import('./fix.js');
const { loadCheckpoint } = await import('../services/checkpoint.js');
const { installSignalHandlers, removeSignalHandlers, resetShutdown } = await import('../services/shutdown.js');

function makeIssue(n: number): Issue {
  return { number: n, title: `Test issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
}

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const, concurrency: 1 },
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
  };
}

function setupDefaultMocks(): void {
  const artifacts: Record<string, unknown> = {
    assess: DEFAULT_ASSESS,
    spec: DEFAULT_SPEC,
    quality: DEFAULT_QUALITY,
  };
  mockSpawnWaveAgent.mockImplementation(async (config: { wave: WaveName }) => {
    return makeHandoff(config.wave, artifacts[config.wave] ?? 'done');
  });

  mockRunParallelPieceTILoop.mockResolvedValue({
    testWaveResult: makeWaveResult('test', 'tests written'),
    implWaveResult: makeWaveResult('impl', { tests_passing: true }),
    testsPassing: true,
    totalCost: 0.02,
    attempts: 1,
    pieceResults: [],
    modifiedFilesPerAttempt: [],
  });

  mockRunReviewLoop.mockResolvedValue({
    reviewWaveResult: makeWaveResult('review', DEFAULT_REVIEW),
    totalCost: 0.01,
    iterations: 1,
    knownIssues: [],
  });
}

describe('fix — graceful shutdown', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-shutdown-'));
    resetShutdown();
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    resetShutdown();
    removeSignalHandlers();
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns interrupted result when shutdown requested between waves', async () => {
    // Trigger shutdown after the first wave (assess) completes
    let spawnCallCount = 0;
    mockSpawnWaveAgent.mockImplementation(async (config: { wave: WaveName }) => {
      spawnCallCount++;
      if (spawnCallCount === 1) {
        // After assess completes, request shutdown
        installSignalHandlers();
        process.emit('SIGINT', 'SIGINT');
      }
      const artifacts: Record<string, unknown> = {
        assess: DEFAULT_ASSESS,
        spec: DEFAULT_SPEC,
        quality: DEFAULT_QUALITY,
      };
      return makeHandoff(config.wave, artifacts[config.wave] ?? 'done');
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
    // Should have only run assess (1 spawnWaveAgent call) before stopping
    expect(spawnCallCount).toBe(1);
  });

  it('saves checkpoint with interrupted status', async () => {
    let spawnCallCount = 0;
    mockSpawnWaveAgent.mockImplementation(async (config: { wave: WaveName }) => {
      spawnCallCount++;
      if (spawnCallCount === 2) {
        // After spec wave, trigger shutdown
        installSignalHandlers();
        process.emit('SIGINT', 'SIGINT');
      }
      const artifacts: Record<string, unknown> = {
        assess: DEFAULT_ASSESS,
        spec: DEFAULT_SPEC,
        quality: DEFAULT_QUALITY,
      };
      return makeHandoff(config.wave, artifacts[config.wave] ?? 'done');
    });

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

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
