// Tests for the QualityEngine adapter (issue #355).
//
// The QualityEngine wraps `runQualityRetryLoop` from loops.ts behind the
// WaveEngine contract. These tests verify it implements the contract,
// delegates with the right merged config, and maps the loop result into an
// EngineResult/WaveHandoff with the right confidence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, WaveResult } from '../../types/index.js';
import { createQualityEngine } from './quality.js';
import type { EngineContext, QualityEngineInput } from './types.js';

vi.mock('../loops.js', async (orig) => {
  const actual = (await orig()) as typeof import('../loops.js');
  return {
    ...actual,
    runQualityRetryLoop: vi.fn(),
  };
});

const { runQualityRetryLoop } = await import('../loops.js');
const mockRun = runQualityRetryLoop as unknown as ReturnType<typeof vi.fn>;

const stubConfig = {
  model: { quality: 'haiku', impl: 'sonnet' },
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

function input(overrides: Partial<QualityEngineInput> = {}): QualityEngineInput {
  const qualityWave: WaveResult = {
    wave: 'quality',
    timestamp: new Date().toISOString(),
    model: 'haiku',
    provider: 'anthropic',
    cost: 0.05,
    turns: 1,
    confidence: 'high',
    artifact: {},
    approach_notes: '',
    promptHash: 'h',
  } as unknown as WaveResult;

  return {
    issue: stubIssue,
    waveResults: { quality: qualityWave },
    ...overrides,
  };
}

function makeQualityResult(retried = false) {
  return {
    qualityWaveResult: {
      wave: 'quality',
      timestamp: new Date().toISOString(),
      model: 'haiku',
      provider: 'anthropic',
      cost: 0.05,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
      promptHash: 'h',
    } as unknown as WaveResult,
    retried,
    totalCost: retried ? 0.32 : 0,
  };
}

describe('QualityEngine', () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it('declares name === "quality"', () => {
    const engine = createQualityEngine();
    expect(engine.name).toBe('quality');
  });

  it('delegates run() to runQualityRetryLoop with merged ctx + input', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(false));
    const engine = createQualityEngine();
    await engine.run(ctx({ cacheContext: { repo: 'owner/repo', issue: 999 } }), input());
    expect(mockRun).toHaveBeenCalledOnce();
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.workDir).toBe('/tmp/work');
    expect(args.repoConfig).toBe(stubConfig);
    expect(args.issue).toBe(stubIssue);
    expect((args.cacheContext as { issue: number }).issue).toBe(999);
  });

  it('threads sandbox + projectContext from EngineContext when present', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(false));
    const fakeSandbox = { containerId: 'c-1' } as unknown as EngineContext['sandbox'];
    const fakePC = { claudeMd: 'x' } as unknown as EngineContext['projectContext'];
    const engine = createQualityEngine();
    await engine.run(ctx({ sandbox: fakeSandbox, projectContext: fakePC }), input());
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.sandbox).toBe(fakeSandbox);
    expect(args.projectContext).toBe(fakePC);
  });

  it('returns EngineResult with handoff.wave === "quality"', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(false));
    const engine = createQualityEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.wave).toBe('quality');
  });

  it('confidence === "high" when no retry was needed (clean pass)', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(false));
    const engine = createQualityEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.confidence).toBe('high');
  });

  it('confidence === "medium" when retried (self-healing kicked in)', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(true));
    const engine = createQualityEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.confidence).toBe('medium');
  });

  it('handoff.cost === result.totalCost', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(true));
    const engine = createQualityEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.cost).toBe(0.32);
  });

  it('places the full quality result on handoff.artifact', async () => {
    const loopResult = makeQualityResult(false);
    mockRun.mockResolvedValueOnce(loopResult);
    const engine = createQualityEngine();
    const result = await engine.run(ctx(), input());
    expect(result.handoff.artifact).toBe(loopResult);
  });

  it('propagates throws from runQualityRetryLoop', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    const engine = createQualityEngine();
    await expect(engine.run(ctx(), input())).rejects.toThrow('boom');
  });

  it('forwards testRunner + testCommand overrides from input', async () => {
    mockRun.mockResolvedValueOnce(makeQualityResult(false));
    const fakeRunner = vi.fn();
    const engine = createQualityEngine();
    await engine.run(ctx(), input({ testRunner: fakeRunner, testCommand: 'npm test' }));
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.testRunner).toBe(fakeRunner);
    expect(args.testCommand).toBe('npm test');
  });
});
