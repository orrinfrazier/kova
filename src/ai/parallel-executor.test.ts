// Tests for spawnConsensusWave — parallel multi-model wave executor (#260).
//
// Scenarios from issue AC:
//   1. agreement: 3 workers return matching artifacts, adjudicator picks
//   2. divergence: 3 workers return different artifacts, adjudicator reconciles
//   3. one-fails: 1 of 3 workers throws on both attempts (dropped), adjudication proceeds
//   4. all-but-one-fails: 2 of 3 workers fail → entire run throws
//   5. cost summation: consensus.cost === sum(worker.cost) + adjudicator.cost
//   6. adjudicator forced to large regardless of pool tiers
//   7. degraded:true when any worker dropped
//
// Mocks `spawnWaveAgent` at the module level so the tests exercise the
// parallel-executor logic, not the underlying runtime.

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

// Pull in after mock is registered.
const { spawnConsensusWave } = await import('./parallel-executor.js');

function makeHandoff<T>(artifact: T, opts: Partial<WaveHandoff<T>> = {}): WaveHandoff<T> {
  return {
    wave: 'spec',
    timestamp: '2026-06-02T00:00:00.000Z',
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
  wave: 'spec' as const,
  tools: [],
  systemPrompt: 'sys',
  handoffContext: '',
  userMessage: 'do the thing',
  cwd: '/tmp/test',
};

describe('spawnConsensusWave (#260)', () => {
  beforeEach(() => {
    mockSpawnWaveAgent.mockReset();
  });

  describe('agreement scenario', () => {
    it('runs N workers concurrently and returns one adjudicated handoff', async () => {
      // All 3 workers return the same artifact {value: 42}. Adjudicator also returns {value: 42}.
      mockSpawnWaveAgent.mockImplementation(({ model }) => {
        if (model.includes('opus')) {
          // adjudicator
          return Promise.resolve(makeHandoff({ value: 42 }, { model, cost: 0.05 }));
        }
        return Promise.resolve(makeHandoff({ value: 42 }, { model, cost: 0.01 }));
      });

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['anthropic:claude-sonnet-4-6', 'google:gemini-2-5-pro', 'openai:gpt-5-codex'],
        adjudicatorModel: 'anthropic:claude-opus-4-7',
      });

      // 3 workers + 1 adjudicator = 4 total spawn calls
      expect(mockSpawnWaveAgent).toHaveBeenCalledTimes(4);
      expect(handoff.artifact).toEqual({ value: 42 });
      expect(handoff.consensus.agreement).toBe('unanimous');
      expect(handoff.consensus.degraded).toBe(false);
      expect(handoff.consensus.adjudicator_model).toBe('anthropic:claude-opus-4-7');
      expect(handoff.consensus.pool_results).toHaveLength(3);
      expect(handoff.consensus.pool_results.every((r) => r.status === 'success')).toBe(true);
    });

    it('dispatches workers concurrently — not sequentially', async () => {
      // Each worker blocks for 50ms; if sequential the total takes ≥ 150ms,
      // if concurrent it takes ~50ms. We assert concurrency via the call
      // order: all 3 worker calls registered before the first resolves.
      const callOrder: string[] = [];
      let workerCount = 0;
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
        if (model.includes('opus')) {
          callOrder.push(`adj-call:${model}`);
          return Promise.resolve(makeHandoff({ ok: true }, { model, cost: 0.05 }));
        }
        workerCount++;
        callOrder.push(`worker-call:${model}`);
        // Defer resolution to the next microtask so all workers register first.
        return new Promise((resolve) => {
          setTimeout(() => {
            callOrder.push(`worker-resolve:${model}`);
            resolve(makeHandoff({ ok: true }, { model, cost: 0.01 }));
          }, 10);
        });
      });

      await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2', 'm3'],
      });

      // All 3 worker-call entries must come before the first worker-resolve.
      expect(workerCount).toBe(3);
      const firstResolveIdx = callOrder.findIndex((e) => e.startsWith('worker-resolve:'));
      const workerCallIndices = callOrder
        .map((e, i) => (e.startsWith('worker-call:') ? i : -1))
        .filter((i) => i !== -1);
      expect(workerCallIndices.every((i) => i < firstResolveIdx)).toBe(true);
    });
  });

  describe('divergence scenario', () => {
    it('passes all worker artifacts + notes to adjudicator and returns the adjudicated result', async () => {
      const seenAdjudicatorMessages: string[] = [];
      mockSpawnWaveAgent.mockImplementation(({ model, userMessage }) => {
        if (model.includes('opus')) {
          seenAdjudicatorMessages.push(userMessage);
          return Promise.resolve(makeHandoff({ value: 'reconciled' }, { model, cost: 0.05 }));
        }
        const valueByModel: Record<string, string> = {
          m1: 'A',
          m2: 'B',
          m3: 'C',
        };
        return Promise.resolve(
          makeHandoff(
            { value: valueByModel[model] },
            {
              model,
              cost: 0.01,
              approach_notes: `notes for ${model}`,
            },
          ),
        );
      });

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2', 'm3'],
      });

      expect(handoff.artifact).toEqual({ value: 'reconciled' });
      expect(handoff.consensus.agreement).toBe('split');
      expect(handoff.consensus.degraded).toBe(false);
      expect(seenAdjudicatorMessages).toHaveLength(1);
      // Adjudicator prompt must include each worker's artifact + notes.
      const adjMsg = seenAdjudicatorMessages[0] ?? '';
      expect(adjMsg).toContain('"value": "A"');
      expect(adjMsg).toContain('"value": "B"');
      expect(adjMsg).toContain('"value": "C"');
      expect(adjMsg).toContain('notes for m1');
      expect(adjMsg).toContain('notes for m2');
      expect(adjMsg).toContain('notes for m3');
      // Adjudicator should see the original user message too.
      expect(adjMsg).toContain('do the thing');
    });
  });

  describe('one-fails scenario', () => {
    it('drops a worker after one retry, proceeds with N=2', async () => {
      const attemptsPerModel: Record<string, number> = {};
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
        attemptsPerModel[model] = (attemptsPerModel[model] ?? 0) + 1;
        if (model.includes('opus')) {
          return Promise.resolve(makeHandoff({ ok: true }, { model, cost: 0.05 }));
        }
        // m2 always throws — drop after retry.
        if (model === 'm2') {
          return Promise.reject(new Error(`${model} fail`));
        }
        return Promise.resolve(makeHandoff({ ok: true }, { model, cost: 0.01 }));
      });

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2', 'm3'],
      });

      // m2 must have been tried twice (initial + retry); others once.
      expect(attemptsPerModel.m1).toBe(1);
      expect(attemptsPerModel.m2).toBe(2);
      expect(attemptsPerModel.m3).toBe(1);

      expect(handoff.consensus.degraded).toBe(true);
      const m2Result = handoff.consensus.pool_results.find((r) => r.model === 'm2');
      expect(m2Result?.status).toBe('dropped');
      expect(m2Result?.error).toContain('m2 fail');

      const m1Result = handoff.consensus.pool_results.find((r) => r.model === 'm1');
      expect(m1Result?.status).toBe('success');
    });
  });

  describe('all-but-one-fails scenario', () => {
    it('throws when fewer than 2 valid pool members survive', async () => {
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
        if (model.includes('opus')) {
          return Promise.resolve(makeHandoff({ ok: true }, { model, cost: 0.05 }));
        }
        if (model === 'm1') {
          return Promise.resolve(makeHandoff({ ok: true }, { model, cost: 0.01 }));
        }
        return Promise.reject(new Error(`${model} fail`));
      });

      await expect(
        spawnConsensusWave({
          ...baseConfig,
          poolModels: ['m1', 'm2', 'm3'],
        }),
      ).rejects.toThrow(/insufficient.*pool|surviving|consensus/i);
    });
  });

  describe('cost summation', () => {
    it('sums worker + adjudicator costs onto handoff.cost', async () => {
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
        if (model.includes('opus')) {
          return Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: 0.07 }));
        }
        const costByModel: Record<string, number> = { m1: 0.02, m2: 0.03, m3: 0.04 };
        return Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: costByModel[model] ?? 0 }));
      });

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2', 'm3'],
      });

      // 0.02 + 0.03 + 0.04 + 0.07 = 0.16
      expect(handoff.cost).toBeCloseTo(0.16, 5);
    });

    it('includes failed-attempt costs in the total when a worker is dropped', async () => {
      // m2's failed attempts cost 0 (because it threw — no handoff produced)
      // but m1 + m3 + adjudicator costs must still sum on the handoff.
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) => {
        if (model.includes('opus')) {
          return Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: 0.1 }));
        }
        if (model === 'm2') return Promise.reject(new Error('boom'));
        return Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: 0.01 }));
      });

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2', 'm3'],
      });

      // m1 + m3 + adjudicator = 0.01 + 0.01 + 0.1 = 0.12
      expect(handoff.cost).toBeCloseTo(0.12, 5);
    });
  });

  describe('adjudicator forced to large', () => {
    it('defaults adjudicator to the large tier even when pool uses small models', async () => {
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) =>
        Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: 0.001 })),
      );

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['anthropic:claude-haiku-4-5', 'google:gemini-2-5-flash'],
      });

      // adjudicator_model must resolve to a large-tier model, not haiku/flash.
      // The exact model id is environment-dependent (depends on DEFAULT_MODELS.large),
      // but it must NOT be one of the pool members.
      expect(handoff.consensus.adjudicator_model).not.toBe('anthropic:claude-haiku-4-5');
      expect(handoff.consensus.adjudicator_model).not.toBe('google:gemini-2-5-flash');
      // The 'large' tier resolves to anthropic:claude-opus-4-7 in the default config.
      expect(handoff.consensus.adjudicator_model).toMatch(/opus|large/i);
    });

    it('honors explicit adjudicatorModel override', async () => {
      mockSpawnWaveAgent.mockImplementation(({ model }: { model: string }) =>
        Promise.resolve(makeHandoff({ v: 'ok' }, { model, cost: 0.001 })),
      );

      const handoff = await spawnConsensusWave({
        ...baseConfig,
        poolModels: ['m1', 'm2'],
        adjudicatorModel: 'custom:adjudicator-model',
      });

      expect(handoff.consensus.adjudicator_model).toBe('custom:adjudicator-model');
    });
  });

  describe('input validation', () => {
    it('throws when poolModels has fewer than 2 entries', async () => {
      await expect(
        spawnConsensusWave({
          ...baseConfig,
          poolModels: ['m1'],
        }),
      ).rejects.toThrow(/at least 2|pool/i);
    });
  });
});
