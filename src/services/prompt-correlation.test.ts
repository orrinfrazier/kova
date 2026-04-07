import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './history.js';
import { AB_TEST_MIN_RUNS, correlateByABTestVariant, correlateByPromptVersion } from './prompt-correlation.js';

function makeEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: '2026-01-15T10:00:00.000Z',
    repo: 'test-repo',
    issues: [{ number: 1, title: 'Fix bug', success: true, prUrl: 'https://github.com/test/repo/pull/10' }],
    prsCreated: 1,
    cost: 0.5,
    duration: 60000,
    outcome: 'success',
    ...overrides,
  };
}

describe('correlateByPromptVersion', () => {
  it('returns empty map for entries without promptHashes', () => {
    const entries: HistoryEntry[] = [makeEntry(), makeEntry()];
    const result = correlateByPromptVersion(entries);
    expect(result.size).toBe(0);
  });

  it('groups entries by individual wave:hash key', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ promptHashes: { assess: 'abc123def456', spec: 'aaa111bbb222' }, outcome: 'success' }),
      makeEntry({ promptHashes: { assess: 'abc123def456', spec: 'aaa111bbb222' }, outcome: 'failure' }),
      makeEntry({ promptHashes: { assess: 'xyz789uvw012', spec: 'aaa111bbb222' }, outcome: 'success' }),
    ];

    const result = correlateByPromptVersion(entries);
    // 3 unique wave:hash keys: assess:abc..., assess:xyz..., spec:aaa...
    expect(result.size).toBe(3);
    expect(result.has('assess:abc123def456')).toBe(true);
    expect(result.has('assess:xyz789uvw012')).toBe(true);
    expect(result.has('spec:aaa111bbb222')).toBe(true);
  });

  it('computes success rate per prompt version', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ promptHashes: { assess: 'aaa' }, outcome: 'success' }),
      makeEntry({ promptHashes: { assess: 'aaa' }, outcome: 'success' }),
      makeEntry({ promptHashes: { assess: 'aaa' }, outcome: 'failure' }),
      makeEntry({ promptHashes: { assess: 'bbb' }, outcome: 'failure' }),
      makeEntry({ promptHashes: { assess: 'bbb' }, outcome: 'failure' }),
    ];

    const result = correlateByPromptVersion(entries);

    const aaaStats = result.get('assess:aaa');
    expect(aaaStats).toBeDefined();
    expect(aaaStats?.runs).toBe(3);
    expect(aaaStats?.successRate).toBeCloseTo(66.67, 0);

    const bbbStats = result.get('assess:bbb');
    expect(bbbStats).toBeDefined();
    expect(bbbStats?.runs).toBe(2);
    expect(bbbStats?.successRate).toBe(0);
  });

  it('computes average cost per prompt version', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ promptHashes: { impl: 'hash1' }, cost: 1.0, outcome: 'success' }),
      makeEntry({ promptHashes: { impl: 'hash1' }, cost: 3.0, outcome: 'success' }),
    ];

    const result = correlateByPromptVersion(entries);
    const stats = result.get('impl:hash1');
    expect(stats?.avgCost).toBeCloseTo(2.0);
  });

  it('handles entries with multiple wave hashes', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        promptHashes: { assess: 'a1', spec: 's1', impl: 'i1' },
        outcome: 'success',
      }),
    ];

    const result = correlateByPromptVersion(entries);
    // One entry per wave hash
    expect(result.has('assess:a1')).toBe(true);
    expect(result.has('spec:s1')).toBe(true);
    expect(result.has('impl:i1')).toBe(true);
  });
});

describe('correlateByABTestVariant', () => {
  it('returns empty array for entries without abTestVariants', () => {
    const entries: HistoryEntry[] = [makeEntry(), makeEntry()];
    const result = correlateByABTestVariant(entries);
    expect(result).toHaveLength(0);
  });

  it('groups entries by wave and variant', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ abTestVariants: { assess: 'v1' }, outcome: 'success' }),
      makeEntry({ abTestVariants: { assess: 'v1' }, outcome: 'failure' }),
      makeEntry({ abTestVariants: { assess: 'v2' }, outcome: 'success' }),
    ];

    const result = correlateByABTestVariant(entries);
    expect(result).toHaveLength(2);

    const v1 = result.find((s) => s.variant === 'v1');
    expect(v1).toBeDefined();
    expect(v1?.runs).toBe(2);
    expect(v1?.successes).toBe(1);
    expect(v1?.successRate).toBeCloseTo(50);

    const v2 = result.find((s) => s.variant === 'v2');
    expect(v2).toBeDefined();
    expect(v2?.runs).toBe(1);
    expect(v2?.successRate).toBeCloseTo(100);
  });

  it('computes average cost and duration', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ abTestVariants: { impl: 'v1' }, cost: 1.0, duration: 60000, outcome: 'success' }),
      makeEntry({ abTestVariants: { impl: 'v1' }, cost: 3.0, duration: 120000, outcome: 'success' }),
    ];

    const result = correlateByABTestVariant(entries);
    const v1 = result.find((s) => s.variant === 'v1');
    expect(v1?.avgCost).toBeCloseTo(2.0);
    expect(v1?.avgDuration).toBeCloseTo(90000);
  });

  it('marks variants as sufficient only when >= AB_TEST_MIN_RUNS', () => {
    const entries: HistoryEntry[] = [];
    // Create AB_TEST_MIN_RUNS entries for v1 (sufficient)
    for (let i = 0; i < AB_TEST_MIN_RUNS; i++) {
      entries.push(makeEntry({ abTestVariants: { assess: 'v1' }, outcome: 'success' }));
    }
    // Create fewer for v2 (insufficient)
    entries.push(makeEntry({ abTestVariants: { assess: 'v2' }, outcome: 'success' }));

    const result = correlateByABTestVariant(entries);
    const v1 = result.find((s) => s.variant === 'v1');
    const v2 = result.find((s) => s.variant === 'v2');
    expect(v1?.sufficient).toBe(true);
    expect(v2?.sufficient).toBe(false);
  });

  it('sorts results by wave then variant', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ abTestVariants: { spec: 'beta' }, outcome: 'success' }),
      makeEntry({ abTestVariants: { assess: 'v2' }, outcome: 'success' }),
      makeEntry({ abTestVariants: { assess: 'v1' }, outcome: 'success' }),
    ];

    const result = correlateByABTestVariant(entries);
    expect(result[0]?.wave).toBe('assess');
    expect(result[0]?.variant).toBe('v1');
    expect(result[1]?.wave).toBe('assess');
    expect(result[1]?.variant).toBe('v2');
    expect(result[2]?.wave).toBe('spec');
    expect(result[2]?.variant).toBe('beta');
  });

  it('handles entries with multiple wave variants', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        abTestVariants: { assess: 'v1', spec: 'v2' },
        outcome: 'success',
      }),
    ];

    const result = correlateByABTestVariant(entries);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.wave === 'assess' && s.variant === 'v1')).toBeDefined();
    expect(result.find((s) => s.wave === 'spec' && s.variant === 'v2')).toBeDefined();
  });
});
