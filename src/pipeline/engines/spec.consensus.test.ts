// Tests for SpecEngine consensus-pool routing (#261). Mirrors the assess
// consensus test — pool config routes through spawnConsensusWave.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsensusWaveHandoff } from '../../ai/parallel-executor.js';
import type { SpecResult } from '../../types/index.js';
import type { EngineContext } from './types.js';

vi.mock('../../sandbox/dispatch.js', () => ({
  dispatchSpawnWave: vi.fn(),
}));
vi.mock('../prompts.js', () => ({
  loadPrompt: vi.fn(async () => 'SPEC SYSTEM PROMPT'),
}));
vi.mock('../../services/prompt-versions.js', () => ({
  detectPromptChange: vi.fn(async () => null),
  hashPrompt: vi.fn(() => 'prompt-hash-spec-consensus'),
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
import { SpecEngine } from './spec.js';

function makeConsensusConfig(): EngineContext['config'] {
  return {
    path: '/tmp/repo',
    model: {
      assess: 'large',
      spec: {
        pool: [
          { provider: 'anthropic', model: 'claude-opus-4-6' },
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'google', model: 'gemini-2.5-pro' },
        ],
        adjudicator: 'large',
      },
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
    },
    rules: { coverage: 80, max_spec_files: 1 },
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

function makeConsensusHandoff(spec: SpecResult): ConsensusWaveHandoff<SpecResult> {
  return {
    wave: 'spec',
    timestamp: new Date().toISOString(),
    model: 'anthropic:claude-opus-4-6',
    cost: 0.5,
    turns: 5,
    confidence: 'high',
    artifact: spec,
    approach_notes: 'consensus reached',
    consensus: {
      pool_results: [
        { model: 'anthropic:claude-opus-4-6', cost: 0.2, status: 'success' as const },
        { model: 'openai:gpt-4o', cost: 0.2, status: 'success' as const },
        { model: 'google:gemini-2.5-pro', cost: 0.1, status: 'success' as const },
      ],
      adjudicator_model: 'anthropic:claude-opus-4-6',
      degraded: false,
      agreement: 'unanimous',
    },
  };
}

const minimalSpec: SpecResult = {
  summary: 'add CLI flag',
  pieces: [
    {
      name: 'add-flag',
      description: 'add CLI flag',
      files: ['src/cli/index.ts'],
      acceptance_criteria: ['Flag is parsed'],
      wiring: [],
    },
  ],
  dependency_order: [[0]],
  constraints: [],
};

describe('SpecEngine — consensus pool routing (#261)', () => {
  beforeEach(() => {
    vi.mocked(spawnConsensusWave).mockReset();
    vi.mocked(dispatchSpawnWave).mockReset();
  });

  it('routes to spawnConsensusWave when config.model.spec is a pool', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeConsensusHandoff(minimalSpec));

    await SpecEngine.run(makeCtx(), {
      userMessage: 'spec the issue',
      pendingPRFiles: [],
    });

    expect(spawnConsensusWave).toHaveBeenCalled();
    expect(dispatchSpawnWave).not.toHaveBeenCalled();
  });

  it('passes the resolved spec pool to spawnConsensusWave', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeConsensusHandoff(minimalSpec));

    await SpecEngine.run(makeCtx(), {
      userMessage: 'spec the issue',
      pendingPRFiles: [],
    });

    const call = vi.mocked(spawnConsensusWave).mock.calls[0]?.[0];
    expect(call?.wave).toBe('spec');
    expect(call?.poolModels).toHaveLength(3);
    expect(call?.adjudicatorModel).toBe('anthropic:opus');
  });
});
