// Loader tests for bench/loader.ts.
// Verifies the loader scans `fixtures/`, parses each manifest, and returns
// a sorted list of LoadedFixture entries — using a real temp filesystem.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BenchFixtureError, loadFixtures } from '../loader.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'kova-bench-loader-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeManifest(
  fixturesRoot: string,
  fixtureId: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const fixtureDir = join(fixturesRoot, fixtureId);
  await mkdir(join(fixtureDir, 'repo'), { recursive: true });
  await writeFile(join(fixtureDir, 'fixture.json'), JSON.stringify(manifest));
}

describe('loadFixtures', () => {
  it('returns an empty array when fixtures/ is missing', async () => {
    const result = await loadFixtures(workdir);
    expect(result).toEqual([]);
  });

  it('loads multiple fixtures sorted by id', async () => {
    const fixturesRoot = join(workdir, 'fixtures');
    await writeManifest(fixturesRoot, '02-second', {
      id: '02-second',
      title: 'Second',
      description: 'd',
      issue: { title: 't', body: 'b' },
      acceptance: 'true',
    });
    await writeManifest(fixturesRoot, '01-first', {
      id: '01-first',
      title: 'First',
      description: 'd',
      issue: { title: 't', body: 'b' },
      acceptance: 'true',
    });

    const loaded = await loadFixtures(workdir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.manifest.id).toBe('01-first');
    expect(loaded[1]?.manifest.id).toBe('02-second');
    expect(loaded[0]?.repoSeedDir).toBe(join(fixturesRoot, '01-first', 'repo'));
    expect(loaded[0]?.acceptanceCommand).toBe('true');
  });

  it('skips directories without fixture.json and warns', async () => {
    const fixturesRoot = join(workdir, 'fixtures');
    await mkdir(join(fixturesRoot, 'no-manifest'), { recursive: true });
    await writeManifest(fixturesRoot, '01-valid', {
      id: '01-valid',
      title: 't',
      description: 'd',
      issue: { title: 'a', body: 'b' },
      acceptance: 'true',
    });

    const loaded = await loadFixtures(workdir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe('01-valid');
  });

  it('throws BenchFixtureError on invalid manifest with fixture path included', async () => {
    const fixturesRoot = join(workdir, 'fixtures');
    await writeManifest(fixturesRoot, 'bad', {
      // missing required fields
      title: 'broken',
    });

    await expect(loadFixtures(workdir)).rejects.toBeInstanceOf(BenchFixtureError);
    await expect(loadFixtures(workdir)).rejects.toThrow(/bad/);
  });
});
