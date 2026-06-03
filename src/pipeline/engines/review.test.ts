// Tests for the ReviewEngine adapter (issue #356).
//
// The ReviewEngine wraps `runReviewLoop` from loops.ts behind the WaveEngine
// contract. These tests verify it (a) implements the contract, (b) delegates
// to the loop with the right merged config, and (c) maps the loop's result
// into an EngineResult/WaveHandoff with the right confidence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, ReviewFinding, WaveResult } from '../../types/index.js';
import { createReviewEngine } from './review.js';
import type { EngineContext, ReviewEngineInput } from './types.js';

vi.mock('../loops.js', async (orig) => {
  const actual = (await orig()) as typeof import('../loops.js');
  return {
    ...actual,
    runReviewLoop: vi.fn(),
  };
});

const { runReviewLoop } = await import('../loops.js');
const mockRun = runReviewLoop as unknown as ReturnType<typeof vi.fn>;

const stubConfig = {
  model: { review: 'opus', impl: 'sonnet' },
  isolation: 'worktree',
  rules: { coverage: 80 },
} as unknown as RepoConfig;

const stubIssue: Issue = {
  number: 999,
  title: 't',
  body: 'b',
  labels: [],
  url: 'https://github.com/owner/repo/issues/999',
};

function ctx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    workDir: '/tmp/work',
    repoPath: '/tmp/repo',
    repoName: 'owner/repo',
    config: stubConfig,
    ...overrides,
  };
}

function input(overrides: Partial<ReviewEngineInput> = {}): ReviewEngineInput {
  return {
    issue: stubIssue,
    waveResults: {},
    ...overrides,
  };
}

function makeReviewWaveResult(): WaveResult {
  return {
    wave: 'review',
    timestamp: new Date().toISOString(),
    model: 'opus',
    provider: 'anthropic',
    cost: 0.5,
    turns: 3,
    confidence: 'high',
    artifact: {},
    approach_notes: '',
    promptHash: 'h',
  } as unknown as WaveResult;
}

function makeReviewLoopResult(knownIssues: ReviewFinding[] = [], iterations = 1) {
  return {
    reviewWaveResult: makeReviewWaveResult(),
    qualityWaveResult: undefined,
    totalCost: 0.5,
    iterations,
    knownIssues,
  };
}

describe('ReviewEngine', () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it('declares name === "review"', () => {
    const engine = createReviewEngine();
    expect(engine.name).toBe('review');
  });

  it('delegates run() to runReviewLoop with merged ctx + input', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult());
    const engine = createReviewEngine();
    await engine.run(ctx({ cacheContext: { repo: 'owner/repo', issue: 999 } }), input());
    expect(mockRun).toHaveBeenCalledOnce();
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.workDir).toBe('/tmp/work');
    expect(args.repoConfig).toBe(stubConfig);
    expect(args.issue).toBe(stubIssue);
    expect((args.cacheContext as { issue: number }).issue).toBe(999);
  });

  it('threads sandbox + projectContext + playwright from EngineContext when present', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult());
    const fakeSandbox = { containerId: 'c-1' } as unknown as EngineContext['sandbox'];
    const fakePC = { claudeMd: 'x' } as unknown as EngineContext['projectContext'];
    const engine = createReviewEngine();
    await engine.run(ctx({ sandbox: fakeSandbox, projectContext: fakePC, playwright: { enabled: true } }), input());
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.sandbox).toBe(fakeSandbox);
    expect(args.projectContext).toBe(fakePC);
    expect((args.playwright as { enabled: boolean }).enabled).toBe(true);
  });

  it('returns EngineResult with handoff.wave === "review"', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult());
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.wave).toBe('review');
  });

  it('confidence === "high" when no knownIssues', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult([]));
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.confidence).toBe('high');
  });

  it('confidence === "medium" when knownIssues remain', async () => {
    const finding: ReviewFinding = {
      category: 'mechanical_fix',
      file: 'src/x.ts',
      description: 'leftover',
      severity: 'medium',
    };
    mockRun.mockResolvedValueOnce(makeReviewLoopResult([finding]));
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.confidence).toBe('medium');
  });

  it('handoff.cost === result.totalCost', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult([], 2));
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.cost).toBe(0.5);
  });

  it('places the full review loop result on handoff.artifact', async () => {
    const loopResult = makeReviewLoopResult();
    mockRun.mockResolvedValueOnce(loopResult);
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.artifact).toBe(loopResult);
  });

  it('approach_notes includes iteration count', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult([], 2));
    const engine = createReviewEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.approach_notes).toContain('2');
    expect(result.handoff.approach_notes).toContain('iteration');
  });

  it('propagates throws from runReviewLoop', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    const engine = createReviewEngine();
    await expect(engine.run(ctx(), input())).rejects.toThrow('boom');
  });

  it('forwards testRunner + reviewFeedbackContext + prContext from input', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult());
    const fakeRunner = vi.fn();
    const engine = createReviewEngine();
    await engine.run(
      ctx(),
      input({
        testRunner: fakeRunner,
        reviewFeedbackContext: 'past',
        prContext: 'pr',
        maxIterations: 3,
      }),
    );
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.testRunner).toBe(fakeRunner);
    expect(args.reviewFeedbackContext).toBe('past');
    expect(args.prContext).toBe('pr');
    expect(args.maxIterations).toBe(3);
  });

  it('forwards baselineFailures + currentFailures + prescanRunner from input', async () => {
    mockRun.mockResolvedValueOnce(makeReviewLoopResult());
    const fakePrescan = vi.fn();
    const engine = createReviewEngine();
    await engine.run(
      ctx(),
      input({
        baselineFailures: ['t-old'],
        currentFailures: ['t-new'],
        prescanRunner: fakePrescan,
      }),
    );
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.baselineFailures).toEqual(['t-old']);
    expect(args.currentFailures).toEqual(['t-new']);
    expect(args.prescanRunner).toBe(fakePrescan);
  });
});
