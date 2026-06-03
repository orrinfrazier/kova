// Tests for AssessEngine consensus-pool routing (#261).
//
// When config.model.assess is a WaveConsensusConfig, the engine MUST route
// through spawnConsensusWave instead of dispatchSpawnWave. The consensus
// handoff carries pool_results + adjudicator_model metadata which kova's
// telemetry projection (#262) lifts onto WaveResult.consensus. The disagreement
// log callback is wired to appendConsensusDisagreement.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsensusWaveHandoff } from '../../ai/parallel-executor.js';
import type { EngineContext } from './types.js';

// Stub modules the engine touches. We mock both single-model (dispatchSpawnWave)
// and consensus (spawnConsensusWave) paths so we can assert the branch.
vi.mock('../../sandbox/dispatch.js', () => ({
  dispatchSpawnWave: vi.fn(),
}));
vi.mock('../prompts.js', () => ({
  loadPrompt: vi.fn(async () => 'ASSESS SYSTEM PROMPT'),
}));
vi.mock('../../services/prompt-versions.js', () => ({
  detectPromptChange: vi.fn(async () => null),
  hashPrompt: vi.fn(() => 'prompt-hash-consensus'),
  recordPromptVersion: vi.fn(async () => undefined),
}));
vi.mock('../../ai/parallel-executor.js', () => ({
  spawnConsensusWave: vi.fn(),
}));
vi.mock('../../services/consensus-disagreements.js', () => ({
  appendConsensusDisagreement: vi.fn(async () => undefined),
}));
vi.mock('../../ai/index.js', () => ({
  buildWaveSessionId: vi.fn(({ wave, repo, issue }) => `${repo}:${issue}:${wave}`),
  getMCPToolsForWave: vi.fn(() => undefined),
  getModelString: vi.fn((m: { provider: string; id: string }) => `${m.provider}:${m.id}`),
  getWaveTools: vi.fn(() => []),
  resolveThinkingLevel: vi.fn(() => undefined),
  // `isConsensusPool` reflects the test fixture: true when config.model.assess
  // has a `pool` array. We let the real predicate run via a thin reimpl so
  // engine code's structural check is exercised end-to-end.
  isConsensusPool: vi.fn(
    (cfg: unknown) =>
      typeof cfg === 'object' && cfg !== null && 'pool' in cfg && Array.isArray((cfg as { pool: unknown }).pool),
  ),
  isLocalModel: vi.fn(() => false),
  resolveWaveModel: vi.fn(() => {
    throw new Error('resolveWaveModel must NOT be called on a consensus pool config');
  }),
  resolveConsensusPool: vi.fn((cfg: { pool: unknown[]; adjudicator?: unknown }) => ({
    pool: cfg.pool.map((m, i) => ({
      id: `model-${i}`,
      provider: typeof m === 'string' ? m.split(':')[0] : (m as { provider: string }).provider,
    })),
    adjudicator: { id: 'opus', provider: 'anthropic' },
  })),
  getApiFallbackModelString: vi.fn(() => 'anthropic:claude-sonnet'),
}));

import { spawnConsensusWave } from '../../ai/parallel-executor.js';
import { dispatchSpawnWave } from '../../sandbox/dispatch.js';
import { appendConsensusDisagreement } from '../../services/consensus-disagreements.js';
import { AssessEngine } from './assess.js';

function makeConsensusConfig(): EngineContext['config'] {
  return {
    path: '/tmp/repo',
    model: {
      assess: {
        pool: [
          { provider: 'anthropic', model: 'claude-opus-4-6' },
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'google', model: 'gemini-2.5-pro' },
        ],
        adjudicator: 'large',
      },
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
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
    config: makeConsensusConfig(),
    ...overrides,
  };
}

