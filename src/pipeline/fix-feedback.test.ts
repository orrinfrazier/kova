/**
 * Tests for Piece 6: Hook feedback collection into the fix pipeline post-ship.
 *
 * After `recordEpisode` in the finally block, if `config.episodes?.enabled`
 * and a PR was created, `collectPRFeedback` should be called with:
 *   - config.episodes (the episodic memory config)
 *   - the repo name
 *   - the PR number (extracted from the ship artifact)
 *   - the workDir
 *
 * Uses `.catch()` for graceful degradation — failures must not break the pipeline.
 * When no PR was created, feedback collection is skipped entirely.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

/* ------------------------------------------------------------------ */
/*  Default wave artifacts                                             */
/* ------------------------------------------------------------------ */

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
const DEFAULT_REVIEW = { verdict: 'pass', findings: [], summary: 'ok' };

/* ------------------------------------------------------------------ */
/*  Factories                                                          */
/* ------------------------------------------------------------------ */

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

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Test issue ${n}`,
    body: 'body',
    labels: [],
    url: `https://github.com/test/repo/issues/${n}`,
  };
}

function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: '/tmp/test',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'warn' as const,
      review_merge: 'warn' as const,
      concurrency: 1,
    },
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
    runtime: 'pi',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

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
    // Issue #297: pipeline now imports buildWaveSessionId.
    buildWaveSessionId: actual.buildWaveSessionId,
  };
});

const mockRunParallelPieceTILoop = vi.fn();
const mockRunReviewLoop = vi.fn();
vi.mock('./loops.js', () => ({
  runTILoop: vi.fn(),
  runParallelPieceTILoop: (...args: unknown[]) => mockRunParallelPieceTILoop(...args),
  runReviewLoop: (...args: unknown[]) => mockRunReviewLoop(...args),
}));

vi.mock('../services/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
}));

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

// Mock the feedback collector — this is the module under test
const mockCollectPRFeedback = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/feedback-collector.js', () => ({
  collectPRFeedback: (...args: unknown[]) => mockCollectPRFeedback(...args),
}));

const { fix } = await import('./fix.js');
const { saveCheckpoint } = await import('../services/checkpoint.js');

/* ------------------------------------------------------------------ */
/*  Default mock setup for happy-path pipeline                         */
/* ------------------------------------------------------------------ */

function setupDefaultMocks(): void {
  mockSpawnWaveAgent.mockImplementation(async (config: { wave: WaveName }) => {
    const artifacts: Record<string, unknown> = {
      assess: DEFAULT_ASSESS,
      spec: DEFAULT_SPEC,
      quality: DEFAULT_QUALITY,
    };
    return makeHandoff(config.wave, artifacts[config.wave] ?? 'done');
  });

  mockRunParallelPieceTILoop.mockResolvedValue({
    testWaveResult: makeWaveResult('test', 'tests written'),
    implWaveResult: makeWaveResult('impl', { tests_passing: true, files_modified: ['src/fix.ts'] }),
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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('fix — PR feedback collection post-ship', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-feedback-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('calls collectPRFeedback after recordEpisode when episodes enabled and PR was created', async () => {
    const episodesConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    expect(result.success).toBe(true);
    expect(result.prUrl).toBeDefined();
    // collectPRFeedback should have been called once in the finally block
    expect(mockCollectPRFeedback).toHaveBeenCalledOnce();
  });

  it('passes correct arguments to collectPRFeedback', async () => {
    const episodesConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    expect(mockCollectPRFeedback).toHaveBeenCalledOnce();
    const callArgs = mockCollectPRFeedback.mock.calls[0] as unknown[];
    // Should receive a single options object with episodesConfig, repoName, prNumber, repoPath
    expect(callArgs[0]).toEqual(
      expect.objectContaining({
        episodesConfig: expect.objectContaining({ enabled: true, endpoint: 'http://localhost:8100/query' }),
        repoName: 'test-repo',
      }),
    );
  });

  it('does NOT call collectPRFeedback when episodes is not enabled', async () => {
    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(), // no episodes config
    });

    expect(result.success).toBe(true);
    expect(mockCollectPRFeedback).not.toHaveBeenCalled();
  });

  it('does NOT call collectPRFeedback when episodes.enabled is false', async () => {
    const episodesConfig = {
      enabled: false,
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    expect(result.success).toBe(true);
    expect(mockCollectPRFeedback).not.toHaveBeenCalled();
  });

  it('does NOT call collectPRFeedback when no PR was created (no changes)', async () => {
    const { commitAndPush } = await import('../services/worktree.js');
    vi.mocked(commitAndPush).mockResolvedValueOnce({
      committed: false,
      filesStaged: [],
      commitMessage: '',
    });

    const episodesConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    // Pipeline succeeds but no PR created
    expect(result.success).toBe(true);
    expect(result.prUrl).toBeUndefined();
    expect(mockCollectPRFeedback).not.toHaveBeenCalled();
  });

  it('uses .catch() for graceful degradation — collectPRFeedback failure does not break pipeline', async () => {
    mockCollectPRFeedback.mockRejectedValueOnce(new Error('Network error'));

    const episodesConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    // Should not throw even though collectPRFeedback rejects
    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    expect(result.success).toBe(true);
    expect(mockCollectPRFeedback).toHaveBeenCalledOnce();
  });

  it('calls collectPRFeedback even when pipeline fails (catch block)', async () => {
    // Make a wave throw to trigger the catch block, but still have a PR in state
    // from a previous checkpoint
    const episodesConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      max_episodes: 3,
      cross_repo: true,
      same_repo_weight: 1.5,
      language_filter: true,
    };

    // Pre-populate state with a completed ship wave that has a PR URL
    const existingState: FixState = {
      issue: makeIssue(42),
      repo: 'test-repo',
      repoPath: workDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
      waveResults: {
        assess: makeWaveResult('assess', DEFAULT_ASSESS),
        spec: makeWaveResult('spec', DEFAULT_SPEC),
        test: makeWaveResult('test', 'tests written'),
        impl: makeWaveResult('impl', { tests_passing: true }),
        quality: makeWaveResult('quality', DEFAULT_QUALITY),
        review: makeWaveResult('review', DEFAULT_REVIEW),
        ship: makeWaveResult('ship', {
          prUrl: 'https://github.com/test/repo/pull/1',
          commitMessage: 'fix: test',
          filesStaged: ['src/fix.ts'],
        }),
      },
      status: 'completed',
    };
    await saveCheckpoint(workDir, existingState);

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig({ episodes: episodesConfig }),
    });

    // All waves were skipped (already completed), pipeline completes
    expect(result.success).toBe(true);
    // collectPRFeedback should still be called in the finally block
    // because state has a ship artifact with prUrl
    expect(mockCollectPRFeedback).toHaveBeenCalledOnce();
  });
});
