// Tests for #262: spawnConsensusWave must append a disagreement-log JSONL
// record whenever the adjudicator rejects the pool consensus/majority.
//
// Mocks `spawnWaveAgent` at the module level + injects a stub
// `appendDisagreement` callback so the test exercises the rejection-detection
// logic without touching the filesystem.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveHandoff } from '../types/index.js';

const mockSpawnWaveAgent = vi.fn();

vi.mock('./wave-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wave-executor.js')>();
  return {
    ...actual,
    spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
  };
});

const { spawnConsensusWave } = await import('./parallel-executor.js');

function makeHandoff<T>(artifact: T, opts: Partial<WaveHandoff<T>> = {}): WaveHandoff<T> {
  return {
    wave: 'review',
    timestamp: '2026-06-03T00:00:00.000Z',
    model: 'anthropic:claude-sonnet-4-6',
    cost: 0.01,
    turns: 1,
    confidence: 'high',
    artifact,
    approach_notes: '',
    parsed: true,
    ...opts,
  };
}

const baseConfig = {
  wave: 'review' as const,
  tools: [],
  systemPrompt: 'sys',
  handoffContext: '',
  userMessage: 'review the diff',
  cwd: '/tmp/test',
};

describe('spawnConsensusWave — disagreement log (#262)', () => {
  beforeEach(() => {
    mockSpawnWaveAgent.mockReset();
  });

  it('appends a disagreement record when adjudicator rejects unanimous pool consensus', async () => {
    // All 3 workers agree on { verdict: 'PASS' } — adjudicator overrides with NEEDS_FIXES.
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ verdict: 'NEEDS_FIXES' }, { model, cost: 0.05 }));
      }
      return Promise.resolve(makeHandoff({ verdict: 'PASS' }, { model, cost: 0.01 }));
    });
    const appendDisagreement = vi.fn();

    const handoff = await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['anthropic:claude-sonnet-4-6', 'google:gemini-2-5-pro', 'openai:gpt-5-codex'],
      adjudicatorModel: 'anthropic:claude-opus-4-7',
      appendDisagreement,
    });

    expect(handoff.consensus.agreement).toBe('unanimous');
    // Adjudicator artifact diverged from every pool member → log emitted.
    expect(appendDisagreement).toHaveBeenCalledTimes(1);
    const record = appendDisagreement.mock.calls[0]?.[0];
    expect(record.wave).toBe('review');
    expect(record.agreement).toBe('unanimous');
    expect(record.adjudicator_model).toBe('anthropic:claude-opus-4-7');
    expect(record.pool_size).toBe(3);
    expect(record.rejected_count).toBe(3);
    expect(record.degraded).toBe(false);
    expect(record.rejected_models).toEqual([
      'anthropic:claude-sonnet-4-6',
      'google:gemini-2-5-pro',
      'openai:gpt-5-codex',
    ]);
  });

  it('appends when adjudicator overrides the majority (rejected_count = minority models too)', async () => {
    // 2 workers agree, 1 diverges. Adjudicator picks the minority — rejects the majority.
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ pick: 'C' }, { model, cost: 0.05 }));
      }
      const valueByModel: Record<string, string> = { m1: 'A', m2: 'A', m3: 'C' };
      return Promise.resolve(makeHandoff({ pick: valueByModel[model] }, { model, cost: 0.01 }));
    });
    const appendDisagreement = vi.fn();

    const handoff = await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['m1', 'm2', 'm3'],
      appendDisagreement,
    });

    expect(handoff.consensus.agreement).toBe('majority');
    expect(appendDisagreement).toHaveBeenCalledTimes(1);
    const record = appendDisagreement.mock.calls[0]?.[0];
    // Adjudicator picked m3's answer → m1 and m2 were rejected.
    expect(record.rejected_count).toBe(2);
    expect(record.rejected_models.sort()).toEqual(['m1', 'm2']);
  });

  it('does NOT append when adjudicator matches the unanimous pool', async () => {
    // Workers all agree on { v: 'OK' }; adjudicator also picks { v: 'OK' }.
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) =>
      Promise.resolve(makeHandoff({ v: 'OK' }, { model, cost: 0.01 })),
    );
    const appendDisagreement = vi.fn();

    await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['m1', 'm2', 'm3'],
      appendDisagreement,
    });

    expect(appendDisagreement).not.toHaveBeenCalled();
  });

  it('appends a record for split agreement (no majority — adjudicator chooses freely)', async () => {
    // All 3 workers disagree, adjudicator picks something else.
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ v: 'D' }, { model, cost: 0.05 }));
      }
      const byModel: Record<string, string> = { m1: 'A', m2: 'B', m3: 'C' };
      return Promise.resolve(makeHandoff({ v: byModel[model] }, { model, cost: 0.01 }));
    });
    const appendDisagreement = vi.fn();

    const handoff = await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['m1', 'm2', 'm3'],
      appendDisagreement,
    });

    expect(handoff.consensus.agreement).toBe('split');
    expect(appendDisagreement).toHaveBeenCalledTimes(1);
    const record = appendDisagreement.mock.calls[0]?.[0];
    // All 3 pool artifacts diverge from the adjudicator's choice.
    expect(record.rejected_count).toBe(3);
  });

  it('appends even when the adjudicator matches one minority pool member', async () => {
    // 2 of 3 agree on A; adjudicator picks A → matches the majority → does NOT emit.
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ pick: 'A' }, { model, cost: 0.05 }));
      }
      const valueByModel: Record<string, string> = { m1: 'A', m2: 'A', m3: 'C' };
      return Promise.resolve(makeHandoff({ pick: valueByModel[model] }, { model, cost: 0.01 }));
    });
    const appendDisagreement = vi.fn();

    await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['m1', 'm2', 'm3'],
      appendDisagreement,
    });

    // Only m3 differed from the adjudicator; record m3 as rejected.
    expect(appendDisagreement).toHaveBeenCalledTimes(1);
    const record = appendDisagreement.mock.calls[0]?.[0];
    expect(record.rejected_count).toBe(1);
    expect(record.rejected_models).toEqual(['m3']);
  });

  it('threads degraded:true into the record when a pool member dropped', async () => {
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ v: 'NEW' }, { model, cost: 0.05 }));
      }
      if (model === 'm2') return Promise.reject(new Error('boom'));
      return Promise.resolve(makeHandoff({ v: 'OLD' }, { model, cost: 0.01 }));
    });
    const appendDisagreement = vi.fn();

    await spawnConsensusWave({
      ...baseConfig,
      poolModels: ['m1', 'm2', 'm3'],
      appendDisagreement,
    });

    expect(appendDisagreement).toHaveBeenCalledTimes(1);
    const record = appendDisagreement.mock.calls[0]?.[0];
    expect(record.degraded).toBe(true);
    // dropped m2 is not in rejected_models (it had no surviving artifact)
    expect(record.rejected_models).not.toContain('m2');
  });

  it('is a no-op when appendDisagreement callback is not provided', async () => {
    // Default behavior: no callback, no log. Pool-wave callers that want
    // logging must supply the callback (or the higher-level wiring does).
    mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
      if (model.includes('opus')) {
        return Promise.resolve(makeHandoff({ v: 'NEW' }, { model, cost: 0.05 }));
      }
      return Promise.resolve(makeHandoff({ v: 'OLD' }, { model, cost: 0.01 }));
    });

    // No appendDisagreement passed — should still succeed.
    await expect(
      spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2'],
      }),
    ).resolves.toBeDefined();
  });
});
