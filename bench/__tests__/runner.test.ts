// Runner tests for bench/runner.ts.
// Each test uses a real temp dir, a real seed repo (the sample fixture under
// __tests__/fixtures), and a real spawn for acceptance. Only `fixApply` is
// injected — that is the contract WAVE I will implement.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtures } from '../loader.js';
import { runFixture } from '../runner.js';
import type { FixApply } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleRoot = join(here, 'fixtures');

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'kova-bench-runner-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function loadSample() {
  // sampleRoot's parent is fixtures/.. (= __tests__/), so we point loadFixtures
  // at __tests__ — which contains `fixtures/sample`. Confirm we got it.
  const fixtures = await loadFixtures(here);
  const sample = fixtures.find((f) => f.manifest.id === 'sample');
  if (!sample) throw new Error(`sample fixture not found at ${sampleRoot}`);
  return sample;
}

describe('runFixture', () => {
  it('passes when fixApply writes the expected file', async () => {
    const fixture = await loadSample();
    const fixApply: FixApply = async ({ workdir }) => {
      await writeFile(join(workdir, 'SOLVED.txt'), 'done');
      return { cost: 0.42, waves: [{ name: 'impl', durationMs: 5, cost: 0.42 }] };
    };

    const result = await runFixture(fixture, { fixApply, tmpRoot });
    expect(result.fixtureId).toBe('sample');
    expect(result.passed).toBe(true);
    expect(result.cost).toBeCloseTo(0.42, 5);
    expect(result.waves).toHaveLength(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.schemaVersion).toBe(1);
  });

  it('fails when fixApply does nothing', async () => {
    const fixture = await loadSample();
    const fixApply: FixApply = async () => ({ cost: 0, waves: [] });

    const result = await runFixture(fixture, { fixApply, tmpRoot });
    expect(result.passed).toBe(false);
    expect(`${result.acceptanceStdout ?? ''}${result.acceptanceStderr ?? ''}`).toMatch(/FAIL/);
  });

  it('does not modify the seed repo directory', async () => {
    const fixture = await loadSample();
    const fixApply: FixApply = async ({ workdir }) => {
      // Write a junk file inside the workdir — must NOT propagate back to seedDir.
      await writeFile(join(workdir, 'JUNK.txt'), 'should not leak');
      return { cost: 0, waves: [] };
    };

    await runFixture(fixture, { fixApply, tmpRoot });
    // Re-read the seed dir; JUNK.txt should not exist.
    const { readdir } = await import('node:fs/promises');
    const seedFiles = await readdir(fixture.repoSeedDir);
    expect(seedFiles).not.toContain('JUNK.txt');
  });

  it('removes the tmp workdir after the run by default', async () => {
    const fixture = await loadSample();
    const observedDirs: string[] = [];
    const fixApply: FixApply = async ({ workdir }) => {
      observedDirs.push(workdir);
      await writeFile(join(workdir, 'SOLVED.txt'), 'done');
      return { cost: 0, waves: [] };
    };

    await runFixture(fixture, { fixApply, tmpRoot });
    expect(observedDirs).toHaveLength(1);
    const dir = observedDirs[0]!;
    const { access } = await import('node:fs/promises');
    await expect(access(dir)).rejects.toThrow();
  });

  it('keeps the tmp workdir when keep: true is passed', async () => {
    const fixture = await loadSample();
    let observed = '';
    const fixApply: FixApply = async ({ workdir }) => {
      observed = workdir;
      await writeFile(join(workdir, 'SOLVED.txt'), 'done');
      return { cost: 0, waves: [] };
    };

    await runFixture(fixture, { fixApply, tmpRoot, keep: true });
    const { access } = await import('node:fs/promises');
    await expect(access(observed)).resolves.toBeUndefined();
  });

  it('captures fixApply errors and marks the run failed', async () => {
    const fixture = await loadSample();
    const fixApply: FixApply = async () => {
      throw new Error('fixApply blew up');
    };

    const result = await runFixture(fixture, { fixApply, tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/fixApply blew up/);
  });

  it('times out when the acceptance command runs too long', async () => {
    // Build a one-shot fixture that just sleeps in acceptance.
    const fixtureDir = join(tmpRoot, 'slow-fixture');
    const repoDir = join(fixtureDir, 'repo');
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(fixtureDir, 'fixture.json'),
      JSON.stringify({
        id: 'slow',
        title: 'slow',
        description: 'sleeps',
        issue: { title: 't', body: 'b' },
        acceptance: 'sleep 5',
        timeoutMs: 200,
      }),
    );
    const fixtures = await loadFixtures(dirname(fixtureDir).replace(/\/[^/]+$/, '/' + 'fixtures-root'));
    // The loader scans <root>/fixtures, so build that layout instead.
    const fixturesRoot = join(tmpRoot, 'with-fixtures');
    await mkdir(join(fixturesRoot, 'fixtures', 'slow', 'repo'), { recursive: true });
    await writeFile(
      join(fixturesRoot, 'fixtures', 'slow', 'fixture.json'),
      JSON.stringify({
        id: 'slow',
        title: 'slow',
        description: 'sleeps',
        issue: { title: 't', body: 'b' },
        acceptance: 'sleep 5',
        timeoutMs: 200,
      }),
    );
    const all = await loadFixtures(fixturesRoot);
    const slow = all.find((f) => f.manifest.id === 'slow');
    if (!slow) throw new Error('failed to set up slow fixture');
    // Use the variable to satisfy lint.
    expect(fixtures).toBeDefined();

    const result = await runFixture(slow, {
      fixApply: async () => ({ cost: 0, waves: [] }),
      tmpRoot,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });
});
