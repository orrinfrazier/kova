// Verifies fix() registers itself in the RunRegistry on fix-started and
// transitions to a terminal status on fix-done (issue #293). The registry is
// the discovery surface for `kova attach <run-id>` and `kova ls`.
//
// Test discipline: reuses the same mock shape as fix.events.test.ts so the
// fix() pipeline completes without real AI calls. We assert filesystem state
// after fix() resolves.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../services/event-bus/bus.js';
import { getRun, listRuns } from '../services/run-registry.js';
import type { Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

vi.mock('../services/metrics.js', () => ({
  recordWaveCompleted: vi.fn(),
  recordWaveDuration: vi.fn(),
  recordIssueFixed: vi.fn(),
  recordIssueFailed: vi.fn(),
  recordPRCreated: vi.fn(),
  setActiveFixes: vi.fn(),
  recordFixDuration: vi.fn(),
  recordFixCost: vi.fn(),
  setCurrentCostUsd: vi.fn(),
  recordRebaseAttempt: vi.fn(),
  recordConflictDetected: vi.fn(),
  recordConflictResolved: vi.fn(),
  recordConflictFailed: vi.fn(),
  serialize: vi.fn().mockReturnValue(''),
  reset: vi.fn(),
}));

const DEFAULT_ASSESS = {
  grade: 'A',
  surface_area: { files: [], estimated_lines: 10, modules_affected: [] },
  risk: 'low',
  reasoning: 'simple',
  should_proceed: true,
};
const DEFAULT_SPEC = {
  summary: 'test spec',
  pieces: [
    {
      name: 'default',
      description: 'default piece',
      files: ['src/fix.ts'],
      acceptance_criteria: ['AC1'],
      wiring: [],
    },
  ],
  dependency_order: [[0]],
  constraints: [],
};
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
  return { wave, success: true, artifact, duration: 100, cost: 0.05, turns: 1, model: 'test-model' };
}

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
    buildWaveSessionId: actual.buildWaveSessionId,
  };
});

const mockRunTILoop = vi.fn();
const mockRunParallelPieceTILoop = vi.fn();
const mockRunReviewLoop = vi.fn();
const mockRunQualityRetryLoop = vi.fn();
vi.mock('./loops.js', () => ({
  runTILoop: (...args: unknown[]) => mockRunTILoop(...args),
  runParallelPieceTILoop: (...args: unknown[]) => mockRunParallelPieceTILoop(...args),
  runReviewLoop: (...args: unknown[]) => mockRunReviewLoop(...args),
  runQualityRetryLoop: (...args: unknown[]) => mockRunQualityRetryLoop(...args),
  detectThrashing: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../services/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/777'),
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
    detectDefaultBranch: vi.fn().mockResolvedValue('main'),
    rebaseOnDefault: vi.fn().mockResolvedValue({ success: true, conflicted: false }),
    getChangedFiles: vi.fn().mockResolvedValue([]),
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

vi.mock('../services/progress.js', () => ({
  ProgressTracker: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    waveCompleted: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    failed: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/secrets-scan.js', () => ({
  scanForSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [], report: '' }),
}));

vi.mock('../services/isolation.js', () => ({
  validateIsolation: vi.fn().mockResolvedValue({ valid: true }),
}));

const { fix } = await import('./fix.js');

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
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
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
    ...overrides,
  };
}

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

  mockRunQualityRetryLoop.mockResolvedValue({
    retried: false,
    totalCost: 0,
  });
}

describe('fix() registers run in RunRegistry (issue #293)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-runreg-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('registers a Run when fix() starts, with issueNumber + status=running -> terminal', async () => {
    const bus = new EventBus();

    await fix({
      issue: makeIssue(293),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });

    const runs = await listRuns(workDir);
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run).toBeDefined();
    if (!run) throw new Error('narrow');
    expect(run.issueNumber).toBe(293);
    expect(run.repoId).toBe('orrinfrazier/kova');
    expect(run.fixId).toMatch(/^fix-293-/);
    expect(run.runId).toMatch(/^fix-293-/);
    // Terminal status after fix() resolves
    expect(['done', 'failed']).toContain(run.status);
  });

  it('registers run with status=done on successful fix', async () => {
    const bus = new EventBus();
    const result = await fix({
      issue: makeIssue(7),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });
    expect(result.success).toBe(true);
    const runs = await listRuns(workDir);
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.prNumber).toBe(777);
    expect(runs[0]?.completedAt).toBeDefined();
  });

  it('registers run with status=failed on isolation precheck failure', async () => {
    const { validateIsolation } = await import('../services/isolation.js');
    vi.mocked(validateIsolation).mockResolvedValueOnce({ valid: false, error: 'docker not running' });

    const bus = new EventBus();
    const result = await fix({
      issue: makeIssue(99),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig({ isolation: 'docker' }),
      eventBus: bus,
    });
    expect(result.success).toBe(false);
    const runs = await listRuns(workDir);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.completedAt).toBeDefined();
  });

  it('run is retrievable by getRun(runId) after fix() resolves', async () => {
    const bus = new EventBus();
    await fix({
      issue: makeIssue(33),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });
    const runs = await listRuns(workDir);
    const runId = runs[0]?.runId;
    expect(runId).toBeDefined();
    if (!runId) throw new Error('narrow');
    const fetched = await getRun(workDir, runId);
    expect(fetched).not.toBeNull();
    expect(fetched?.issueNumber).toBe(33);
  });
});
