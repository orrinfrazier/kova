import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

function getCliVersion(): string | undefined {
  const src = readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
  const match = src.match(/\.version\('([^']+)'\)/);
  return match?.[1];
}

describe('CLI version', () => {
  it('CLI .version() matches package.json version', () => {
    const pkgVersion = getPackageVersion();
    const cliVersion = getCliVersion();
    expect(cliVersion).toBe(pkgVersion);
  });

  it('package.json version is semver-valid', () => {
    const version = getPackageVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
