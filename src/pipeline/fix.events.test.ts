// Verifies fix() publishes fix-started + fix-done events to the EventBus
// from its entry point (issue #340). The events are the foundation for #291
// (persistent daemon + run registry) and #293 (kova attach client).
//
// Test discipline: use the same mock shape as fix.test.ts so the fix() pipeline
// completes without real AI calls. We listen on a real EventBus instance and
// assert publish ordering + payload fields.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../telemetry/event-bus/bus.js';
import type { KovaEvent } from '../telemetry/event-bus/schema.js';
import type { Issue, RepoConfig, WaveHandoff, WaveName, WaveResult } from '../types/index.js';

// --- Metrics mock (must come before importing fix) ---
vi.mock('../telemetry/metrics.js', () => ({
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

// --- Default artifacts per wave ---
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

vi.mock('../vcs/github.js', () => ({
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/777'),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest' }),
  formatToolingContext: vi.fn().mockReturnValue('Language: typescript'),
}));

vi.mock('../vcs/worktree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../vcs/worktree.js')>();
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

vi.mock('../vcs/conflict-check.js', () => ({
  checkForConflicts: vi.fn().mockResolvedValue({
    hasConflicts: false,
    conflictingFiles: [],
    overlapping: [],
    nonOverlapping: [],
  }),
}));

vi.mock('../vcs/conflict-resolver.js', () => ({
  resolveConflicts: vi.fn().mockResolvedValue({ resolved: true, filesResolved: [] }),
}));

vi.mock('./progress.js', () => ({
  ProgressTracker: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    waveCompleted: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    failed: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../core/secrets-scan.js', () => ({
  scanForSecrets: vi.fn().mockResolvedValue({ clean: true, findings: [], report: '' }),
}));

vi.mock('../core/isolation.js', () => ({
  validateIsolation: vi.fn().mockResolvedValue({ valid: true }),
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
    runtime: 'pi',
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

// --- Tests ---

describe('fix() publishes fix-started / fix-done events (issue #340)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-events-'));
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('publishes fix-started with issueNumber at the start of fix()', async () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    await fix({
      issue: makeIssue(340),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });

    const started = seen.find((e) => e.type === 'fix-started');
    expect(started).toBeDefined();
    if (started?.type !== 'fix-started') throw new Error('narrow');
    expect(started.issueNumber).toBe(340);
    expect(started.repoId).toBe('orrinfrazier/kova');
    expect(started.runId).toMatch(/.+/);
    expect(started.fixId).toMatch(/.+/);
  });

  it('publishes fix-done with outcome=done + prNumber on success', async () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await fix({
      issue: makeIssue(42),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });

    expect(result.success).toBe(true);
    const done = seen.find((e) => e.type === 'fix-done');
    expect(done).toBeDefined();
    if (done?.type !== 'fix-done') throw new Error('narrow');
    expect(done.outcome).toBe('done');
    expect(done.prNumber).toBe(777); // matches mocked PR URL .../pull/777
    expect(done.totalCostUsd).toBeGreaterThan(0);
  });

  it('publishes fix-done with outcome=failed when isolation precheck fails', async () => {
    const { validateIsolation } = await import('../core/isolation.js');
    vi.mocked(validateIsolation).mockResolvedValueOnce({ valid: false, error: 'docker not running' });

    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await fix({
      issue: makeIssue(99),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig({ isolation: 'docker' }),
      eventBus: bus,
    });

    expect(result.success).toBe(false);
    const done = seen.find((e) => e.type === 'fix-done');
    expect(done).toBeDefined();
    if (done?.type !== 'fix-done') throw new Error('narrow');
    expect(done.outcome).toBe('failed');
    expect(done.reason).toContain('docker not running');
  });

  it('publishes fix-started BEFORE fix-done, with matching fixId on the same bus', async () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    await fix({
      issue: makeIssue(7),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });

    const lifecycleTypes = seen.map((e) => e.type).filter((t) => t === 'fix-started' || t === 'fix-done');
    expect(lifecycleTypes).toEqual(['fix-started', 'fix-done']);
    const started = seen.find((e) => e.type === 'fix-started');
    const done = seen.find((e) => e.type === 'fix-done');
    expect(started?.fixId).toBeDefined();
    expect(done?.fixId).toBeDefined();
    expect(done?.fixId).toBe(started?.fixId);
  });

  it('uses getDefaultEventBus() when no bus is provided (still publishes lifecycle)', async () => {
    const { getDefaultEventBus, setDefaultEventBus, EventBus: EB } = await import('../telemetry/event-bus/bus.js');
    const original = getDefaultEventBus();
    const probe = new EB();
    const seen: KovaEvent[] = [];
    probe.subscribe((e) => seen.push(e));
    setDefaultEventBus(probe);

    try {
      await fix({
        issue: makeIssue(55),
        repoPath: workDir,
        repoName: 'orrinfrazier/kova',
        config: makeConfig(),
        // no eventBus — fix() should fall back to the default bus.
      });
      const types = seen.map((e) => e.type);
      expect(types).toContain('fix-started');
      expect(types).toContain('fix-done');
    } finally {
      setDefaultEventBus(original);
    }
  });

  it('forwards a stable eventContext (runId, repoId, fixId) on every published event', async () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    await fix({
      issue: makeIssue(101),
      repoPath: workDir,
      repoName: 'orrinfrazier/kova',
      config: makeConfig(),
      eventBus: bus,
    });

    // All published fix-* events on this bus should share runId + repoId + fixId.
    const lifecycle = seen.filter((e) => e.type === 'fix-started' || e.type === 'fix-done');
    expect(lifecycle.length).toBeGreaterThanOrEqual(2);
    const first = lifecycle[0];
    if (!first) throw new Error('no events');
    for (const e of lifecycle) {
      expect(e.runId).toBe(first.runId);
      expect(e.repoId).toBe(first.repoId);
      expect(e.fixId).toBe(first.fixId);
    }
  });
});
