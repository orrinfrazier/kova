import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

// --- Metrics mock (mirrors fix.test.ts + new rebase/conflict metrics) ---
const mockRecordWaveCompleted = vi.fn();
const mockRecordWaveDuration = vi.fn();
const mockRecordIssueFixed = vi.fn();
const mockRecordIssueFailed = vi.fn();
const mockRecordPRCreated = vi.fn();
const mockSetActiveFixes = vi.fn();
const mockRecordFixDuration = vi.fn();
const mockRecordFixCost = vi.fn();
const mockSetCurrentCostUsd = vi.fn();
const mockRecordRebaseAttempt = vi.fn();
const mockRecordConflictDetected = vi.fn();
const mockRecordConflictResolved = vi.fn();
const mockRecordConflictFailed = vi.fn();

vi.mock('../services/metrics.js', () => ({
  recordWaveCompleted: (...args: unknown[]) => mockRecordWaveCompleted(...args),
  recordWaveDuration: (...args: unknown[]) => mockRecordWaveDuration(...args),
  recordIssueFixed: (...args: unknown[]) => mockRecordIssueFixed(...args),
  recordIssueFailed: (...args: unknown[]) => mockRecordIssueFailed(...args),
  recordPRCreated: (...args: unknown[]) => mockRecordPRCreated(...args),
  setActiveFixes: (...args: unknown[]) => mockSetActiveFixes(...args),
  recordFixDuration: (...args: unknown[]) => mockRecordFixDuration(...args),
  recordFixCost: (...args: unknown[]) => mockRecordFixCost(...args),
  setCurrentCostUsd: (...args: unknown[]) => mockSetCurrentCostUsd(...args),
  recordRebaseAttempt: (...args: unknown[]) => mockRecordRebaseAttempt(...args),
  recordConflictDetected: (...args: unknown[]) => mockRecordConflictDetected(...args),
  recordConflictResolved: (...args: unknown[]) => mockRecordConflictResolved(...args),
  recordConflictFailed: (...args: unknown[]) => mockRecordConflictFailed(...args),
  serialize: vi.fn().mockReturnValue(''),
  reset: vi.fn(),
}));

// --- Default artifacts per wave ---

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

const mockRunTILoop = vi.fn();
const mockRunParallelPieceTILoop = vi.fn();
const mockRunReviewLoop = vi.fn();
vi.mock('./loops.js', () => ({
  runTILoop: (...args: unknown[]) => mockRunTILoop(...args),
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

// --- Worktree mock: includes rebaseOnDefault ---
const mockRebaseOnDefault = vi.fn();
const mockCommitAndPush = vi.fn();

vi.mock('../services/worktree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/worktree.js')>();
  return {
    ...original,
    createWorktree: vi.fn().mockImplementation((_repoPath: string, issueNumber: number) => ({
      path: `/tmp/test-worktree-${issueNumber}`,
      branch: `kova/fix-${issueNumber}`,
    })),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    detectDefaultBranch: vi.fn().mockResolvedValue('main'),
    commitAndPush: (...args: unknown[]) => mockCommitAndPush(...args),
    rebaseOnDefault: (...args: unknown[]) => mockRebaseOnDefault(...args),
  };
});

// --- Conflict resolver mock ---
const mockResolveConflicts = vi.fn();

vi.mock('../services/conflict-check.js', () => ({
  checkForConflicts: vi.fn().mockResolvedValue({
    hasConflicts: false,
    conflictingFiles: [],
    overlapping: [],
    nonOverlapping: [],
  }),
}));

vi.mock('../services/conflict-resolver.js', () => ({
  resolveConflicts: (...args: unknown[]) => mockResolveConflicts(...args),
}));

// --- Progress mock ---
const mockProgressStart = vi.fn().mockResolvedValue(undefined);
const mockProgressWaveCompleted = vi.fn().mockResolvedValue(undefined);
const mockProgressComplete = vi.fn().mockResolvedValue(undefined);
const mockProgressFailed = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/progress.js', () => ({
  ProgressTracker: vi.fn().mockImplementation(() => ({
    start: mockProgressStart,
    waveCompleted: mockProgressWaveCompleted,
    complete: mockProgressComplete,
    failed: mockProgressFailed,
  })),
}));

const { fix } = await import('./fix.js');

// --- Factories ---

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
    ...overrides,
  };
}

/** Set up default mocks for a happy-path pipeline run. */
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

  // Default: rebase succeeds cleanly (no conflicts)
  mockRebaseOnDefault.mockResolvedValue({ success: true, conflicted: false });

  // Default: commit succeeds
  mockCommitAndPush.mockResolvedValue({
    committed: true,
    filesStaged: ['src/fix.ts'],
    commitMessage: 'fix: Test issue (#42)',
  });

  // Default: conflict resolution succeeds (should not be called in happy path)
  mockResolveConflicts.mockResolvedValue({ resolved: true, filesResolved: [] });
}

