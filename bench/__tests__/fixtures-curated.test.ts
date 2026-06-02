// Verifies the >=3 curated fixtures under bench/fixtures/ load cleanly,
// have unique ids, and their seed acceptance tests FAIL out of the box
// (i.e. the bug-state is real — a no-op fixApply does not accidentally
// pass them). This is the acceptance criterion enforcer for the
// "bench/ has >=3 fixture issue+repo pairs" checkbox.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtures } from '../loader.js';
import { runFixture } from '../runner.js';
import type { FixApply } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
// bench/__tests__ -> bench (parent of fixtures/)
const benchRoot = resolve(here, '..');

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'kova-bench-curated-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('curated fixtures under bench/fixtures', () => {
  it('loads at least 3 fixtures', async () => {
    const fixtures = await loadFixtures(benchRoot);
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  it('has unique ids across all fixtures', async () => {
    const fixtures = await loadFixtures(benchRoot);
    const ids = fixtures.map((f) => f.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each fixture has a non-empty issue title and acceptance command', async () => {
    const fixtures = await loadFixtures(benchRoot);
    for (const f of fixtures) {
      expect(f.manifest.issue.title.length).toBeGreaterThan(0);
      expect(f.acceptanceCommand.length).toBeGreaterThan(0);
    }
  });

  it('every fixture FAILS the acceptance with a no-op fixApply (proves the seed is buggy)', async () => {
    const fixtures = await loadFixtures(benchRoot);
    const noopFixApply: FixApply = async () => ({ cost: 0, waves: [] });
    for (const fixture of fixtures) {
      const result = await runFixture(fixture, { fixApply: noopFixApply, tmpRoot });
      expect(
        result.passed,
        `Fixture ${fixture.manifest.id} unexpectedly PASSED on the bug-state seed — the fixture has no real bug to fix.`,
      ).toBe(false);
    }
  }, 60_000);
});
