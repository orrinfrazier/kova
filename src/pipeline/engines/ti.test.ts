// Tests for the TIEngine adapter (issue #355).
//
// The TIEngine wraps `runParallelPieceTILoop` from loops.ts behind the
// WaveEngine contract. These tests verify it (a) implements the contract,
// (b) delegates to the loop with the right merged config, and (c) maps the
// loop's result into an EngineResult/WaveHandoff with the right confidence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, WaveResult } from '../../types/index.js';
import { createTIEngine } from './ti.js';
import type { EngineContext, TIEngineInput } from './types.js';

vi.mock('../loops.js', async (orig) => {
  const actual = (await orig()) as typeof import('../loops.js');
  return {
    ...actual,
    runParallelPieceTILoop: vi.fn(),
  };
});

const { runParallelPieceTILoop } = await import('../loops.js');
const mockRun = runParallelPieceTILoop as unknown as ReturnType<typeof vi.fn>;

const stubConfig = {
  model: { test: 'sonnet', impl: 'sonnet' },
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

function input(overrides: Partial<TIEngineInput> = {}): TIEngineInput {
  return {
    issue: stubIssue,
    waveResults: {},
    ...overrides,
  };
}

function makeWaveResult(wave: 'test' | 'impl'): WaveResult {
  return {
    wave,
    timestamp: new Date().toISOString(),
    model: 'sonnet',
    provider: 'anthropic',
    cost: 0.1,
    turns: 1,
    confidence: 'high',
    artifact: {},
    approach_notes: '',
    promptHash: 'hash',
  } as unknown as WaveResult;
}

function makeOkLoopResult() {
  return {
    testWaveResult: makeWaveResult('test'),
    implWaveResult: makeWaveResult('impl'),
    testsPassing: true,
    totalCost: 0.42,
    attempts: 1,
    pieceResults: [],
    modifiedFilesPerAttempt: [],
  };
}

describe('TIEngine', () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it('declares name === "impl"', () => {
    const engine = createTIEngine();
    expect(engine.name).toBe('impl');
  });

  it('delegates run() to runParallelPieceTILoop with merged ctx + input', async () => {
    mockRun.mockResolvedValueOnce(makeOkLoopResult());
    const engine = createTIEngine();
    await engine.run(ctx({ cacheContext: { repo: 'owner/repo', issue: 999 } }), input({ prContext: 'PR text' }));
    expect(mockRun).toHaveBeenCalledOnce();
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.workDir).toBe('/tmp/work');
    expect(args.repoConfig).toBe(stubConfig);
    expect(args.issue).toBe(stubIssue);
    expect(args.prContext).toBe('PR text');
    expect((args.cacheContext as { issue: number }).issue).toBe(999);
  });

  it('threads sandbox from EngineContext when present', async () => {
    mockRun.mockResolvedValueOnce(makeOkLoopResult());
    const fakeSandbox = { containerId: 'c-1' } as unknown as EngineContext['sandbox'];
    const engine = createTIEngine();
    await engine.run(ctx({ sandbox: fakeSandbox }), input());
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.sandbox).toBe(fakeSandbox);
  });

  it('threads projectContext when present', async () => {
    mockRun.mockResolvedValueOnce(makeOkLoopResult());
    const fakePC = { claudeMd: 'x' } as unknown as EngineContext['projectContext'];
    const engine = createTIEngine();
    await engine.run(ctx({ projectContext: fakePC }), input());
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.projectContext).toBe(fakePC);
  });

  it('returns EngineResult with handoff.wave === "impl" and high confidence when testsPassing', async () => {
    mockRun.mockResolvedValueOnce(makeOkLoopResult());
    const engine = createTIEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.wave).toBe('impl');
    expect(result.handoff.confidence).toBe('high');
    expect(result.handoff.cost).toBe(0.42);
  });

  it('returns low confidence when testsPassing === false', async () => {
    const loopResult = makeOkLoopResult();
    loopResult.testsPassing = false;
    (loopResult as unknown as { diagnosis: string }).diagnosis = 'APPROACH_WRONG';
    mockRun.mockResolvedValueOnce(loopResult);
    const engine = createTIEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.confidence).toBe('low');
    expect(result.handoff.approach_notes).toContain('APPROACH_WRONG');
  });

  it('places the full loop result on handoff.artifact', async () => {
    const loopResult = makeOkLoopResult();
    mockRun.mockResolvedValueOnce(loopResult);
    const engine = createTIEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.artifact).toBe(loopResult);
  });

  it('propagates throws from runParallelPieceTILoop', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    const engine = createTIEngine();
    await expect(engine.run(ctx(), input())).rejects.toThrow('boom');
  });

  it('forwards skipTestPhase / skipImplPhase / extraImplAttempts input flags', async () => {
    mockRun.mockResolvedValueOnce(makeOkLoopResult());
    const engine = createTIEngine();
    await engine.run(ctx(), input({ skipTestPhase: true, skipImplPhase: false, extraImplAttempts: 2 }));
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.skipTestPhase).toBe(true);
    expect(args.skipImplPhase).toBe(false);
    expect(args.extraImplAttempts).toBe(2);
  });
});
