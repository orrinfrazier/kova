// Wiring/contract tests for the local-model integration suite (issue #251).
//
// These tests are ALWAYS active — they assert the surrounding plumbing
// (npm script + README + skip-by-default contract) is intact so the
// integration suite itself stays discoverable and CI-safe.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf-8')) as T;
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

describe('local-model integration suite — wiring contract (issue #251)', () => {
  it('package.json exposes test:integration:local npm script', () => {
    const pkg = readJson<PackageJsonShape>('package.json');
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts?.['test:integration:local']).toBeDefined();
  });

  it('test:integration:local sets KOVA_RUN_LOCAL_MODEL_TESTS=1 inline', () => {
    const pkg = readJson<PackageJsonShape>('package.json');
    const script = pkg.scripts?.['test:integration:local'] ?? '';
    // Anchor the env-var name so a rename in the suite file is caught by CI.
    expect(script).toMatch(/KOVA_RUN_LOCAL_MODEL_TESTS\s*=\s*1/);
  });

  it('test:integration:local targets the src/integration directory', () => {
    const pkg = readJson<PackageJsonShape>('package.json');
    const script = pkg.scripts?.['test:integration:local'] ?? '';
    expect(script).toMatch(/src\/integration/);
  });

  it('README.md exists at src/integration/README.md and documents the env contract', () => {
    const readme = readFileSync(resolve(root, 'src/integration/README.md'), 'utf-8');
    expect(readme).toMatch(/KOVA_RUN_LOCAL_MODEL_TESTS/);
    expect(readme).toMatch(/gemma4:26b/);
    expect(readme).toMatch(/skipped by default/i);
  });

  it('README cross-links the bug-source issues from prior gemma testing', () => {
    const readme = readFileSync(resolve(root, 'src/integration/README.md'), 'utf-8');
    // The 6 bugs surfaced in 2026-04-08 gemma session map to these issues.
    expect(readme).toMatch(/#239/);
    expect(readme).toMatch(/#241/);
    expect(readme).toMatch(/#242/);
    expect(readme).toMatch(/#245/);
  });

  it('integration suite file lives at the path the npm script targets', () => {
    const src = readFileSync(resolve(root, 'src/integration/local-model.integration.test.ts'), 'utf-8');
    // Pin the env-gate so a rename is caught.
    expect(src).toMatch(/KOVA_RUN_LOCAL_MODEL_TESTS/);
    // Pin the documented test framework call.
    expect(src).toMatch(/describe\.runIf/);
  });

  it('integration suite uses describe.runIf (not it.skipIf) so collect-time discovery is preserved', () => {
    const src = readFileSync(resolve(root, 'src/integration/local-model.integration.test.ts'), 'utf-8');
    // `describe.runIf` keeps the file discoverable + reports skipped at the
    // describe level rather than per-it, which keeps the CI output clean.
    expect(src.includes('describe.runIf(SHOULD_RUN)')).toBe(true);
  });
});
