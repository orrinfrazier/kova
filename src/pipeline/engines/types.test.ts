// Tests for the WaveEngine interface contract (issue #353).
// These verify the interface shape is implementable and that a trivial test
// engine round-trips its inputs/outputs through the declared types.

import { describe, expect, it } from 'vitest';
import type { WaveHandoff } from '../../types/handoffs.js';
import type { EngineContext, EngineResult, WaveEngine } from './types.js';

// A minimal RepoConfig stub — only the fields the engine surface reads.
// Cast through unknown to keep the test self-contained without dragging in
// the full RepoConfig zod parser.
const stubConfig = { model: {}, isolation: 'worktree' } as unknown as EngineContext['config'];

function makeCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    workDir: '/tmp/work',
    repoPath: '/tmp/repo',
    repoName: 'owner/repo',
    config: stubConfig,
    ...overrides,
  };
}

describe('WaveEngine interface', () => {
  it('lets a trivial engine implement the contract', async () => {
    interface EchoInput {
      message: string;
    }
    interface EchoOutput {
      echoed: string;
    }

    const echoEngine: WaveEngine<EchoInput, EchoOutput> = {
      name: 'assess',
      async run(_ctx, input) {
        const handoff: WaveHandoff<EchoOutput> = {
          wave: 'assess',
          timestamp: new Date().toISOString(),
          model: 'test-model',
          cost: 0,
          turns: 0,
          confidence: 'high',
          artifact: { echoed: input.message },
          approach_notes: '',
        };
        return { handoff, promptHash: 'hash-deadbeef' };
      },
    };

    const result: EngineResult<EchoOutput> = await echoEngine.run(makeCtx(), {
      message: 'hello',
    });

    expect(result.handoff.wave).toBe('assess');
    expect(result.handoff.artifact.echoed).toBe('hello');
    expect(result.promptHash).toBe('hash-deadbeef');
  });

  it('preserves the FixAIWaveName discriminator on engine name', () => {
    // Compile-time assertion: name must be one of the 6 fix AI waves.
    // (assess, spec, test, impl, quality, review — NOT 'ship' or 'brainstorm')
    const validNames = ['assess', 'spec', 'test', 'impl', 'quality', 'review'] as const;
    type EngineName = WaveEngine<unknown, unknown>['name'];
    // Each valid name should be assignable to EngineName.
    for (const n of validNames) {
      const assigned: EngineName = n;
      expect(assigned).toBe(n);
    }
  });

  it('carries every field spawnWave needs in EngineContext', () => {
    // Required fields:
    const ctx = makeCtx();
    expect(ctx.workDir).toBeTypeOf('string');
    expect(ctx.repoPath).toBeTypeOf('string');
    expect(ctx.repoName).toBeTypeOf('string');
    expect(ctx.config).toBeDefined();
  });

  it('allows optional context fields to be omitted', async () => {
    // Optional fields should not be required by the type system.
    const minimalEngine: WaveEngine<undefined, undefined> = {
      name: 'spec',
      async run() {
        return {
          handoff: {
            wave: 'spec',
            timestamp: new Date().toISOString(),
            model: 'test-model',
            cost: 0,
            turns: 0,
            confidence: 'low',
            artifact: undefined,
            approach_notes: '',
          },
          promptHash: 'hash',
        };
      },
    };
    const result = await minimalEngine.run(makeCtx(), undefined);
    expect(result.handoff.wave).toBe('spec');
  });

  it('supports optional context fields when provided', () => {
    const ctx = makeCtx({
      mcpHandles: new Map(),
      promptsDir: '/tmp/prompts',
      abTestVariant: 'variant-a',
      cacheContext: { repo: 'owner/repo', issue: 42 },
    });
    expect(ctx.mcpHandles).toBeInstanceOf(Map);
    expect(ctx.promptsDir).toBe('/tmp/prompts');
    expect(ctx.abTestVariant).toBe('variant-a');
    expect(ctx.cacheContext?.issue).toBe(42);
  });
});
