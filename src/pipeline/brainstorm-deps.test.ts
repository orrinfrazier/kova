/**
 * Tests for resolveBrainstormDependencies — issue #279.
 *
 * TDD Red Phase: all tests will fail because ./brainstorm-deps.ts does not
 * exist yet.
 *
 * Contract:
 *   resolveBrainstormDependencies(issues) returns:
 *     { ordered: BrainstormIssue[], unresolvable: Array<{ title; deps }> }
 *
 *   - ordered: topologically sorted so a blocker appears before its dependents
 *   - unresolvable: per-issue list of dep titles that don't match any sibling
 *
 * Resolution rule: a dependency title resolves to a sibling iff some sibling's
 * title matches it via case-insensitive trimmed-string equality.
 */

import { describe, expect, it } from 'vitest';
import type { BrainstormIssue } from '../types/index.js';
import { resolveBrainstormDependencies } from './brainstorm-deps.js';

function makeIssue(overrides: Partial<BrainstormIssue> & { title: string }): BrainstormIssue {
  return {
    title: overrides.title,
    body: overrides.body ?? `body for ${overrides.title}`,
    labels: overrides.labels ?? [],
    priority: overrides.priority ?? 'medium',
    category: overrides.category ?? 'tech-debt',
    confidence: overrides.confidence ?? 0.9,
    ...(overrides.dependencies !== undefined && { dependencies: overrides.dependencies }),
  };
}

describe('resolveBrainstormDependencies', () => {
  describe('topological ordering', () => {
    it('orders a 3-issue chain A→B→C as [A, B, C]', () => {
      const a = makeIssue({ title: 'A' });
      const b = makeIssue({ title: 'B', dependencies: ['A'] });
      const c = makeIssue({ title: 'C', dependencies: ['B'] });

      // Input intentionally not in topological order.
      const result = resolveBrainstormDependencies([c, b, a]);

      const titles = result.ordered.map((i) => i.title);
      expect(titles).toEqual(['A', 'B', 'C']);
    });

    it('orders a diamond A→B, A→C, B→D, C→D with A first and D last', () => {
      const a = makeIssue({ title: 'A' });
      const b = makeIssue({ title: 'B', dependencies: ['A'] });
      const c = makeIssue({ title: 'C', dependencies: ['A'] });
      const d = makeIssue({ title: 'D', dependencies: ['B', 'C'] });

      const result = resolveBrainstormDependencies([d, c, b, a]);
      const titles = result.ordered.map((i) => i.title);

      expect(titles[0]).toBe('A');
      expect(titles[titles.length - 1]).toBe('D');
      // B and C must come before D and after A.
      expect(titles.indexOf('B')).toBeGreaterThan(titles.indexOf('A'));
      expect(titles.indexOf('C')).toBeGreaterThan(titles.indexOf('A'));
      expect(titles.indexOf('B')).toBeLessThan(titles.indexOf('D'));
      expect(titles.indexOf('C')).toBeLessThan(titles.indexOf('D'));
    });

    it('passes issues with no deps through unchanged (stable for indep issues)', () => {
      const x = makeIssue({ title: 'X' });
      const y = makeIssue({ title: 'Y' });
      const z = makeIssue({ title: 'Z' });

      const result = resolveBrainstormDependencies([x, y, z]);

      expect(result.ordered).toHaveLength(3);
      expect(result.ordered.map((i) => i.title).sort()).toEqual(['X', 'Y', 'Z']);
      expect(result.unresolvable).toEqual([]);
    });

    it('returns an empty result for an empty input', () => {
      const result = resolveBrainstormDependencies([]);
      expect(result.ordered).toEqual([]);
      expect(result.unresolvable).toEqual([]);
    });

    it('matches dep titles case-insensitively after trimming whitespace', () => {
      const a = makeIssue({ title: 'Add Input Validation' });
      const b = makeIssue({ title: 'B', dependencies: ['  add input validation  '] });

      const result = resolveBrainstormDependencies([b, a]);

      const titles = result.ordered.map((i) => i.title);
      expect(titles).toEqual(['Add Input Validation', 'B']);
      expect(result.unresolvable).toEqual([]);
    });
  });

  describe('unresolvable dependencies', () => {
    it('reports unresolvable dep titles in `unresolvable`, not silently dropped', () => {
      const b = makeIssue({ title: 'B', dependencies: ['Does Not Exist'] });

      const result = resolveBrainstormDependencies([b]);

      expect(result.unresolvable).toHaveLength(1);
      const entry = result.unresolvable[0];
      expect(entry).toBeDefined();
      expect(entry?.title).toBe('B');
      expect(entry?.deps).toContain('Does Not Exist');
    });

    it('still orders an issue when SOME of its deps are unresolvable', () => {
      const a = makeIssue({ title: 'A' });
      const b = makeIssue({ title: 'B', dependencies: ['A', 'Phantom'] });

      const result = resolveBrainstormDependencies([b, a]);

      expect(result.ordered.map((i) => i.title)).toEqual(['A', 'B']);
      expect(result.unresolvable).toHaveLength(1);
      expect(result.unresolvable[0]?.deps).toEqual(['Phantom']);
    });

    it('reports multiple unresolvable deps for a single issue', () => {
      const b = makeIssue({ title: 'B', dependencies: ['X', 'Y', 'Z'] });

      const result = resolveBrainstormDependencies([b]);

      expect(result.unresolvable).toHaveLength(1);
      expect(result.unresolvable[0]?.deps.sort()).toEqual(['X', 'Y', 'Z']);
    });
  });

  describe('cycle handling', () => {
    it('does not infinite-loop on a cycle and still emits every issue exactly once', () => {
      // A→B and B→A form a cycle.
      const a = makeIssue({ title: 'A', dependencies: ['B'] });
      const b = makeIssue({ title: 'B', dependencies: ['A'] });

      const result = resolveBrainstormDependencies([a, b]);

      expect(result.ordered).toHaveLength(2);
      const titles = result.ordered.map((i) => i.title).sort();
      expect(titles).toEqual(['A', 'B']);
    });
  });

  describe('immutability', () => {
    it('does not mutate input array order', () => {
      const a = makeIssue({ title: 'A' });
      const b = makeIssue({ title: 'B', dependencies: ['A'] });
      const input = [b, a];
      const snapshot = [...input];

      resolveBrainstormDependencies(input);

      expect(input).toEqual(snapshot);
    });
  });
});
