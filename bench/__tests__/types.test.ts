// Schema validation tests for bench/types.ts.
// Verifies the FixtureManifest schema accepts valid input, rejects bad input,
// and applies defaults — the contract relied on by loader/runner/scorer.

import { describe, expect, it } from 'vitest';
import { FixtureManifestSchema } from '../types.js';

describe('FixtureManifestSchema', () => {
  it('parses a minimal valid manifest with defaults applied', () => {
    const parsed = FixtureManifestSchema.parse({
      id: '01-trim-input',
      title: 'Trim whitespace from input',
      description: 'Function fails when input has trailing whitespace.',
      issue: { title: 'trim input', body: 'fails on whitespace' },
      acceptance: 'node test.js',
    });
    expect(parsed.id).toBe('01-trim-input');
    expect(parsed.repoDir).toBe('repo');
    expect(parsed.timeoutMs).toBe(600_000);
    expect(parsed.issue.title).toBe('trim input');
    expect(parsed.acceptance).toBe('node test.js');
  });

  it('honors an explicit repoDir override', () => {
    const parsed = FixtureManifestSchema.parse({
      id: 'x',
      title: 't',
      description: 'd',
      issue: { title: 'a', body: 'b' },
      acceptance: 'true',
      repoDir: 'src/seed',
    });
    expect(parsed.repoDir).toBe('src/seed');
  });

  it('rejects a manifest missing id', () => {
    expect(() =>
      FixtureManifestSchema.parse({
        title: 't',
        description: 'd',
        issue: { title: 'a', body: 'b' },
        acceptance: 'true',
      }),
    ).toThrow();
  });

  it('rejects a manifest with non-string acceptance command', () => {
    expect(() =>
      FixtureManifestSchema.parse({
        id: 'x',
        title: 't',
        description: 'd',
        issue: { title: 'a', body: 'b' },
        acceptance: 123,
      }),
    ).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() =>
      FixtureManifestSchema.parse({
        id: '',
        title: 't',
        description: 'd',
        issue: { title: 'a', body: 'b' },
        acceptance: 'true',
      }),
    ).toThrow();
  });
});