function makeConsensusHandoff(): ConsensusWaveHandoff<unknown> {
  return {
    wave: 'assess',
    timestamp: new Date().toISOString(),
    model: 'anthropic:claude-opus-4-6',
    cost: 0.5,
    turns: 3,
    confidence: 'high',
    artifact: {
      grade: 'B',
      should_proceed: true,
      reasoning: 'Adjudicated',
      risk: 'low',
      surface_area: { files: ['a.ts'], modules_affected: ['m1'], estimated_lines: 50 },
    },
    approach_notes: 'consensus reached',
    consensus: {
      pool_results: [
        { model: 'anthropic:claude-opus-4-6', cost: 0.1, status: 'success' as const },
        { model: 'openai:gpt-4o', cost: 0.15, status: 'success' as const },
        { model: 'google:gemini-2.5-pro', cost: 0.05, status: 'success' as const },
      ],
      adjudicator_model: 'anthropic:claude-opus-4-6',
      degraded: false,
      agreement: 'majority',
    },
  };
}

describe('AssessEngine — consensus pool routing (#261)', () => {
  beforeEach(() => {
    vi.mocked(spawnConsensusWave).mockReset();
    vi.mocked(dispatchSpawnWave).mockReset();
    vi.mocked(appendConsensusDisagreement).mockReset();
  });

  it('routes to spawnConsensusWave (NOT dispatchSpawnWave) when config.model.assess is a pool', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeConsensusHandoff());

    await AssessEngine.run(makeCtx(), { userMessage: 'go' });

    expect(spawnConsensusWave).toHaveBeenCalledOnce();
    expect(dispatchSpawnWave).not.toHaveBeenCalled();
  });

  it('passes resolved pool members + adjudicator to spawnConsensusWave', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeConsensusHandoff());

    await AssessEngine.run(makeCtx(), { userMessage: 'go' });

    const call = vi.mocked(spawnConsensusWave).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.poolModels).toHaveLength(3);
    expect(call?.adjudicatorModel).toBe('anthropic:opus');
    // Wave identity + user message + cwd survive the branch.
    expect(call?.wave).toBe('assess');
    expect(call?.userMessage).toBe('go');
    expect(call?.cwd).toBe('/tmp/work');
  });

  it('wires the disagreement-log callback to appendConsensusDisagreement', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeConsensusHandoff());

    await AssessEngine.run(makeCtx({ cacheContext: { repo: 'owner/repo', issue: 261 } }), { userMessage: 'go' });

    const call = vi.mocked(spawnConsensusWave).mock.calls[0]?.[0];
    expect(call?.appendDisagreement).toBeDefined();
    // Invoking the callback fans out to the audit-log writer (#262).
    await call?.appendDisagreement?.({
      timestamp: new Date().toISOString(),
      wave: 'assess',
      agreement: 'majority',
      adjudicator_model: 'anthropic:opus',
      pool_size: 3,
      rejected_count: 1,
      degraded: false,
      rejected_models: ['openai:gpt-4o'],
      adjudicator_artifact_hash: 'abc123',
      pool_artifact_hashes: ['hash1', 'hash2', 'hash3'],
    });
    expect(appendConsensusDisagreement).toHaveBeenCalled();
  });

  it('returns the consensus handoff so WaveResult.consensus is populated downstream', async () => {
    const handoff = makeConsensusHandoff();
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(handoff);

    const result = await AssessEngine.run(makeCtx(), { userMessage: 'go' });

    // The consensus metadata MUST survive the engine boundary so `handoffToResult`
    // in fix.ts (already wired in #262) can project it onto WaveResult.consensus.
    expect((result.handoff as ConsensusWaveHandoff<unknown>).consensus).toBeDefined();
    expect((result.handoff as ConsensusWaveHandoff<unknown>).consensus.adjudicator_model).toBe(
      'anthropic:claude-opus-4-6',
    );
  });

  it('propagates errors from spawnConsensusWave', async () => {
    vi.mocked(spawnConsensusWave).mockRejectedValueOnce(new Error('insufficient survivors'));

    await expect(AssessEngine.run(makeCtx(), { userMessage: 'go' })).rejects.toThrow('insufficient survivors');
  });
});
