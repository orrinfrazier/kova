import { describe, expect, it } from 'vitest';
import type { ABTestConfig } from '../types/index.js';
import { selectVariants, variantFileName } from './ab-test.js';

describe('selectVariants', () => {
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

    // Run multiple times to check randomness stays within bounds
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
    // Run enough times to likely see all variants
    for (let i = 0; i < 100; i++) {
      const selection = selectVariants(abTest);
      if (selection.impl) seen.add(selection.impl);
    }
    // With 100 runs and 3 variants, extremely unlikely to not see all
    expect(seen.size).toBe(3);
  });

  it('returns empty object for empty config', () => {
    const abTest: ABTestConfig = {};
    const selection = selectVariants(abTest);
    expect(Object.keys(selection)).toHaveLength(0);
  });
});

describe('variantFileName', () => {
  it('constructs variant file name from wave and variant', () => {
    expect(variantFileName('assess', 'v1')).toBe('assess.v1.md');
    expect(variantFileName('spec', 'experiment')).toBe('spec.experiment.md');
  });
});