// --- Tests ---

describe('fix — rebase before ship', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-rebase-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('ship wave calls rebaseOnDefault before commitAndPush', async () => {
    const callOrder: string[] = [];
    mockRebaseOnDefault.mockImplementation(async () => {
      callOrder.push('rebaseOnDefault');
      return { success: true, conflicted: false };
    });
    mockCommitAndPush.mockImplementation(async () => {
      callOrder.push('commitAndPush');
      return {
        committed: true,
        filesStaged: ['src/fix.ts'],
        commitMessage: 'fix: Test issue (#42)',
      };
    });

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.success).toBe(true);
    expect(mockRebaseOnDefault).toHaveBeenCalled();
    expect(mockCommitAndPush).toHaveBeenCalled();

    // rebaseOnDefault must be called BEFORE commitAndPush
    const rebaseIdx = callOrder.indexOf('rebaseOnDefault');
    const commitIdx = callOrder.indexOf('commitAndPush');
    expect(rebaseIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(rebaseIdx).toBeLessThan(commitIdx);
  });

  it('ship wave calls resolveConflicts on rebase conflict', async () => {
    let rebaseCallCount = 0;
    mockRebaseOnDefault.mockImplementation(async () => {
      rebaseCallCount++;
      if (rebaseCallCount === 1) {
        return { success: false, conflicted: true, conflictFiles: ['src/fix.ts'] };
      }
      return { success: true, conflicted: false };
    });

    mockResolveConflicts.mockResolvedValue({ resolved: true, filesResolved: ['src/fix.ts'] });

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    // resolveConflicts should have been invoked after the first failed rebase
    expect(mockResolveConflicts).toHaveBeenCalled();

    // rebaseOnDefault called once — resolveConflicts completes the rebase internally
    expect(mockRebaseOnDefault).toHaveBeenCalledTimes(1);

    // Pipeline should continue — commitAndPush should still be called
    expect(mockCommitAndPush).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('ship wave fails on unresolvable conflict', async () => {
    mockRebaseOnDefault.mockResolvedValue({
      success: false,
      conflicted: true,
      conflictFiles: ['src/fix.ts'],
    });

    mockResolveConflicts.mockResolvedValue({
      resolved: false,
      filesUnresolved: ['src/fix.ts'],
    });

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    // Fix should fail due to unresolvable conflict
    expect(result.success).toBe(false);
    expect(result.state.status).toBe('failed');

    // commitAndPush should NOT have been called — we couldn't rebase
    expect(mockCommitAndPush).not.toHaveBeenCalled();
  });
});

describe('fix — rebase conflict metrics', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-rebase-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('records rebaseAttempt on successful rebase (no conflict)', async () => {
    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(mockRecordRebaseAttempt).toHaveBeenCalled();
    expect(mockRecordConflictDetected).not.toHaveBeenCalled();
    expect(mockRecordConflictResolved).not.toHaveBeenCalled();
    expect(mockRecordConflictFailed).not.toHaveBeenCalled();
  });

  it('records conflict detected and resolved metrics on successful resolution', async () => {
    let rebaseCallCount = 0;
    mockRebaseOnDefault.mockImplementation(async () => {
      rebaseCallCount++;
      if (rebaseCallCount === 1) {
        return { success: false, conflicted: true, conflictFiles: ['src/fix.ts'] };
      }
      return { success: true, conflicted: false };
    });

    mockResolveConflicts.mockResolvedValue({ resolved: true, filesResolved: ['src/fix.ts'] });

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(mockRecordRebaseAttempt).toHaveBeenCalled();
    expect(mockRecordConflictDetected).toHaveBeenCalled();
    expect(mockRecordConflictResolved).toHaveBeenCalled();
    expect(mockRecordConflictFailed).not.toHaveBeenCalled();
  });

  it('records conflict detected and failed metrics on unresolvable conflict', async () => {
    mockRebaseOnDefault.mockResolvedValue({
      success: false,
      conflicted: true,
      conflictFiles: ['src/fix.ts'],
    });

    mockResolveConflicts.mockResolvedValue({
      resolved: false,
      filesUnresolved: ['src/fix.ts'],
    });

    await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(mockRecordRebaseAttempt).toHaveBeenCalled();
    expect(mockRecordConflictDetected).toHaveBeenCalled();
    expect(mockRecordConflictFailed).toHaveBeenCalled();
    expect(mockRecordConflictResolved).not.toHaveBeenCalled();
  });
});
