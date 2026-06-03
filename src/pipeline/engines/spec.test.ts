// Tests for SpecEngine (issue #354).
//
// SpecEngine wraps the WAVE S spawnWave call plus the piece-merging /
// file-ownership validation logic that runs against the spec artifact.
// It encapsulates the retry orchestration the fix.ts orchestrator did inline:
//   1. Initial spec run
//   2. Validate pieces against each other + pendingPRFiles
//   3. If conflicts → re-run spec with feedback (one retry)
//   4. Return the (possibly merged) spec artifact + a `serialFallback` flag
//      + `mergeDependencies` so the orchestrator can act on persistent conflicts.
//
// The orchestrator still owns: empty-pieces post-retry (#243 path), respec
// escalation after TI failure, and downstream wave wiring. SpecEngine is the
// pure produce-a-validated-spec wrapper.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FallbackWaveHandoff } from '../../ai/wave-executor.js';
import type { WaveHandoff } from '../../types/handoffs.js';
import type { SpecPiece, SpecResult } from '../../types/index.js';
import { SpecEngine } from './spec.js';
import type { EngineContext } from './types.js';

vi.mock('../../sandbox/dispatch.js', () => ({
  dispatchSpawnWave: vi.fn(),
}));
vi.mock('../prompts.js', () => ({
  loadPrompt: vi.fn(async () => 'SPEC SYSTEM PROMPT'),
}));
vi.mock('../../services/prompt-versions.js', () => ({
  detectPromptChange: vi.fn(async () => null),
  hashPrompt: vi.fn(() => 'prompt-hash-spec-xyz'),
  recordPromptVersion: vi.fn(async () => undefined),
}));
vi.mock('../../ai/index.js', () => ({
  buildWaveSessionId: vi.fn(({ wave, repo, issue }) => `${repo}:${issue}:${wave}`),
  getMCPToolsForWave: vi.fn(() => undefined),
  getModelString: vi.fn(() => 'anthropic:claude-opus'),
  getWaveTools: vi.fn(() => []),
  resolveThinkingLevel: vi.fn(() => undefined),
  resolveWaveModel: vi.fn(() => ({ id: 'opus', provider: 'anthropic' })),
  isConsensusPool: vi.fn(() => false),
  isLocalModel: vi.fn(() => false),
  getApiFallbackModelString: vi.fn(() => 'anthropic:claude-sonnet'),
}));

import { dispatchSpawnWave } from '../../sandbox/dispatch.js';

function makeStubConfig(): EngineContext['config'] {
  return {
    model: {
      assess: 'anthropic:opus',
      spec: 'anthropic:opus',
      test: 'anthropic:sonnet',
      impl: 'anthropic:sonnet',
      quality: 'anthropic:haiku',
      review: 'anthropic:opus',
    },
    rules: { coverage: 80 },
    mcp: undefined,
    tools: undefined,
  } as unknown as EngineContext['config'];
}

function makeCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    workDir: '/tmp/work',
    repoPath: '/tmp/repo',
    repoName: 'owner/repo',
    config: makeStubConfig(),
    ...overrides,
  };
}

function makeSpecHandoff(spec: SpecResult): FallbackWaveHandoff<SpecResult> {
  const handoff: WaveHandoff<SpecResult> = {
    wave: 'spec',
    timestamp: new Date().toISOString(),
    model: 'anthropic:claude-opus',
    cost: 0.1,
    turns: 5,
    confidence: 'high',
    parsed: true,
    artifact: spec,
    approach_notes: '',
  };
  return { ...handoff, fallback_used: false };
}

function piece(name: string, files: string[]): SpecPiece {
  return {
    name,
    description: `${name} piece`,
    files,
    acceptance_criteria: [`${name} works`],
    wiring: [],
  };
}

