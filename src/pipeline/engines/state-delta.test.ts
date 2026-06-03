// Tests for the EngineStateDelta contract + applyEngineStateDelta helper
// (issue #432). These pin the loop's single FixState application point so
// engines can never silently mutate state through shared mutable references.

import { describe, expect, it } from 'vitest';
import type { FixState, Issue } from '../../types/index.js';
import { buildConfigDelta as buildAssessConfigDelta } from './assess.js';
import { buildReviewStateDelta } from './review.js';
import { buildFailedPiece, buildTIStateDelta } from './ti.js';
import { applyEngineStateDelta } from './types.js';

const stubIssue: Issue = {
  number: 1,
  title: 't',
  body: 'b',
  labels: [],
  url: 'https://github.com/owner/repo/issues/1',
};

function baseState(overrides: Partial<FixState> = {}): FixState {
  return {
    issue: stubIssue,
    repo: 'owner/repo',
    repoPath: '/tmp/repo',
    startedAt: new Date().toISOString(),
    completedWaves: [],
    waveResults: {},
    status: 'running',
    ...overrides,
  };
}

describe('applyEngineStateDelta', () => {
  it('returns a NEW object — never mutates the input', () => {
    const state = baseState();
    const next = applyEngineStateDelta(state, { diagnosis: 'STUCK' });
    expect(next).not.toBe(state);
    expect(state.diagnosis).toBeUndefined(); // input untouched
    expect(next.diagnosis).toBe('STUCK');
  });

  it('returns the same reference when delta is undefined (no-op)', () => {
    const state = baseState();
    const next = applyEngineStateDelta(state, undefined);
    expect(next).toBe(state);
  });

  it('omitted fields leave the prior state slot untouched', () => {
    const state = baseState({ diagnosis: 'APPROACH_WRONG', retryAttempts: 2 });
    const next = applyEngineStateDelta(state, { thrashingSignal: 'SAME_FILES' });
    expect(next.diagnosis).toBe('APPROACH_WRONG');
    expect(next.retryAttempts).toBe(2);
    expect(next.thrashingSignal).toBe('SAME_FILES');
  });

  it('explicit undefined IS treated as a write (clears the slot)', () => {
    // The doc says "use omission instead of passing undefined". We honor
    // explicit-undefined to support the TIEngine case where a result with
    // <2 attempts surfaces `thrashingSignal: undefined`.
    const state = baseState({ thrashingSignal: 'SAME_FILES' });
    const next = applyEngineStateDelta(state, { thrashingSignal: undefined });
    expect(next.thrashingSignal).toBeUndefined();
  });

  it('REPLACE semantics for failedPieces — overwrites prior list', () => {
    const state = baseState({
      failedPieces: [{ pieceName: 'old', diagnosis: { category: 'STUCK', theory: 'x', tests_still_failing: [] } }],
    });
    const next = applyEngineStateDelta(state, {
      failedPieces: [
        { pieceName: 'new', diagnosis: { category: 'APPROACH_WRONG', theory: 'y', tests_still_failing: [] } },
      ],
    });
    expect(next.failedPieces).toHaveLength(1);
    expect(next.failedPieces?.[0]?.pieceName).toBe('new');
  });

  it('REPLACE semantics for reviewKnownIssues — overwrites prior list', () => {
    const state = baseState({
      reviewKnownIssues: [{ category: 'mechanical_fix', file: 'a.ts', description: 'old', severity: 'low' }],
    });
    const next = applyEngineStateDelta(state, {
      reviewKnownIssues: [{ category: 'needs_new_tests', file: 'b.ts', description: 'new', severity: 'high' }],
    });
    expect(next.reviewKnownIssues?.[0]?.description).toBe('new');
  });

  it('applies mergeDependencies', () => {
    const state = baseState();
    const next = applyEngineStateDelta(state, { mergeDependencies: [42, 99] });
    expect(next.mergeDependencies).toEqual([42, 99]);
  });

  it('does NOT touch completedWaves (orchestrator-owned)', () => {
    const state = baseState({ completedWaves: ['assess', 'spec'] });
    // Even if the delta type permits it (it does NOT in the type signature),
    // the helper must never write `completedWaves`. We verify by constructing
    // a fully-loaded delta with every other slot — completedWaves stays.
    const next = applyEngineStateDelta(state, {
      diagnosis: 'STUCK',
      retryAttempts: 3,
      thrashingSignal: 'NORMAL',
      failedPieces: [],
      reviewKnownIssues: [],
      mergeDependencies: [],
    });
    expect(next.completedWaves).toEqual(['assess', 'spec']);
  });

  it('composes left-to-right when applied multiple times (engine pipeline order)', () => {
    let state = baseState();
    state = applyEngineStateDelta(state, { diagnosis: 'SPEC_WRONG' });
    state = applyEngineStateDelta(state, { diagnosis: 'APPROACH_WRONG', retryAttempts: 3 });
    expect(state.diagnosis).toBe('APPROACH_WRONG');
    expect(state.retryAttempts).toBe(3);
  });
});

