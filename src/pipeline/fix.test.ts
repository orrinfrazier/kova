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
          turns: 1,
        },
        spec: {
          wave: 'spec',
          success: true,
          artifact: { summary: 'test', pieces: [], dependency_order: [], constraints: [] },
          duration: 100,
          cost: 0.01,
          turns: 1,
        },
      },
      status: 'running',
    };
    await saveCheckpoint(workDir, existingState);

    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });

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

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig(), fresh: true });

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
          turns: 1,
        },
        spec: { wave: 'spec', success: true, artifact: {}, duration: 100, cost: 0.01, turns: 1 },
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

    const result = await fix({ issue: makeIssue(99), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
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

    await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(mockComment).not.toHaveBeenCalled();
  });
});

// --- Escalation protocol tests ---

function makeSuccessResult(_wave: string, extra?: Record<string, unknown>) {
  return {
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
      // Spec defaults
      summary: 'test spec',
      pieces: [],
      dependency_order: [],
      constraints: [],
      // Test defaults
      test_files_created: ['src/test.test.ts'],
      test_count: 3,
      all_failing: true,
      // Impl defaults
      files_modified: ['src/fix.ts'],
      files_created: [],
      tests_passing: true,
      approach_notes: 'done',
      // Quality defaults
      lint: 'pass',
      typecheck: 'pass',
      tests: 'pass',
      coverage: 90,
      audit: 'pass',
      all_passing: true,
      // Review defaults
      verdict: 'pass',
      findings: [],
      ...extra,
    },
  };
}

function makeImplFailResult(diagnosis?: {
  category: string;
  tests_still_failing?: string[];
  approaches_tried?: string[];
  failure_pattern?: string;
  theory?: string;
}) {
  return {
    result: 'done',
    success: true,
    duration: 100,
    turns: 1,
    cost: 0.01,
    model: 'test-model',
    structuredOutput: {
      files_modified: [],
      files_created: [],
      tests_passing: false,
      approach_notes: 'failed',
      ...(diagnosis && {
        diagnosis: {
          category: diagnosis.category,
          tests_still_failing: diagnosis.tests_still_failing ?? ['test_foo'],
          approaches_tried: diagnosis.approaches_tried ?? ['approach_1'],
          failure_pattern: diagnosis.failure_pattern ?? 'WRONG_OUTPUT',
          theory: diagnosis.theory ?? 'something is wrong',
        },
      }),
    },
  };
}

describe('fix — impl escalation protocol', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-fix-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('retries impl up to 3 times before escalating', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        implCallCount++;
        if (implCallCount <= 3) {
          return makeImplFailResult({ category: 'STUCK', theory: 'cannot figure it out' });
        }
        return makeSuccessResult('impl');
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    // STUCK doesn't spawn extra impl, so total impl calls = 3
    expect(implCallCount).toBe(3);
    expect(result.state.failedPieces).toBeDefined();
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('STUCK');
  });

  it('SPEC_WRONG: re-runs spec → test → impl after diagnosis', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    let specCallCount = 0;
    let testCallCount = 0;
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'spec') {
        specCallCount++;
        return makeSuccessResult('spec');
      }
      if (opts.wave === 'test') {
        testCallCount++;
        return makeSuccessResult('test');
      }
      if (opts.wave === 'impl') {
        implCallCount++;
        // First 3 fail with SPEC_WRONG, 4th (after escalation) succeeds
        if (implCallCount <= 3) {
          return makeImplFailResult({ category: 'SPEC_WRONG', theory: 'tests expect wrong behavior' });
        }
        return makeSuccessResult('impl');
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    // spec called: 1 (initial) + 1 (escalation) = 2
    expect(specCallCount).toBe(2);
    // test called: 1 (initial) + 1 (escalation) = 2
    expect(testCallCount).toBe(2);
    // impl called: 3 (retries) + 1 (after escalation) = 4
    expect(implCallCount).toBe(4);
    // Escalation succeeded, no failed pieces
    expect(result.state.failedPieces ?? []).toHaveLength(0);
  });

  it('APPROACH_WRONG: re-runs impl with hint from diagnosis', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    const implUserMessages: string[] = [];
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        implCallCount++;
        implUserMessages.push(opts.userMessage);
        if (implCallCount <= 3) {
          return makeImplFailResult({ category: 'APPROACH_WRONG', theory: 'need different algorithm' });
        }
        return makeSuccessResult('impl');
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    // 3 retries + 1 escalation = 4
    expect(implCallCount).toBe(4);
    // The 4th call should include the escalation hint
    expect(implUserMessages[3]).toContain('Escalation');
    expect(implUserMessages[3]).toContain('need different algorithm');
    expect(result.state.failedPieces ?? []).toHaveLength(0);
  });

  it('MISSING_CONTEXT: re-runs impl with context hint', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    const implUserMessages: string[] = [];
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        implCallCount++;
        implUserMessages.push(opts.userMessage);
        if (implCallCount <= 3) {
          return makeImplFailResult({ category: 'MISSING_CONTEXT', theory: 'need type definitions from utils' });
        }
        return makeSuccessResult('impl');
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(implCallCount).toBe(4);
    expect(implUserMessages[3]).toContain('Escalation');
    expect(implUserMessages[3]).toContain('need type definitions from utils');
    expect(result.state.failedPieces ?? []).toHaveLength(0);
  });

  it('STUCK: marks piece as failed without extra retries', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        implCallCount++;
        return makeImplFailResult({ category: 'STUCK', theory: 'no idea' });
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    // Only 3 retries, no escalation spawn
    expect(implCallCount).toBe(3);
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('STUCK');
    expect(result.state.failedPieces?.[0]?.diagnosis.theory).toBe('no idea');
  });

  it('tracks failed pieces when escalation also fails', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        // Always fail — both initial retries and escalation attempt
        return makeImplFailResult({ category: 'APPROACH_WRONG', theory: 'nothing works' });
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('APPROACH_WRONG');
    expect(result.state.failedPieces?.[0]?.diagnosis.theory).toBe('nothing works');
  });

  it('handles missing diagnosis gracefully (defaults to STUCK)', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        // Fail without structured diagnosis
        return makeImplFailResult();
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(result.state.failedPieces).toHaveLength(1);
    expect(result.state.failedPieces?.[0]?.diagnosis.category).toBe('STUCK');
    expect(result.state.failedPieces?.[0]?.diagnosis.theory).toBe('No diagnosis provided');
  });

  it('succeeds on first impl attempt without escalation', async () => {
    const { executeWaveWithRetry } = await import('../ai/index.js');
    const mockExecute = vi.mocked(executeWaveWithRetry);
    mockExecute.mockClear();

    let implCallCount = 0;
    mockExecute.mockImplementation(async (opts) => {
      if (opts.wave === 'impl') {
        implCallCount++;
      }
      return makeSuccessResult(opts.wave);
    });

    const result = await fix({ issue: makeIssue(42), repoPath: workDir, repoName: 'test-repo', config: makeConfig() });
    expect(implCallCount).toBe(1);
    expect(result.state.failedPieces ?? []).toHaveLength(0);
  });
});
