import { describe, expect, it } from 'vitest';
import type { FixState, WaveName } from '../types/index.js';
import { applyScopeToState, type PipelineScope, WAVES_SKIPPED_BY_SCOPE } from './pipeline-scope.js';

function makeState(): FixState {
  return {
    issue: { number: 1, title: 't', body: 'b', labels: [], url: 'u' },
    repo: 'r',
    repoPath: '/tmp',
    startedAt: 'now',
    completedWaves: [],
    waveResults: {},
    status: 'running',
  };
}

describe('applyScopeToState', () => {
  it('records the scope + reason on FixState', () => {
    const state = makeState();
    applyScopeToState(state, 'TEST_ONLY', 'because reason');
    expect(state.pipelineScope).toBe<PipelineScope>('TEST_ONLY');
    expect(state.pipelineScopeReason).toBe('because reason');
  });

  it('marks every wave dropped by the scope as completed with a synthetic skip result', () => {
    const state = makeState();
    applyScopeToState(state, 'TEST_ONLY', 'r');
    for (const wave of WAVES_SKIPPED_BY_SCOPE.TEST_ONLY) {
      expect(state.completedWaves).toContain(wave);
      const result = state.waveResults[wave];
      expect(result).toBeDefined();
      expect(result?.success).toBe(true);
      expect((result?.artifact as { skipped?: boolean }).skipped).toBe(true);
      expect((result?.artifact as { reason?: string }).reason).toBe('pipeline-scope');
    }
  });

  it('FULL scope leaves completedWaves untouched', () => {
    const state = makeState();
    applyScopeToState(state, 'FULL', 'r');
    expect(state.completedWaves).toEqual([]);
    expect(state.waveResults).toEqual({});
  });

  it('REVIEW_ONLY skips assess/spec/test/impl/quality but leaves review/ship for execution', () => {
    const state = makeState();
    applyScopeToState(state, 'REVIEW_ONLY', 'r');
    const expected: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality'];
    for (const wave of expected) {
      expect(state.completedWaves).toContain(wave);
    }
    expect(state.completedWaves).not.toContain('review');
    expect(state.completedWaves).not.toContain('ship');
  });

  it('does not double-add a wave already marked complete', () => {
    const state = makeState();
    state.completedWaves.push('test');
    applyScopeToState(state, 'TEST_ONLY', 'r');
    const testEntries = state.completedWaves.filter((w) => w === 'test');
    expect(testEntries).toHaveLength(1);
  });
});
