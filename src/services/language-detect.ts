// Language and tooling detection for target repositories.
// Detects project language, test runner, linter, formatter, and package manager
// from config files in the working directory.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DetectedTooling {
  language: 'typescript' | 'javascript' | 'rust' | 'go' | 'python' | 'unknown';
  testRunner?: string | undefined;
  linter?: string | undefined;
  formatter?: string | undefined;
  packageManager?: string | undefined;
  typeChecker?: string | undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

async function detectNodeTooling(workDir: string): Promise<DetectedTooling> {
  const hasTsConfig = await fileExists(join(workDir, 'tsconfig.json'));
  const language = hasTsConfig ? 'typescript' : 'javascript';

  let testRunner: string | undefined;
  let linter: string | undefined;
  let formatter: string | undefined;
  let packageManager: string | undefined;

  // Test runner detection
  const hasVitestConfig =
    (await fileExists(join(workDir, 'vitest.config.ts'))) ||
    (await fileExists(join(workDir, 'vitest.config.js'))) ||
    (await fileExists(join(workDir, 'vitest.config.mts')));
  const hasJestConfig =
    (await fileExists(join(workDir, 'jest.config.js'))) || (await fileExists(join(workDir, 'jest.config.ts')));

  if (hasVitestConfig) {
    testRunner = 'vitest';
  } else if (hasJestConfig) {
    testRunner = 'jest';
  } else {
    // Check package.json scripts
    const pkgContent = await readFileSafe(join(workDir, 'package.json'));
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent) as { scripts?: Record<string, string> };
        const testScript = pkg.scripts?.test ?? '';
        if (testScript.includes('vitest')) testRunner = 'vitest';
        else if (testScript.includes('jest')) testRunner = 'jest';
      } catch {
        // Invalid JSON — skip
      }
    }
  }

  // Linter detection
  const hasBiome = (await fileExists(join(workDir, 'biome.json'))) || (await fileExists(join(workDir, 'biome.jsonc')));
  const hasEslintRc =
    (await fileExists(join(workDir, '.eslintrc.json'))) ||
    (await fileExists(join(workDir, '.eslintrc.js'))) ||
    (await fileExists(join(workDir, '.eslintrc.yml')));
  const hasEslintFlat =
    (await fileExists(join(workDir, 'eslint.config.js'))) || (await fileExists(join(workDir, 'eslint.config.mjs')));

  if (hasBiome) {
    linter = 'biome';
    formatter = 'biome';
  } else if (hasEslintRc || hasEslintFlat) {
    linter = 'eslint';
  }

  // Formatter detection (only if not already set by biome)
  if (!formatter) {
    const hasPrettier =
      (await fileExists(join(workDir, '.prettierrc'))) ||
      (await fileExists(join(workDir, '.prettierrc.json'))) ||
      (await fileExists(join(workDir, 'prettier.config.js')));
    if (hasPrettier) formatter = 'prettier';
  }

  // Package manager detection
  if (await fileExists(join(workDir, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (await fileExists(join(workDir, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (await fileExists(join(workDir, 'package-lock.json'))) {
    packageManager = 'npm';
  }

  return { language, testRunner, linter, formatter, packageManager };
}

function rustTooling(): DetectedTooling {
  return {
    language: 'rust',
    testRunner: 'cargo-test',
    linter: 'clippy',
    formatter: 'rustfmt',
  };
}

async function goTooling(workDir: string): Promise<DetectedTooling> {
  const hasGolangciLint =
    (await fileExists(join(workDir, '.golangci.yml'))) ||
    (await fileExists(join(workDir, '.golangci.yaml'))) ||
    (await fileExists(join(workDir, '.golangci.toml')));

  return {
    language: 'go',
    testRunner: 'go-test',
    linter: hasGolangciLint ? 'golangci-lint' : 'go-vet',
    formatter: 'gofmt',
  };
}

async function pythonTooling(workDir: string): Promise<DetectedTooling> {
  const pyprojectContent = await readFileSafe(join(workDir, 'pyproject.toml'));
  const hasRuffToml = await fileExists(join(workDir, 'ruff.toml'));

  let testRunner: string | undefined;
  let linter: string | undefined;
  let formatter: string | undefined;
  let typeChecker: string | undefined;

  if (pyprojectContent) {
    if (pyprojectContent.includes('[tool.pytest]')) testRunner = 'pytest';
    if (pyprojectContent.includes('[tool.ruff]')) {
      linter = 'ruff';
      formatter = 'ruff';
    }
    if (pyprojectContent.includes('[tool.mypy]')) typeChecker = 'mypy';
  }

  if (hasRuffToml && !linter) linter = 'ruff';

  return { language: 'python', testRunner, linter, formatter, typeChecker };
}

export async function detectTooling(workDir: string): Promise<DetectedTooling> {
  // Check in priority order — first match wins
  if (await fileExists(join(workDir, 'package.json'))) {
    return detectNodeTooling(workDir);
  }
  if (await fileExists(join(workDir, 'Cargo.toml'))) {
    return rustTooling();
  }
  if (await fileExists(join(workDir, 'go.mod'))) {
    return goTooling(workDir);
  }
  if (await fileExists(join(workDir, 'pyproject.toml'))) {
    return pythonTooling(workDir);
  }

  return { language: 'unknown' };
}

export function formatToolingContext(tooling: DetectedTooling): string {
  const lines: string[] = [`Language: ${tooling.language}`];

  if (tooling.testRunner) lines.push(`Test runner: ${tooling.testRunner}`);
  if (tooling.linter) lines.push(`Linter: ${tooling.linter}`);
  if (tooling.formatter) lines.push(`Formatter: ${tooling.formatter}`);
  if (tooling.typeChecker) lines.push(`Type checker: ${tooling.typeChecker}`);
  if (tooling.packageManager) lines.push(`Package manager: ${tooling.packageManager}`);

  return lines.join('\n');
}