describe('SpecEngine', () => {
  beforeEach(() => {
    vi.mocked(dispatchSpawnWave).mockReset();
  });

  it('has name "spec"', () => {
    expect(SpecEngine.name).toBe('spec');
  });

  it('runs spawnWave with wave=spec and returns the artifact for a clean spec', async () => {
    const clean: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1', ['a.ts']), piece('p2', ['b.ts'])],
      dependency_order: [[0, 1]],
      constraints: [],
    };
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(clean));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'spec this issue',
      pendingPRFiles: [],
    });

    expect(dispatchSpawnWave).toHaveBeenCalledOnce();
    const artifact = result.handoff.artifact as SpecResult;
    expect(artifact.pieces.length).toBe(2);
    expect(result.serialFallback).toBe(false);
    expect(result.mergeDependencies).toBeUndefined();
  });

  it('merges overlapping pieces in the same tier without retrying spawnWave', async () => {
    // p1 + p2 both touch a.ts → validator merges them into a single piece.
    const conflicting: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1', ['a.ts', 'b.ts']), piece('p2', ['a.ts', 'c.ts'])],
      dependency_order: [[0, 1]],
      constraints: [],
    };
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(conflicting));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'spec this issue',
      pendingPRFiles: [],
    });

    // Merge happens in-engine — no retry call to dispatchSpawnWave.
    expect(dispatchSpawnWave).toHaveBeenCalledTimes(1);
    const artifact = result.handoff.artifact as SpecResult;
    expect(artifact.pieces.length).toBe(1);
    expect(result.serialFallback).toBe(false);
  });

  it('retries spawnWave when a pending PR conflict is present', async () => {
    // p1 touches pending-pr-file.ts → validator says retry; second spec is clean.
    const conflictingWithPR: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1', ['pending-pr-file.ts']), piece('p2', ['b.ts'])],
      dependency_order: [[0], [1]],
      constraints: [],
    };
    const cleanAfterRetry: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1-fixed', ['x.ts']), piece('p2', ['b.ts'])],
      dependency_order: [[0], [1]],
      constraints: [],
    };
    vi.mocked(dispatchSpawnWave)
      .mockResolvedValueOnce(makeSpecHandoff(conflictingWithPR))
      .mockResolvedValueOnce(makeSpecHandoff(cleanAfterRetry));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'spec this issue',
      pendingPRFiles: ['pending-pr-file.ts'],
    });

    expect(dispatchSpawnWave).toHaveBeenCalledTimes(2);
    const artifact = result.handoff.artifact as SpecResult;
    expect(artifact.pieces[0]?.name).toBe('p1-fixed');
    expect(result.serialFallback).toBe(false);
    expect(result.mergeDependencies).toBeUndefined();
  });

  it('does not retry on piece-to-piece overlap alone (validator merges them in place)', async () => {
    // Important behavior pin: piece overlap WITHOUT a pending-PR conflict
    // never triggers a spec retry. The validator's union-find merge always
    // reduces piece count when overlaps exist (N≥2), so `merged=true` and
    // `needsRetry = overlaps>0 && !merged` is false. The serialFallback flag
    // is defense-in-depth for the impossible "overlap but no merge" path.
    const overlap: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1', ['a.ts']), piece('p2', ['a.ts'])],
      dependency_order: [[0], [1]],
      constraints: [],
    };
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(overlap));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'spec this issue',
      pendingPRFiles: [],
    });

    // No retry, no serialFallback — validator absorbed the conflict.
    expect(dispatchSpawnWave).toHaveBeenCalledTimes(1);
    expect(result.serialFallback).toBe(false);
    // Pieces were merged.
    const artifact = result.handoff.artifact as SpecResult;
    expect(artifact.pieces.length).toBe(1);
  });

  it('records mergeDependencies when pending-PR conflicts persist after retry', async () => {
    const conflictingWithPR: SpecResult = {
      summary: 'test spec',
      pieces: [piece('p1', ['pr-file.ts']), piece('p2', ['b.ts'])],
      dependency_order: [[0], [1]],
      constraints: [],
    };
    // Retry also still conflicts.
    vi.mocked(dispatchSpawnWave)
      .mockResolvedValueOnce(makeSpecHandoff(conflictingWithPR))
      .mockResolvedValueOnce(makeSpecHandoff(conflictingWithPR));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'spec this issue',
      pendingPRFiles: ['pr-file.ts'],
      pendingPRs: [
        { number: 100, files: ['pr-file.ts'] },
        { number: 200, files: ['unrelated.ts'] },
      ],
    });

    expect(result.mergeDependencies).toEqual([100]);
  });

  it('skips validation entirely when the spec produces zero pieces (empty path)', async () => {
    const empty: SpecResult = {
      summary: 'test spec',
      pieces: [],
      dependency_order: [],
      constraints: [],
    };
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(empty));

    const result = await SpecEngine.run(makeCtx(), {
      userMessage: 'go',
      pendingPRFiles: [],
    });

    // Zero pieces → no retry triggered by validator; orchestrator handles the
    // empty-pieces fallback path separately.
    expect(dispatchSpawnWave).toHaveBeenCalledTimes(1);
    expect((result.handoff.artifact as SpecResult).pieces.length).toBe(0);
  });

  it('propagates errors from dispatchSpawnWave', async () => {
    vi.mocked(dispatchSpawnWave).mockRejectedValueOnce(new Error('spec wave timeout'));

    await expect(SpecEngine.run(makeCtx(), { userMessage: 'go', pendingPRFiles: [] })).rejects.toThrow(
      'spec wave timeout',
    );
  });

  it('forwards runtimeFactory + eventContext from ctx into dispatchSpawnWave', async () => {
    const spec: SpecResult = { summary: 's', pieces: [], dependency_order: [], constraints: [] };
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(spec));

    const runtimeFactory = vi.fn() as unknown as NonNullable<EngineContext['runtimeFactory']>;
    const eventBus = { publish: vi.fn() } as unknown as NonNullable<EngineContext['eventContext']>['eventBus'];
    const eventContext = { eventBus, runId: 'r2', repoId: 'owner/repo', fixId: 'f2' };

    await SpecEngine.run(makeCtx({ runtimeFactory, eventContext }), {
      userMessage: 'go',
      pendingPRFiles: [],
    });

    const call = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(call?.runtimeFactory).toBe(runtimeFactory);
    expect(call?.eventBus).toBe(eventBus);
    expect(call?.eventContext).toEqual({ runId: 'r2', repoId: 'owner/repo', fixId: 'f2' });
  });

  it('forwards resolvedMcpServers only when sandbox is set', async () => {
    const spec: SpecResult = { summary: 's', pieces: [], dependency_order: [], constraints: [] };

    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(spec));
    const resolvedMcpServers = { srvA: { command: 'node', args: ['srv.js'] } } as unknown as NonNullable<
      EngineContext['resolvedMcpServers']
    >;

    // Without sandbox — mcpServers should be elided.
    await SpecEngine.run(makeCtx({ resolvedMcpServers }), { userMessage: 'host', pendingPRFiles: [] });
    expect(vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0]?.mcpServers).toBeUndefined();

    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeSpecHandoff(spec));
    const sandbox = { containerName: 'kova', repoPath: '/workspace' } as unknown as NonNullable<
      EngineContext['sandbox']
    >;
    await SpecEngine.run(makeCtx({ resolvedMcpServers, sandbox }), {
      userMessage: 'sandbox',
      pendingPRFiles: [],
    });
    expect(vi.mocked(dispatchSpawnWave).mock.calls[1]?.[0]?.mcpServers).toBe(resolvedMcpServers);
  });
});
