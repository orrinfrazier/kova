// Tests for AssessEngine (issue #354).
//
// AssessEngine wraps the WAVE A spawnWave call from fix.ts. It implements
// WaveEngine<AssessEngineInput, AssessResult> and returns the same handoff +
// promptHash pair that the orchestrator persists today.
//
// Grading-gate logic (should_proceed → comment + bail) stays in the
// orchestrator — engines never make pipeline-flow decisions. They just run
// the wave and return the artifact.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FallbackWaveHandoff } from '../../ai/wave-executor.js';
import type { WaveHandoff } from '../../types/handoffs.js';
import { AssessEngine } from './assess.js';
import type { EngineContext } from './types.js';

// Stub the cross-cutting modules AssessEngine touches via spawnWave.
vi.mock('../../sandbox/dispatch.js', () => ({
  dispatchSpawnWave: vi.fn(),
}));
vi.mock('../prompts.js', () => ({
  loadPrompt: vi.fn(async () => 'ASSESS SYSTEM PROMPT'),
}));
vi.mock('../../services/prompt-versions.js', () => ({
  detectPromptChange: vi.fn(async () => null),
  hashPrompt: vi.fn(() => 'prompt-hash-abc123'),
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

function makeHandoff(): FallbackWaveHandoff<unknown> {
  const handoff: WaveHandoff<unknown> = {
    wave: 'assess',
    timestamp: new Date().toISOString(),
    model: 'anthropic:claude-opus',
    cost: 0.05,
    turns: 3,
    confidence: 'high',
    parsed: true,
    artifact: {
      grade: 'B',
      should_proceed: true,
      reasoning: 'Well-scoped, 3 files',
      risk: 'low',
      surface_area: { files: ['a.ts', 'b.ts'], modules_affected: ['m1'], estimated_lines: 100 },
    },
    approach_notes: '',
  };
  return { ...handoff, fallback_used: false };
}

describe('AssessEngine', () => {
  beforeEach(() => {
    vi.mocked(dispatchSpawnWave).mockReset();
  });

  it('has name "assess"', () => {
    expect(AssessEngine.name).toBe('assess');
  });

  it('runs spawnWave with wave=assess and the provided user message', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    const ctx = makeCtx();
    const result = await AssessEngine.run(ctx, {
      userMessage: 'Assess issue #123: fix the login bug',
    });

    expect(dispatchSpawnWave).toHaveBeenCalledOnce();
    const call = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.wave).toBe('assess');
    expect(call?.userMessage).toBe('Assess issue #123: fix the login bug');
    expect(call?.cwd).toBe('/tmp/work');
    expect(result.handoff.wave).toBe('assess');
    expect(result.promptHash).toBe('prompt-hash-abc123');
  });

  it('returns the handoff artifact passed through from spawnWave', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());
    const result = await AssessEngine.run(makeCtx(), {
      userMessage: 'go',
    });
    const artifact = result.handoff.artifact as { grade: string };
    expect(artifact.grade).toBe('B');
  });

  it('forwards cacheContext into spawnWave as a deterministic sessionId', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    await AssessEngine.run(makeCtx({ cacheContext: { repo: 'owner/repo', issue: 354 } }), { userMessage: 'go' });

    const call = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(call?.sessionId).toBe('owner/repo:354:assess');
  });

  it('forwards sandbox context as the second arg to dispatchSpawnWave', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    const sandbox = {
      containerName: 'kova-fix-123',
      repoPath: '/workspace',
      dockerCommand: 'docker',
    } as unknown as NonNullable<EngineContext['sandbox']>;

    await AssessEngine.run(makeCtx({ sandbox }), { userMessage: 'go' });

    const sandboxArg = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[1];
    expect(sandboxArg).toBe(sandbox);
  });

  it('propagates errors from dispatchSpawnWave', async () => {
    vi.mocked(dispatchSpawnWave).mockRejectedValueOnce(new Error('provider down'));

    await expect(AssessEngine.run(makeCtx(), { userMessage: 'go' })).rejects.toThrow('provider down');
  });

  it('forwards runtimeFactory from ctx into dispatchSpawnWave (issue #407)', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    const runtimeFactory = vi.fn() as unknown as NonNullable<EngineContext['runtimeFactory']>;
    await AssessEngine.run(makeCtx({ runtimeFactory }), { userMessage: 'go' });

    const call = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(call?.runtimeFactory).toBe(runtimeFactory);
  });

  it('forwards eventContext from ctx into dispatchSpawnWave (issue #340)', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    const eventBus = { publish: vi.fn() } as unknown as NonNullable<EngineContext['eventContext']>['eventBus'];
    const eventContext = { eventBus, runId: 'r1', repoId: 'owner/repo', fixId: 'f1' };
    await AssessEngine.run(makeCtx({ eventContext }), { userMessage: 'go' });

    const call = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(call?.eventBus).toBe(eventBus);
    expect(call?.eventContext).toEqual({ runId: 'r1', repoId: 'owner/repo', fixId: 'f1' });
  });

  it('forwards resolvedMcpServers ONLY when sandbox is set (issue #306)', async () => {
    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());

    const resolvedMcpServers = { srvA: { command: 'node', args: ['srv.js'] } } as unknown as NonNullable<
      EngineContext['resolvedMcpServers']
    >;
    const sandbox = { containerName: 'kova', repoPath: '/workspace' } as unknown as NonNullable<
      EngineContext['sandbox']
    >;

    // Without sandbox — mcpServers should be elided even when resolvedMcpServers is set.
    await AssessEngine.run(makeCtx({ resolvedMcpServers }), { userMessage: 'host-path' });
    const hostCall = vi.mocked(dispatchSpawnWave).mock.calls[0]?.[0];
    expect(hostCall?.mcpServers).toBeUndefined();

    vi.mocked(dispatchSpawnWave).mockResolvedValueOnce(makeHandoff());
    // With sandbox — mcpServers should be forwarded.
    await AssessEngine.run(makeCtx({ resolvedMcpServers, sandbox }), { userMessage: 'sandbox-path' });
    const sandboxCall = vi.mocked(dispatchSpawnWave).mock.calls[1]?.[0];
    expect(sandboxCall?.mcpServers).toBe(resolvedMcpServers);
  });
});