describe('TIEngine deltas (issue #432)', () => {
  it('buildTIStateDelta maps loop result to the right FixState slots', () => {
    const delta = buildTIStateDelta({
      testWaveResult: { wave: 'test' } as never,
      implWaveResult: { wave: 'impl' } as never,
      testsPassing: false,
      totalCost: 1,
      attempts: 3,
      pieceResults: [],
      modifiedFilesPerAttempt: [['a.ts'], ['a.ts'], ['a.ts']],
      diagnosis: 'APPROACH_WRONG',
    } as never);
    expect(delta.diagnosis).toBe('APPROACH_WRONG');
    expect(delta.retryAttempts).toBe(3);
    // detectThrashing on 3 attempts of [['a.ts']] should classify as SAME_FILES
    expect(delta.thrashingSignal).toBe('SAME_FILES');
  });

  it('buildTIStateDelta sets thrashingSignal undefined when <2 attempts recorded', () => {
    const delta = buildTIStateDelta({
      testWaveResult: { wave: 'test' } as never,
      implWaveResult: { wave: 'impl' } as never,
      testsPassing: true,
      totalCost: 1,
      attempts: 1,
      pieceResults: [],
      modifiedFilesPerAttempt: [['a.ts']],
    } as never);
    expect(delta.thrashingSignal).toBeUndefined();
  });

  it('buildFailedPiece returns undefined when tests pass (no append)', () => {
    const piece = buildFailedPiece({
      testWaveResult: { wave: 'test' } as never,
      implWaveResult: { wave: 'impl' } as never,
      testsPassing: true,
      totalCost: 1,
      attempts: 1,
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    } as never);
    expect(piece).toBeUndefined();
  });

  it('buildFailedPiece returns piece with diagnosis category when tests fail', () => {
    const piece = buildFailedPiece({
      testWaveResult: { wave: 'test' } as never,
      implWaveResult: { wave: 'impl' } as never,
      testsPassing: false,
      totalCost: 1,
      attempts: 3,
      pieceResults: [],
      modifiedFilesPerAttempt: [],
      diagnosis: 'MISSING_CONTEXT',
    } as never);
    expect(piece).toBeDefined();
    expect(piece?.diagnosis.category).toBe('MISSING_CONTEXT');
    expect(piece?.pieceName).toBe('impl');
  });

  it('buildFailedPiece defaults to STUCK when no diagnosis present', () => {
    const piece = buildFailedPiece({
      testWaveResult: { wave: 'test' } as never,
      implWaveResult: { wave: 'impl' } as never,
      testsPassing: false,
      totalCost: 1,
      attempts: 3,
      pieceResults: [],
      modifiedFilesPerAttempt: [],
    } as never);
    expect(piece?.diagnosis.category).toBe('STUCK');
  });
});

