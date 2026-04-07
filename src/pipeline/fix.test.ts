import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

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
    isLocalProvider: actual.isLocalProvider,
    spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
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

// --- Factories ---

function makeIssue(n: number): Issue {
  return { number: n, title: `Test issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
}

function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
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
}

// --- Tests ---

describe('fix — resume from checkpoint', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-'));
    vi.clearAllMocks();
    setupDefaultMocks();
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
        assess: makeWaveResult('assess', DEFAULT_ASSESS),
        spec: makeWaveResult('spec', DEFAULT_SPEC),
      },
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);
    mockSpawnWaveAgent.mockClear();

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    // assess + spec skipped, so spawnWaveAgent called only for quality
    const waveCalls = mockSpawnWaveAgent.mock.calls.map((c: unknown[]) => (c[0] as { wave: string }).wave);
    expect(waveCalls).not.toContain('assess');
    expect(waveCalls).not.toContain('spec');
    expect(waveCalls).toContain('quality');
    // TI loop should have been called (test + impl not in completedWaves)
    expect(mockRunParallelPieceTILoop).toHaveBeenCalledOnce();
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
    mockSpawnWaveAgent.mockClear();

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig(), fresh: true });

    // Fresh run — all waves should execute
    const waveCalls = mockSpawnWaveAgent.mock.calls.map((c: unknown[]) => (c[0] as { wave: string }).wave);
    expect(waveCalls).toContain('assess');
    expect(mockRunParallelPieceTILoop).toHaveBeenCalledOnce();
  });

  it('prints resume message when loading checkpoint', async () => {
    const existingState: FixState = {
      issue: makeIssue(42),
      repo: 'test-repo',
      repoPath: workDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedWaves: ['assess', 'spec'],
      waveResults: {
        assess: makeWaveResult('assess', DEFAULT_ASSESS),
        spec: makeWaveResult('spec', DEFAULT_SPEC),
      },
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);

    const consoleSpy = vi.spyOn(console, 'log');
    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

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
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('posts GitHub comment when assess returns grade D', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(
      makeHandoff('assess', {
        grade: 'D',
        surface_area: { files: ['src/a.ts', 'src/b.ts'], estimated_lines: 500, modules_affected: ['core', 'api'] },
        risk: 'high',
        reasoning: 'Too many interconnected changes required',
        should_proceed: false,
      }),
    );

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(result.success).toBe(false);
    expect(mockComment).toHaveBeenCalledOnce();
    const commentBody = mockComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('D');
    expect(commentBody).toContain('high');
    expect(commentBody).toContain('src/a.ts');
    expect(commentBody).toContain('Too many interconnected changes');
  });

  it('posts GitHub comment when assess returns grade F', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(
      makeHandoff('assess', {
        grade: 'F',
        surface_area: { files: [], estimated_lines: 2000, modules_affected: ['everything'] },
        risk: 'critical',
        reasoning: 'Complete rewrite needed',
        should_proceed: false,
      }),
    );

    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    const result = await fix({ issue: makeIssue(99), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(result.success).toBe(false);
    expect(mockComment).toHaveBeenCalledOnce();
    const commentBody = mockComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('F');
    expect(commentBody).toContain('critical');
  });

  it('does NOT post comment when noComment option is true', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(
      makeHandoff('assess', {
        grade: 'D',
        surface_area: { files: [], estimated_lines: 500, modules_affected: [] },
        risk: 'high',
        reasoning: 'Too complex',
        should_proceed: false,
      }),
    );

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
    const { commentOnIssue } = await import('../services/github.js');
    const mockComment = vi.mocked(commentOnIssue);
    mockComment.mockClear();

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(mockComment).not.toHaveBeenCalled();
  });
});

// --- Escalation protocol tests (via runTILoop diagnosis) ---

describe('fix — TI loop escalation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('SPEC_WRONG: re-runs spec then TI loop after diagnosis', async () => {
    let tiCallCount = 0;
    mockRunParallelPieceTILoop.mockImplementation(async () => {
      tiCallCount++;
      if (tiCallCount === 1) {
        return {
          testWaveResult: makeWaveResult('test', 'tests written'),
          implWaveResult: makeWaveResult('impl', { tests_passing: false }),
          testsPassing: false,
          totalCost: 0.03,
          attempts: 3,
          diagnosis: 'SPEC_WRONG',
          pieceResults: [],
          modifiedFilesPerAttempt: [],
        };
      }
      // Second call (after spec re-run) succeeds
      return {
        testWaveResult: makeWaveResult('test', 'tests written'),
        implWaveResult: makeWaveResult('impl', { tests_passing: true }),
        testsPassing: true,
        totalCost: 0.02,
        attempts: 1,
        pieceResults: [],
        modifiedFilesPerAttempt: [],
      };
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    expect(tiCallCount).toBe(2);
    // spawnWaveAgent called for: assess, spec (initial), spec (escalation re-run), quality
    const waveCalls = mockSpawnWaveAgent.mock.calls.map((c: unknown[]) => (c[0] as { wave: string }).wave);
    expect(waveCalls.filter((w) => w === 'spec')).toHaveLength(2);
    expect(result.state.failedPieces ?? []).toHaveLength(0);
  });

  it('APPROACH_WRONG: marks piece as failed (no extra escalation)', async () => {
    mockRunParallelPieceTILoop.mockResolvedValue({
      testWaveResult: makeWaveResult('test', 'tests written'),
      implWaveResult: makeWaveResult('impl', { tests_passing: false }),
      testsPassing: false,
      totalCost: 0.03,
      attempts: 3,
      diagnosis: 'APPROACH_WRONG',
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    // Only 1 TI loop call — no escalation re-run for APPROACH_WRONG
    expect(mockRunParallelPieceTILoop).toHaveBeenCalledOnce();
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('APPROACH_WRONG');
  });

  it('STUCK: marks piece as failed without extra retries', async () => {
    mockRunParallelPieceTILoop.mockResolvedValue({
      testWaveResult: makeWaveResult('test', 'tests written'),
      implWaveResult: makeWaveResult('impl', { tests_passing: false }),
      testsPassing: false,
      totalCost: 0.03,
      attempts: 3,
      diagnosis: 'STUCK',
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    expect(mockRunParallelPieceTILoop).toHaveBeenCalledOnce();
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('STUCK');
  });

  it('tracks failed piece when SPEC_WRONG escalation also fails', async () => {
    // Both TI loop calls fail
    mockRunParallelPieceTILoop.mockResolvedValue({
      testWaveResult: makeWaveResult('test', 'tests written'),
      implWaveResult: makeWaveResult('impl', { tests_passing: false }),
      testsPassing: false,
      totalCost: 0.03,
      attempts: 3,
      diagnosis: 'SPEC_WRONG',
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    // 2 TI loop calls: initial + escalation retry
    expect(mockRunParallelPieceTILoop).toHaveBeenCalledTimes(2);
    expect(result.state.failedPieces).toHaveLength(1);
  });

  it('succeeds on first TI loop attempt without escalation', async () => {
    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    expect(mockRunParallelPieceTILoop).toHaveBeenCalledOnce();
    expect(result.state.failedPieces ?? []).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('handles missing diagnosis gracefully (defaults to STUCK)', async () => {
    mockRunParallelPieceTILoop.mockResolvedValue({
      testWaveResult: makeWaveResult('test', 'tests written'),
      implWaveResult: makeWaveResult('impl', { tests_passing: false }),
      testsPassing: false,
      totalCost: 0.03,
      attempts: 3,
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('STUCK');
  });
});
