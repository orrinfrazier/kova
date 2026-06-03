// Tests for result projection helpers (issue #435 — ADR 004 step 1).
//
// Pure mapping logic — covers the three round-trips fix.ts relied on inline:
//   waveProvider — single-model + consensus-pool variants
//   handoffToResult — single-model + consensus telemetry propagation (#262)
//   waveResultToHandoff — parsed inference (#308)

import { describe, expect, it } from 'vitest';
import type { ConsensusMetadata } from '../ai/parallel-executor.js';
import type { RepoConfig, WaveHandoff, WaveResult } from '../types/index.js';
import { handoffToResult, waveProvider, waveResultToHandoff } from './result.js';

function makeRepoConfig(overrides: Partial<RepoConfig['model']> = {}): RepoConfig {
  return {
    path: '/tmp/fake-repo',
    model: {
      assess: 'medium',
      spec: 'medium',
      test: 'medium',
      impl: 'medium',
      quality: 'medium',
      review: 'medium',
      brainstorm: 'medium',
      ...overrides,
    },
  } as unknown as RepoConfig;
}

describe('waveProvider', () => {
  it('returns the provider for a bare tier string ("medium")', () => {
    const config = makeRepoConfig({ assess: 'medium' });
    const provider = waveProvider(config, 'assess');
    expect(typeof provider).toBe('string');
    expect(provider.length).toBeGreaterThan(0);
  });

  it('returns the provider for an explicit provider object', () => {
    const config = makeRepoConfig({
      spec: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });
    expect(waveProvider(config, 'spec')).toBe('anthropic');
  });

  it('returns the first pool member provider for a consensus pool', () => {
    const config = makeRepoConfig({
      review: {
        pool: [
          { provider: 'anthropic', model: 'claude-opus-4-6' },
          { provider: 'google', model: 'gemini-2.5-pro' },
        ],
        adjudicator: { provider: 'anthropic', model: 'claude-opus-4-6' },
      },
    });
    expect(waveProvider(config, 'review')).toBe('anthropic');
  });

  it('handles string pool members by resolving them', () => {
    const config = makeRepoConfig({
      review: {
        pool: ['medium', 'large'],
        adjudicator: 'large',
      },
    });
    const provider = waveProvider(config, 'review');
    expect(typeof provider).toBe('string');
    expect(provider.length).toBeGreaterThan(0);
  });
});

describe('handoffToResult', () => {
  function makeHandoff(extra: Partial<WaveHandoff> = {}): WaveHandoff {
    return {
      wave: 'assess',
      timestamp: new Date().toISOString(),
      model: 'claude-opus-4-6',
      cost: 0.42,
      turns: 7,
      confidence: 'high',
      parsed: true,
      artifact: { grade: 'B' },
      approach_notes: '',
      ...extra,
    };
  }

  it('maps the basic single-model fields through', () => {
    const handoff = makeHandoff();
    const result = handoffToResult(handoff, 'anthropic', 'hash-abc');
    expect(result.wave).toBe('assess');
    expect(result.success).toBe(true);
    expect(result.artifact).toEqual({ grade: 'B' });
    expect(result.cost).toBe(0.42);
    expect(result.turns).toBe(7);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.provider).toBe('anthropic');
    expect(result.promptHash).toBe('hash-abc');
  });

  it('leaves consensus undefined for single-model handoffs', () => {
    const result = handoffToResult(makeHandoff());
    expect(result.consensus).toBeUndefined();
  });

  it('propagates consensus metadata when present (#262)', () => {
    const consensus: ConsensusMetadata = {
      pool_results: [
        { model: 'claude-opus-4-6', artifact: {}, cost: 0.1, turns: 1, provider: 'anthropic' },
        { model: 'gemini-2.5-pro', artifact: {}, cost: 0.05, turns: 1, provider: 'google' },
      ],
      adjudicator_model: 'claude-opus-4-6',
      agreement: 'majority',
      degraded: false,
    } as unknown as ConsensusMetadata;

    const handoff = { ...makeHandoff(), consensus } as WaveHandoff & { consensus: ConsensusMetadata };
    const result = handoffToResult(handoff);
    expect(result.consensus).toBeDefined();
    expect(result.consensus?.pool).toEqual(['claude-opus-4-6', 'gemini-2.5-pro']);
    expect(result.consensus?.adjudicator).toBe('claude-opus-4-6');
    expect(result.consensus?.agreement).toBe('majority');
    expect(result.consensus?.rejected_count).toBe(0);
    expect(result.consensus?.degraded).toBe(false);
  });

  it('propagates fallback_used and local_attempt_cost', () => {
    const handoff = makeHandoff({ fallback_used: true, local_attempt_cost: 0.0 });
    const result = handoffToResult(handoff);
    expect(result.fallback_used).toBe(true);
    expect(result.local_attempt_cost).toBe(0.0);
  });

  it('normalizes fallback_used=false to undefined', () => {
    const handoff = makeHandoff({ fallback_used: false });
    const result = handoffToResult(handoff);
    expect(result.fallback_used).toBeUndefined();
  });
});

describe('waveResultToHandoff', () => {
  function makeResult(extra: Partial<WaveResult> = {}): WaveResult {
    return {
      wave: 'spec',
      success: true,
      artifact: { pieces: [] },
      duration: 0,
      cost: 0,
      turns: 0,
      model: 'claude-opus-4-6',
      ...extra,
    };
  }

  it('infers parsed=true for object artifacts', () => {
    const handoff = waveResultToHandoff(makeResult());
    expect(handoff.parsed).toBe(true);
  });

  it('infers parsed=false for string artifacts (#308)', () => {
    const handoff = waveResultToHandoff(makeResult({ artifact: 'raw model output' }));
    expect(handoff.parsed).toBe(false);
  });

  it('infers parsed=false for null artifacts (#308)', () => {
    const handoff = waveResultToHandoff(makeResult({ artifact: null as unknown as Record<string, unknown> }));
    expect(handoff.parsed).toBe(false);
  });

  it("defaults model to 'unknown' when missing", () => {
    const handoff = waveResultToHandoff(makeResult({ model: undefined }));
    expect(handoff.model).toBe('unknown');
  });

  it('emits a fresh timestamp in ISO format', () => {
    const handoff = waveResultToHandoff(makeResult());
    expect(handoff.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sets confidence to 'medium' by default", () => {
    const handoff = waveResultToHandoff(makeResult());
    expect(handoff.confidence).toBe('medium');
  });
});
