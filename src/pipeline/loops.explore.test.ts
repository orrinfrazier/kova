// Explore-mode plumbing tests for runPieceTILoop.
//
// AC (issue #282): --mode explore runs additional impl attempts per piece so
// the review wave can select the winner. Phase 1 implements this as an
// extraImplAttempts knob that increases the per-piece retry budget. Full
// parallel-impl + review-adjudication will be a follow-up (tracked in PR body).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, SpecPiece } from '../types/index.js';

vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    executeWaveWithRetry: vi.fn(),
    resolveThinkingLevel: actual.resolveThinkingLevel,
  };
});

vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({
    language: 'typescript',
    testRunner: 'vitest',
  }),
}));

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock system prompt'),
  resolvePromptsDir: vi.fn().mockReturnValue(undefined),
}));

const { runPieceTILoop } = await import('./loops.js');
const { executeWaveWithRetry } = await import('../ai/index.js');

type TestRunner = (command: string, workDir: string) => Promise<{ passed: boolean; output: string; exitCode: number }>;

const mockExecute = vi.mocked(executeWaveWithRetry);

function makePiece(idx: number): SpecPiece {
  return {
    name: `piece-${idx}`,
    description: `Piece ${idx} description`,
    files: [`src/piece${idx}.ts`],
    acceptance_criteria: [`AC ${idx}-1`],
    wiring: [],
  };
}

function makeConfig(): RepoConfig {
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
  };
}

function testWaveExecResult() {
  return {
    result: 'done',
    success: true,
    duration: 100,
    turns: 1,
    cost: 0.05,
    model: 'test-model',
    structuredOutput: { test_files_created: ['src/x.test.ts'], test_count: 1, all_failing: true },
  };
}

function implWaveExecResult() {
  return {
    result: 'done',
    success: true,
    duration: 200,
    turns: 5,
    cost: 0.1,
    model: 'impl-model',
  };
}

describe('runPieceTILoop --mode explore plumbing', () => {
  let mockTestRunner: TestRunner;

  beforeEach(() => {
    mockExecute.mockClear();
    mockTestRunner = vi.fn();
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValue(implWaveExecResult());
  });

  it('extraImplAttempts: 1 raises the per-piece retry budget by 1', async () => {
    // 4 failures → exhausts default 3 retries (would diagnose), but explore adds 1 → 4 attempts.
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 2', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 3', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      extraImplAttempts: 1,
    });

    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(4);
  });

  it('extraImplAttempts: 0 (default) keeps the standard 3-attempt budget', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 2', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 3', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      extraImplAttempts: 0,
    });

    expect(result.testsPassing).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it('extraImplAttempts: 2 raises the budget by 2 (5 attempts total)', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 2', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 3', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 4', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      extraImplAttempts: 2,
    });

    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(5);
  });

  it('does not exceed budget when first attempt succeeds', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      extraImplAttempts: 2,
    });

    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('explicit maxRetries overrides extraImplAttempts derivation', async () => {
    // Caller specified maxRetries: 2 → 2 attempts even with extraImplAttempts: 5.
    // This preserves backward-compat: explicit maxRetries always wins.
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL 2', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      maxRetries: 2,
      extraImplAttempts: 5,
    });

    // maxRetries: 2 wins → 2 attempts, both fail → testsPassing false
    expect(result.testsPassing).toBe(false);
    expect(result.attempts).toBe(2);
  });
});
