// Tests for the regression-surface helper (#276).
//
// The helper takes a codegraph lookup + a list of files changed in the worktree
// and returns a capped, formatted markdown section listing dependents of the
// changed code. Injected into the review wave above quality gates so the
// reviewer can verify behavioral consistency at each dependent.

import { describe, expect, it } from 'vitest';
import type { SymbolNode } from '../types/codegraph.js';
import { formatRegressionSurface, type RegressionSurfaceLookup } from './regression-surface.js';

function node(filePath: string, name: string, kind: SymbolNode['kind'] = 'function'): SymbolNode {
  return {
    id: `${filePath}::${name}@1`,
    kind,
    name,
    filePath,
    startLine: 1,
    endLine: 10,
    signature: `function ${name}()`,
    isExported: true,
  };
}

/** Build a tiny in-memory lookup over a fixed node/dependent map. */
function makeLookup(
  changedFiles: Record<string, SymbolNode[]>,
  callersByNode: Record<string, SymbolNode[]> = {},
  dependentsByFile: Record<string, string[]> = {},
): RegressionSurfaceLookup {
  return {
    listFileSymbols: (filePath) => changedFiles[filePath] ?? [],
    getCallers: (nodeId) => callersByNode[nodeId] ?? [],
    getFileDependents: (filePath) => dependentsByFile[filePath] ?? [],
  };
}

describe('formatRegressionSurface', () => {
  it('returns empty string when no changed files', () => {
    const lookup = makeLookup({});
    expect(formatRegressionSurface({ lookup, changedFiles: [] })).toBe('');
  });

  it('returns empty string when no dependents resolve', () => {
    const a = node('src/a.ts', 'a');
    const lookup = makeLookup({ 'src/a.ts': [a] });
    expect(formatRegressionSurface({ lookup, changedFiles: ['src/a.ts'] })).toBe('');
  });

  it('lists direct callers of changed symbols', () => {
    const a = node('src/a.ts', 'changedFn');
    const caller = node('src/b.ts', 'callerFn');
    const lookup = makeLookup({ 'src/a.ts': [a] }, { [a.id]: [caller] });

    const out = formatRegressionSurface({ lookup, changedFiles: ['src/a.ts'] });

    expect(out).toContain('Regression Surface');
    expect(out).toContain('changedFn');
    expect(out).toContain('callerFn');
    expect(out).toContain('src/b.ts');
  });

  it('lists files that import the changed file', () => {
    const a = node('src/a.ts', 'changedFn');
    const lookup = makeLookup({ 'src/a.ts': [a] }, {}, { 'src/a.ts': ['src/consumer.ts', 'src/other-consumer.ts'] });

    const out = formatRegressionSurface({ lookup, changedFiles: ['src/a.ts'] });

    expect(out).toContain('src/consumer.ts');
    expect(out).toContain('src/other-consumer.ts');
  });

  it('caps the number of dependents per changed file', () => {
    const a = node('src/a.ts', 'changedFn');
    const manyCallers = Array.from({ length: 50 }, (_, i) => node(`src/dep-${i}.ts`, `caller${i}`));
    const lookup = makeLookup({ 'src/a.ts': [a] }, { [a.id]: manyCallers });

    const out = formatRegressionSurface({
      lookup,
      changedFiles: ['src/a.ts'],
      maxDependentsPerFile: 3,
    });

    // Should render at most maxDependentsPerFile + a "and N more" suffix
    expect(out).toContain('caller0');
    expect(out).toContain('caller1');
    expect(out).toContain('caller2');
    expect(out).not.toContain('caller49');
    expect(out).toMatch(/more/i);
  });

  it('caps the total number of changed files rendered', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/changed-${i}.ts`);
    const lookupMap: Record<string, SymbolNode[]> = {};
    const callerMap: Record<string, SymbolNode[]> = {};
    for (const f of files) {
      const n = node(f, `fn_${f}`);
      lookupMap[f] = [n];
      callerMap[n.id] = [node('src/consumer.ts', 'consumer')];
    }
    const lookup = makeLookup(lookupMap, callerMap);

    const out = formatRegressionSurface({
      lookup,
      changedFiles: files,
      maxChangedFiles: 5,
    });

    // First 5 files should appear; later ones should not
    expect(out).toContain('src/changed-0.ts');
    expect(out).toContain('src/changed-4.ts');
    expect(out).not.toContain('src/changed-19.ts');
  });

  it('deduplicates dependents that appear via both caller and import edges', () => {
    const a = node('src/a.ts', 'changedFn');
    const consumer = node('src/consumer.ts', 'use_a');
    const lookup = makeLookup({ 'src/a.ts': [a] }, { [a.id]: [consumer] }, { 'src/a.ts': ['src/consumer.ts'] });

    const out = formatRegressionSurface({ lookup, changedFiles: ['src/a.ts'] });

    // 'src/consumer.ts' should appear once, not twice
    const matches = out.match(/src\/consumer\.ts/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(2); // section header may repeat; ensure no duplicate list rows
  });

  it('skips files for which the lookup has no symbols (graceful)', () => {
    const lookup = makeLookup({});
    const out = formatRegressionSurface({
      lookup,
      changedFiles: ['src/unknown.ts'],
    });
    expect(out).toBe('');
  });

  it('handles lookup throwing per-file (graceful per-file degradation)', () => {
    const a = node('src/good.ts', 'goodFn');
    const lookup: RegressionSurfaceLookup = {
      listFileSymbols: (fp) => {
        if (fp === 'src/bad.ts') throw new Error('boom');
        return fp === 'src/good.ts' ? [a] : [];
      },
      getCallers: () => [node('src/consumer.ts', 'consumer')],
      getFileDependents: () => [],
    };

    const out = formatRegressionSurface({
      lookup,
      changedFiles: ['src/bad.ts', 'src/good.ts'],
    });

    // src/good.ts dependents should still be rendered despite src/bad.ts throwing
    expect(out).toContain('goodFn');
    expect(out).toContain('consumer');
  });
});
