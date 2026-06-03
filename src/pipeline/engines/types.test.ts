// Tests for the WaveEngine interface contract (issue #353).
// These verify the interface shape is implementable and that a trivial test
// engine round-trips its inputs/outputs through the declared types.

import { describe, expect, it } from 'vitest';
import type { WaveHandoff } from '../../types/handoffs.js';
import type { ReviewFinding } from '../../types/index.js';
import type {
  EngineContext,
  EngineResult,
  ReviewEngineInput,
  ShipEngine,
  ShipEngineInput,
  ShipEngineResult,
  WaveEngine,
} from './types.js';

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

describe('ReviewEngineInput (issue #356)', () => {
  it('accepts the minimal required fields (issue + waveResults)', () => {
    const input: ReviewEngineInput = {
      issue: {
        number: 1,
        title: 't',
        body: 'b',
        labels: [],
        url: 'https://github.com/owner/repo/issues/1',
      },
      waveResults: {},
    };
    expect(input.issue.number).toBe(1);
    expect(input.waveResults).toBeDefined();
  });

  it('allows the engine-only overrides (maxIterations, prContext, baselines)', () => {
    const input: ReviewEngineInput = {
      issue: {
        number: 1,
        title: 't',
        body: 'b',
        labels: [],
        url: 'https://github.com/owner/repo/issues/1',
      },
      waveResults: {},
      maxIterations: 3,
      prContext: 'pr-ctx',
      reviewFeedbackContext: 'past feedback',
      baselineFailures: ['t1'],
      currentFailures: ['t2'],
      playwright: { enabled: false },
    };
    expect(input.maxIterations).toBe(3);
    expect(input.baselineFailures).toEqual(['t1']);
  });
});

describe('ShipEngine (issue #356)', () => {
  it('declares name === "ship"', () => {
    const stub: ShipEngine = {
      name: 'ship',
      async run() {
        return { status: 'no_changes' };
      },
    };
    expect(stub.name).toBe('ship');
  });

  it('ShipEngineInput accepts conflict + retry hooks', () => {
    const known: ReviewFinding[] = [
      { category: 'mechanical_fix', file: 'src/a.ts', description: 'x', severity: 'medium' },
    ];
    const input: ShipEngineInput = {
      issue: {
        number: 1,
        title: 't',
        body: 'b',
        labels: [],
        url: 'https://github.com/owner/repo/issues/1',
      },
      branch: 'fix/1',
      specFiles: ['src/a.ts'],
      openPRs: ['#42 some other pr'],
      mergeDependencies: [10],
      reviewKnownIssues: known,
    };
    expect(input.branch).toBe('fix/1');
    expect(input.specFiles).toEqual(['src/a.ts']);
    expect(input.openPRs).toEqual(['#42 some other pr']);
    expect(input.reviewKnownIssues).toHaveLength(1);
  });

  it('ShipEngineResult is a discriminated union (shipped | no_changes | failed)', () => {
    const shipped: ShipEngineResult = {
      status: 'shipped',
      prUrl: 'https://github.com/owner/repo/pull/1',
      commitMessage: 'fix: ...',
      filesStaged: ['src/a.ts'],
    };
    const none: ShipEngineResult = { status: 'no_changes' };
    const failed: ShipEngineResult = {
      status: 'failed',
      reason: 'secrets',
      error: 'AKIA...',
    };
    expect(shipped.status).toBe('shipped');
    expect(none.status).toBe('no_changes');
    expect(failed.status).toBe('failed');
    // Narrowing works:
    if (shipped.status === 'shipped') {
      expect(shipped.prUrl).toBeDefined();
    }
    if (failed.status === 'failed') {
      expect(failed.reason).toBe('secrets');
    }
  });
});
