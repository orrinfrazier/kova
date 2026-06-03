import { describe, expect, it } from 'vitest';
import type { ABTestConfig } from '../types/index.js';
import { DEFAULT_EPSILON, selectVariants, variantFileName } from './ab-test.js';
import type { ABTestVariantStats } from './prompt-correlation.js';

/** Build an ABTestVariantStats with sensible defaults. */
function stat(over: Partial<ABTestVariantStats> & Pick<ABTestVariantStats, 'wave' | 'variant'>): ABTestVariantStats {
  return {
    runs: 20,
    successes: 10,
    successRate: 50,
    avgCost: 1,
    avgDuration: 1000,
    sufficient: true,
    ...over,
  };
}

/** Deterministic random sequence helper. */
function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v ?? 0;
  };
}

describe('selectVariants — cold start (no stats)', () => {
  it('returns a variant for each configured wave', () => {
    const abTest: ABTestConfig = {
      assess: ['v1', 'v2'],
      spec: ['control', 'experiment'],
    };

    const selection = selectVariants(abTest);
    expect(Object.keys(selection)).toHaveLength(2);
    expect(selection.assess).toBeDefined();
    expect(selection.spec).toBeDefined();
  });

  it('selects only from configured variants', () => {
    const abTest: ABTestConfig = {
      assess: ['alpha', 'beta'],
    };

    for (let i = 0; i < 50; i++) {
      const selection = selectVariants(abTest);
      expect(['alpha', 'beta']).toContain(selection.assess);
    }
  });

  it('handles three or more variants', () => {
    const abTest: ABTestConfig = {
      impl: ['v1', 'v2', 'v3'],
    };

    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const selection = selectVariants(abTest);
      if (selection.impl) seen.add(selection.impl);
    }
    expect(seen.size).toBe(3);
  });

  it('returns empty object for empty config', () => {
    const abTest: ABTestConfig = {};
    const selection = selectVariants(abTest);
    expect(Object.keys(selection)).toHaveLength(0);
  });

  it('falls back to uniform when stats array is empty', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    // random=0 → floor(0 * 2) = 0 → v1
    const selection = selectVariants(abTest, { stats: [], random: () => 0 });
    expect(selection.assess).toBe('v1');
  });

  it('falls back to uniform when only insufficient stats exist', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 100, sufficient: false }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: false }),
    ];
    // Uniform pick: random=0.6 → floor(0.6 * 2) = 1 → v2. Exploit would have
    // chosen v1 (highest rate) — proving sufficient=false is treated as cold-start.
    const selection = selectVariants(abTest, { stats, random: () => 0.6 });
    expect(selection.assess).toBe('v2');
  });
});

describe('selectVariants — exploit best sufficient variant', () => {
  it('picks the best sufficient variant when not exploring', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2', 'v3'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 40, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v3', successRate: 60, sufficient: true }),
    ];

    // First random is the exploration coin; 0.5 > epsilon(0.1) → exploit.
    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0.1 },
      random: seqRandom([0.5]),
    });
    expect(selection.assess).toBe('v2');
  });

  it('ignores variants that are no longer configured', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 30, sufficient: true }),
      // v3 was a previous experiment with a great rate but is no longer configured.
      stat({ wave: 'assess', variant: 'v3', successRate: 99, sufficient: true }),
    ];

    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0 },
      random: () => 0.99,
    });
    expect(selection.assess).toBe('v1');
  });

  it('ignores insufficient stats when choosing the exploit candidate', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 50, sufficient: true }),
      // v2 looks best but is not yet sufficient — must be ignored for exploit.
      stat({ wave: 'assess', variant: 'v2', successRate: 95, sufficient: false }),
    ];

    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0 },
      random: () => 0.99,
    });
    expect(selection.assess).toBe('v1');
  });

  it('tie-breaks deterministically by variant name', () => {
    const abTest: ABTestConfig = { assess: ['vb', 'va'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'va', successRate: 80, sufficient: true }),
      stat({ wave: 'assess', variant: 'vb', successRate: 80, sufficient: true }),
    ];

    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0 },
      random: () => 0.99,
    });
    expect(selection.assess).toBe('va');
  });

  it('per-wave decision: cold-start one wave, exploit another', () => {
    const abTest: ABTestConfig = {
      assess: ['v1', 'v2'],
      spec: ['s1', 's2'],
    };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'spec', variant: 's1', successRate: 30, sufficient: true }),
      stat({ wave: 'spec', variant: 's2', successRate: 70, sufficient: true }),
      // No assess stats → cold start for assess.
    ];

    // assess (cold start): 1 uniform random call → 0 → floor(0*2)=0 → v1.
    // spec (sufficient): coin=0.5 > 0.1 → exploit → s2.
    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0.1 },
      random: seqRandom([0, 0.5]),
    });
    expect(selection.assess).toBe('v1');
    expect(selection.spec).toBe('s2');
  });
});

