import { describe, expect, it } from 'vitest';
import { makeConfig, makeFixState, makeIssue } from './factories.js';

describe('makeIssue', () => {
  it('creates issue with given number', () => {
    const issue = makeIssue(42);
    expect(issue.number).toBe(42);
    expect(issue.title).toBe('Test issue 42');
    expect(issue.url).toContain('/42');
  });

  it('applies overrides', () => {
    const issue = makeIssue(1, { title: 'Custom title', labels: ['feature'] });
    expect(issue.title).toBe('Custom title');
    expect(issue.labels).toEqual(['feature']);
    expect(issue.number).toBe(1); // non-overridden stays
  });
});

describe('makeConfig', () => {
  it('creates default config with isolation=none', () => {
    const config = makeConfig();
    expect(config.isolation).toBe('none');
    expect(config.rules.coverage).toBe(80);
  });

  it('applies overrides', () => {
    const config = makeConfig({ isolation: 'worktree' });
    expect(config.isolation).toBe('worktree');
    expect(config.rules.coverage).toBe(80); // default preserved
  });

  it('has all model tiers set', () => {
    const config = makeConfig();
    expect(config.model.assess).toBe('large');
    expect(config.model.impl).toBe('medium');
    expect(config.model.quality).toBe('small');
  });
});

describe('makeFixState', () => {
  it('creates state with issue and running status', () => {
    const state = makeFixState(7);
    expect(state.issue.number).toBe(7);
    expect(state.status).toBe('running');
    expect(state.completedWaves).toEqual([]);
    expect(state.waveResults).toEqual({});
  });

  it('applies overrides', () => {
    const state = makeFixState(7, { status: 'completed', completedWaves: ['assess'] });
    expect(state.status).toBe('completed');
    expect(state.completedWaves).toEqual(['assess']);
    expect(state.issue.number).toBe(7);
  });
});
