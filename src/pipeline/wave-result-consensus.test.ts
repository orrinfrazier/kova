// Tests for #262: WaveResult.consensus propagation from ConsensusWaveHandoff
// into pipeline WaveResult.
//
// Two seams cover the pipeline today:
//   - `handoffToResult` in fix.ts (used by orchestrator-level waves: assess, spec)
//   - `toWaveResult` in loops.ts (used by TI/Q/R loops)
//
// Both must copy the optional `consensus` metadata onto WaveResult when the
// underlying handoff carries it; both must keep emitting WaveResult without
// a consensus field for single-model handoffs.

import { describe, expect, it } from 'vitest';
import type { ConsensusMetadata } from '../ai/parallel-executor.js';
import type { WaveHandoff } from '../types/handoffs.js';
import { handoffToResult } from './fix.js';
import { toWaveResult as _toWaveResult } from './loops.js';

const exampleConsensus: ConsensusMetadata = {
  pool_results: [
    { model: 'm1', status: 'success', cost: 0.01, confidence: 'high', approach_notes: '' },
    { model: 'm2', status: 'success', cost: 0.02, confidence: 'medium', approach_notes: '' },
  ],
  adjudicator_model: 'anthropic:claude-opus-4-7',
  degraded: false,
  agreement: 'majority',
};

function makeConsensusHandoff(): WaveHandoff & { consensus: ConsensusMetadata } {
  return {
    wave: 'review',
    timestamp: '2026-06-03T00:00:00.000Z',
    model: 'anthropic:claude-opus-4-7',
    cost: 0.15,
    turns: 1,
    confidence: 'high',
    artifact: { verdict: 'NEEDS_FIXES' },
    approach_notes: 'reconciled by adjudicator',
    parsed: true,
    consensus: exampleConsensus,
  };
}

function makeSingleModelHandoff(): WaveHandoff {
  return {
    wave: 'spec',
    timestamp: '2026-06-03T00:00:00.000Z',
    model: 'anthropic:claude-sonnet-4-6',
    cost: 0.04,
    turns: 1,
    confidence: 'high',
    artifact: { pieces: [] },
    approach_notes: '',
    parsed: true,
  };
}

describe('handoffToResult — consensus propagation (#262)', () => {
  it('copies the consensus metadata onto WaveResult when the handoff carries it', () => {
    const result = handoffToResult(makeConsensusHandoff());
    expect(result.consensus).toBeDefined();
    expect(result.consensus?.adjudicator).toBe('anthropic:claude-opus-4-7');
    expect(result.consensus?.agreement).toBe('majority');
    expect(result.consensus?.rejected_count).toBe(0);
    expect(result.consensus?.degraded).toBe(false);
    expect(result.consensus?.pool).toEqual(['m1', 'm2']);
  });

  it('omits the consensus field for single-model handoffs', () => {
    const result = handoffToResult(makeSingleModelHandoff());
    expect(result.consensus).toBeUndefined();
    // back-compat: every other field present today must still populate
    expect(result.model).toBe('anthropic:claude-sonnet-4-6');
    expect(result.cost).toBe(0.04);
  });
});

describe('toWaveResult (loops) — consensus propagation (#262)', () => {
  // toWaveResult is a closure over a dispatch result, not a WaveHandoff.
  // For #262 the contract is symmetric: when the dispatch path threads
  // consensus metadata in, the WaveResult must carry it. Test via the
  // exported wrapper if one exists; otherwise validate the type surface.
  it('preserves consensus metadata when the dispatch result carries it', () => {
    const result = _toWaveResult('review', {
      result: 'raw',
      success: true,
      duration: 100,
      cost: 0.15,
      turns: 1,
      model: 'anthropic:claude-opus-4-7',
      provider: 'anthropic',
      consensus: {
        pool: ['m1', 'm2'],
        adjudicator: 'anthropic:claude-opus-4-7',
        agreement: 'split',
        rejected_count: 2,
        degraded: false,
      },
    });
    expect(result.consensus?.agreement).toBe('split');
    expect(result.consensus?.rejected_count).toBe(2);
  });

  it('omits consensus when the dispatch result lacks it', () => {
    const result = _toWaveResult('spec', {
      result: 'raw',
      success: true,
      duration: 50,
      cost: 0.02,
      turns: 1,
      model: 'anthropic:claude-sonnet-4-6',
      provider: 'anthropic',
    });
    expect(result.consensus).toBeUndefined();
  });
});