describe('selectVariants — epsilon honored', () => {
  it('explores when random < epsilon', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: true }),
    ];

    // 0.05 < epsilon=0.2 → explore; next random=0.99 → floor(0.99*2)=1 → v2.
    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0.2 },
      random: seqRandom([0.05, 0.99]),
    });
    expect(selection.assess).toBe('v2');
  });

  it('exploits when random > epsilon', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: true }),
    ];

    const selection = selectVariants(abTest, {
      stats,
      policy: { epsilon: 0.1 },
      random: seqRandom([0.5]),
    });
    expect(selection.assess).toBe('v1');
  });

  it('epsilon=0 never explores', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: true }),
    ];

    for (let i = 0; i < 20; i++) {
      const selection = selectVariants(abTest, {
        stats,
        policy: { epsilon: 0 },
      });
      expect(selection.assess).toBe('v1');
    }
  });

  it('epsilon=1 always explores (effectively uniform random)', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: true }),
    ];

    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const selection = selectVariants(abTest, {
        stats,
        policy: { epsilon: 1 },
      });
      if (selection.assess) seen.add(selection.assess);
    }
    expect(seen).toEqual(new Set(['v1', 'v2']));
  });

  it('uses DEFAULT_EPSILON as a sensible default', () => {
    expect(DEFAULT_EPSILON).toBeGreaterThan(0);
    expect(DEFAULT_EPSILON).toBeLessThan(1);
  });

  it('clamps out-of-range epsilon values', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 90, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 10, sufficient: true }),
    ];

    // Negative epsilon clamps to 0 → always exploit.
    let s = selectVariants(abTest, { stats, policy: { epsilon: -1 }, random: () => 0 });
    expect(s.assess).toBe('v1');

    // Epsilon > 1 clamps to 1 → always explore. random=[0, 0.99]:
    //   first random < 1 → explore branch
    //   second random=0.99 → floor(0.99*2)=1 → v2
    s = selectVariants(abTest, {
      stats,
      policy: { epsilon: 5 },
      random: seqRandom([0, 0.99]),
    });
    expect(s.assess).toBe('v2');
  });
});

describe('selectVariants — forceRandom policy', () => {
  it('forces uniform random regardless of stats', () => {
    const abTest: ABTestConfig = { assess: ['v1', 'v2'] };
    const stats: ABTestVariantStats[] = [
      stat({ wave: 'assess', variant: 'v1', successRate: 99, sufficient: true }),
      stat({ wave: 'assess', variant: 'v2', successRate: 1, sufficient: true }),
    ];

    // With forceRandom, no exploit even though v1 is overwhelmingly better.
    const selection = selectVariants(abTest, {
      stats,
      policy: { forceRandom: true },
      random: () => 0.99,
    });
    expect(selection.assess).toBe('v2');
  });
});

describe('variantFileName', () => {
  it('constructs variant file name from wave and variant', () => {
    expect(variantFileName('assess', 'v1')).toBe('assess.v1.md');
    expect(variantFileName('spec', 'experiment')).toBe('spec.experiment.md');
  });
});
