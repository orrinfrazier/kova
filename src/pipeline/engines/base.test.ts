// Tests for the engine executor wrapper and helpers (issue #353).

import { describe, expect, it, vi } from 'vitest';
import type { WaveHandoff } from '../../types/handoffs.js';
import { runWaveEngine } from './base.js';
import type { EngineContext, WaveEngine } from './types.js';

const stubConfig = { model: {}, isolation: 'worktree' } as unknown as EngineContext['config'];

function makeCtx(): EngineContext {
  return {
    workDir: '/tmp/work',
    repoPath: '/tmp/repo',
    repoName: 'owner/repo',
    config: stubConfig,
  };
}

interface DummyInput {
  n: number;
}
interface DummyOutput {
  doubled: number;
}

function makeEngine(): WaveEngine<DummyInput, DummyOutput> {
  return {
    name: 'impl',
    async run(_ctx, input) {
      const handoff: WaveHandoff<DummyOutput> = {
        wave: 'impl',
        timestamp: new Date().toISOString(),
        model: 'm',
        cost: 0,
        turns: 0,
        confidence: 'medium',
        artifact: { doubled: input.n * 2 },
        approach_notes: '',
      };
      return { handoff, promptHash: 'h' };
    },
  };
}

describe('runWaveEngine', () => {
  it('invokes engine.run with the provided context + input', async () => {
    const engine = makeEngine();
    const spy = vi.spyOn(engine, 'run');
    const ctx = makeCtx();
    const result = await runWaveEngine(engine, ctx, { n: 21 });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(ctx, { n: 21 });
    expect(result.handoff.artifact.doubled).toBe(42);
    expect(result.promptHash).toBe('h');
  });

  it('propagates errors thrown from engine.run', async () => {
    const failing: WaveEngine<DummyInput, DummyOutput> = {
      name: 'impl',
      async run() {
        throw new Error('boom');
      },
    };
    await expect(runWaveEngine(failing, makeCtx(), { n: 1 })).rejects.toThrow('boom');
  });

  it('preserves wave name from the engine', async () => {
    const engine: WaveEngine<undefined, undefined> = {
      name: 'review',
      async run() {
        return {
          handoff: {
            wave: 'review',
            timestamp: new Date().toISOString(),
            model: 'm',
            cost: 0,
            turns: 0,
            confidence: 'high',
            artifact: undefined,
            approach_notes: '',
          },
          promptHash: 'h',
        };
      },
    };
    const result = await runWaveEngine(engine, makeCtx(), undefined);
    expect(result.handoff.wave).toBe('review');
  });
});