describe('ReviewEngine deltas (issue #432)', () => {
  it('returns undefined when knownIssues is empty (slot untouched)', () => {
    const delta = buildReviewStateDelta({
      knownIssues: [],
      reviewWaveResult: { wave: 'review' } as never,
      iterations: 1,
      totalCost: 0,
    } as never);
    expect(delta).toBeUndefined();
  });

  it('maps knownIssues to FixState ReviewKnownIssue shape (replace semantics)', () => {
    const delta = buildReviewStateDelta({
      knownIssues: [
        { category: 'mechanical_fix', file: 'a.ts', description: 'd1', severity: 'low' },
        { category: 'needs_new_tests', file: 'b.ts', description: 'd2', severity: 'high' },
      ],
      reviewWaveResult: { wave: 'review' } as never,
      iterations: 2,
      totalCost: 1,
    } as never);
    expect(delta?.reviewKnownIssues).toHaveLength(2);
    expect(delta?.reviewKnownIssues?.[0]?.severity).toBe('low');
    expect(delta?.reviewKnownIssues?.[1]?.description).toBe('d2');
  });
});

describe('AssessEngine configDelta (issue #432)', () => {
  const stubConfig = {
    model: { test: 'medium', impl: 'medium', quality: 'medium', assess: 'large', spec: 'large', review: 'large' },
    isolation: 'worktree',
    rules: { coverage: 80 },
  } as never;

  it('explicit mode wins — no auto-select even when artifact would auto-pick', () => {
    const artifact = { grade: 'A' as const, surface_area: { files: ['a.ts'] }, should_proceed: true, reasoning: '' };
    const delta = buildAssessConfigDelta(stubConfig, artifact as never, 'standard');
    expect(delta?.resolvedMode).toBe('standard');
    expect(delta?.extraImplAttempts).toBe(0);
  });

  it('auto-selects from grade + file count when no explicit mode', () => {
    // Grade A + 1 file → simple per autoSelectMode rules
    const artifact = { grade: 'A' as const, surface_area: { files: ['a.ts'] }, should_proceed: true, reasoning: '' };
    const delta = buildAssessConfigDelta(stubConfig, artifact as never, undefined);
    expect(delta?.resolvedMode).toBe('simple');
  });

  it('Grade B → economy (auto)', () => {
    const artifact = {
      grade: 'B' as const,
      surface_area: { files: ['a.ts', 'b.ts', 'c.ts'] },
      should_proceed: true,
      reasoning: '',
    };
    const delta = buildAssessConfigDelta(stubConfig, artifact as never, undefined);
    expect(delta?.resolvedMode).toBe('economy');
    // economy forces execution waves to 'small'
    expect(delta?.config?.model.test).toBe('small');
    expect(delta?.config?.model.impl).toBe('small');
    expect(delta?.config?.model.quality).toBe('small');
    // reasoning waves are NOT downgraded
    expect(delta?.config?.model.assess).toBe('large');
    expect(delta?.config?.model.spec).toBe('large');
    expect(delta?.config?.model.review).toBe('large');
  });

  it('falls back to standard when artifact is missing and no explicit mode', () => {
    const delta = buildAssessConfigDelta(stubConfig, undefined, undefined);
    expect(delta?.resolvedMode).toBe('standard');
    // standard leaves configured tiers unchanged
    expect(delta?.config?.model.test).toBe('medium');
  });

  it('explore mode wins over auto when explicit', () => {
    const artifact = { grade: 'A' as const, surface_area: { files: ['a.ts'] }, should_proceed: true, reasoning: '' };
    const delta = buildAssessConfigDelta(stubConfig, artifact as never, 'explore');
    expect(delta?.resolvedMode).toBe('explore');
    // explore grants +1 extra impl attempt
    expect(delta?.extraImplAttempts).toBe(1);
    // explore raises T/I to 'large'
    expect(delta?.config?.model.test).toBe('large');
    expect(delta?.config?.model.impl).toBe('large');
  });

  it('returns a NEW config object — never mutates input config', () => {
    const artifact = {
      grade: 'B' as const,
      surface_area: { files: ['a.ts', 'b.ts', 'c.ts'] },
      should_proceed: true,
      reasoning: '',
    };
    const delta = buildAssessConfigDelta(stubConfig, artifact as never, undefined);
    expect(delta?.config).not.toBe(stubConfig);
    // stubConfig.model.test is still its original 'medium' value
    expect((stubConfig as { model: { test: string } }).model.test).toBe('medium');
  });
});
