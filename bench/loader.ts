// Fixture discovery + manifest validation.
//
// Layout convention:
//   <rootDir>/fixtures/<fixtureId>/fixture.json
//   <rootDir>/fixtures/<fixtureId>/repo/...   (the seed repo)
//
// `loadFixtures` returns a sorted-by-id list. Invalid manifests throw
// BenchFixtureError with the offending path included so the report
// caller knows which fixture to fix.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { FixtureManifestSchema, type LoadedFixture } from './types.js';

const FIXTURES_SUBDIR = 'fixtures';
const MANIFEST_FILENAME = 'fixture.json';

/** Thrown when a fixture directory has a malformed `fixture.json`. */
export class BenchFixtureError extends Error {
  constructor(
    public readonly fixturePath: string,
    public readonly issues: z.core.$ZodIssue[],
    message?: string,
  ) {
    super(message ?? `invalid fixture manifest at ${fixturePath}: ${JSON.stringify(issues)}`);
    this.name = 'BenchFixtureError';
  }
}

/**
 * Scan `<rootDir>/fixtures/` and return one entry per child directory
 * that contains a valid `fixture.json`. Directories without a manifest
 * are skipped (with a stderr warning); directories with an invalid
 * manifest throw `BenchFixtureError`.
 */
export async function loadFixtures(rootDir: string): Promise<LoadedFixture[]> {
  const fixturesRoot = join(rootDir, FIXTURES_SUBDIR);
  let entries: string[];
  try {
    entries = await readdir(fixturesRoot);
  } catch (err) {
    if (isErrnoExceptionCode(err, 'ENOENT')) return [];
    throw err;
  }

  const loaded: LoadedFixture[] = [];
  for (const entry of entries) {
    const fixtureDir = join(fixturesRoot, entry);
    let isDir = false;
    try {
      isDir = (await stat(fixtureDir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const manifestPath = join(fixtureDir, MANIFEST_FILENAME);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (err) {
      if (isErrnoExceptionCode(err, 'ENOENT')) {
        process.stderr.write(`[bench] skipping ${fixtureDir}: no ${MANIFEST_FILENAME}\n`);
        continue;
      }
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new BenchFixtureError(
        manifestPath,
        [],
        `failed to parse JSON in ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = FixtureManifestSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new BenchFixtureError(manifestPath, result.error.issues);
    }

    const manifest = result.data;
    loaded.push({
      manifest,
      fixtureDir,
      repoSeedDir: join(fixtureDir, manifest.repoDir),
      acceptanceCommand: manifest.acceptance,
    });
  }

  loaded.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
  return loaded;
}

function isErrnoExceptionCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
