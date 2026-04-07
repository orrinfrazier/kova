/**
 * Fixture repo creators — sample projects with known issues for integration testing.
 *
 * Each creator builds a minimal but realistic project in a temp directory,
 * initializes git, and returns the path + cleanup function.
 * The repos contain deliberate bugs that the kova pipeline should be able to fix.
 *
 * Usage:
 *   const repo = await createTypeScriptFixture();
 *   // ... run pipeline against repo.path ...
 *   await repo.cleanup();
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempRepo, type TempRepo } from './mock-git.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeFiles(basePath: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(basePath, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
  }
}

async function commitFiles(repoPath: string, message: string): Promise<void> {
  const { $ } = await import('zx');
  $.verbose = false;
  await $({ cwd: repoPath })`git add .`;
  await $({ cwd: repoPath })`git commit -m ${message}`;
}

// ---------------------------------------------------------------------------
// TypeScript fixture — Express-like handler with validation bug
// ---------------------------------------------------------------------------

export async function createTypeScriptFixture(): Promise<TempRepo> {
  const repo = await createTempRepo();

  await writeFiles(repo.path, {
    'package.json': JSON.stringify(
      {
        name: 'ts-fixture',
        type: 'module',
        scripts: {
          test: 'vitest run',
          lint: 'echo lint-ok',
          check: 'echo typecheck-ok',
        },
        devDependencies: { vitest: '^3.0.0', typescript: '^5.0.0' },
      },
      null,
      2,
    ),
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          outDir: 'dist',
        },
        include: ['src'],
      },
      null,
      2,
    ),
    // Bug: validateEmail accepts strings without '@'
    'src/validate.ts': [
      'export function validateEmail(email: string): boolean {',
      '  return email.length > 0;',
      '}',
      '',
      'export function sanitizeInput(input: string): string {',
      '  return input.trim();',
      '}',
    ].join('\n'),
    'src/handler.ts': [
      "import { validateEmail, sanitizeInput } from './validate.js';",
      '',
      'export interface UserInput {',
      '  email: string;',
      '  name: string;',
      '}',
      '',
      'export function processUser(input: UserInput): { valid: boolean; email: string; name: string } {',
      '  const email = sanitizeInput(input.email);',
      '  const name = sanitizeInput(input.name);',
      '  return {',
      '    valid: validateEmail(email),',
      '    email,',
      '    name,',
      '  };',
      '}',
    ].join('\n'),
    'src/index.ts': [
      "export { validateEmail, sanitizeInput } from './validate.js';",
      "export { processUser } from './handler.js';",
      "export type { UserInput } from './handler.js';",
    ].join('\n'),
  });

  await commitFiles(repo.path, 'feat: initial TypeScript project');
  return repo;
}

// ---------------------------------------------------------------------------
// Rust fixture — CLI tool with off-by-one error
// ---------------------------------------------------------------------------

export async function createRustFixture(): Promise<TempRepo> {
  const repo = await createTempRepo();

  await writeFiles(repo.path, {
    'Cargo.toml': ['[package]', 'name = "rust-fixture"', 'version = "0.1.0"', 'edition = "2021"'].join('\n'),
    // Bug: range_sum is off-by-one (excludes `to`)
    'src/lib.rs': [
      '/// Sum integers in range [from, to] inclusive.',
      '/// BUG: currently excludes `to`.',
      'pub fn range_sum(from: i64, to: i64) -> i64 {',
      '    (from..to).sum()',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    use super::*;',
      '',
      '    #[test]',
      '    fn test_range_sum_basic() {',
      '        assert_eq!(range_sum(1, 3), 6); // 1+2+3=6 but bug gives 3',
      '    }',
      '}',
    ].join('\n'),
    'src/main.rs': [
      'use rust_fixture::range_sum;',
      '',
      'fn main() {',
      '    println!("Sum 1..=10 = {}", range_sum(1, 10));',
      '}',
    ].join('\n'),
  });

  await commitFiles(repo.path, 'feat: initial Rust project');
  return repo;
}

// ---------------------------------------------------------------------------
// Go fixture — HTTP handler with missing error handling
// ---------------------------------------------------------------------------

export async function createGoFixture(): Promise<TempRepo> {
  const repo = await createTempRepo();

  await writeFiles(repo.path, {
    'go.mod': ['module go-fixture', '', 'go 1.21'].join('\n'),
    // Bug: ParseAge doesn't handle negative numbers
    'age.go': [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"strconv"',
      ')',
      '',
      'func ParseAge(s string) (int, error) {',
      '\tage, err := strconv.Atoi(s)',
      '\tif err != nil {',
      '\t\treturn 0, fmt.Errorf("parsing age: %w", err)',
      '\t}',
      '\treturn age, nil',
      '}',
    ].join('\n'),
    'age_test.go': [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestParseAge(t *testing.T) {',
      '\ttests := []struct {',
      '\t\tinput   string',
      '\t\twant    int',
      '\t\twantErr bool',
      '\t}{',
      '\t\t{"25", 25, false},',
      '\t\t{"abc", 0, true},',
      '\t\t{"-5", 0, true}, // BUG: negative ages should be rejected',
      '\t}',
      '\tfor _, tt := range tests {',
      '\t\tt.Run(tt.input, func(t *testing.T) {',
      '\t\t\tgot, err := ParseAge(tt.input)',
      '\t\t\tif (err != nil) != tt.wantErr {',
      '\t\t\t\tt.Errorf("ParseAge(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)',
      '\t\t\t}',
      '\t\t\tif got != tt.want {',
      '\t\t\t\tt.Errorf("ParseAge(%q) = %d, want %d", tt.input, got, tt.want)',
      '\t\t\t}',
      '\t\t})',
      '\t}',
      '}',
    ].join('\n'),
  });

  await commitFiles(repo.path, 'feat: initial Go project');
  return repo;
}

// ---------------------------------------------------------------------------
// Python fixture — data processing with type error
// ---------------------------------------------------------------------------

export async function createPythonFixture(): Promise<TempRepo> {
  const repo = await createTempRepo();

  await writeFiles(repo.path, {
    'pyproject.toml': [
      '[project]',
      'name = "py-fixture"',
      'version = "0.1.0"',
      'requires-python = ">=3.10"',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'),
    // Bug: calculate_average doesn't handle empty list
    'src/stats.py': [
      'def calculate_average(numbers: list[float]) -> float:',
      '    """Calculate the average of a list of numbers.',
      '    BUG: crashes with ZeroDivisionError on empty list."""',
      '    return sum(numbers) / len(numbers)',
      '',
      '',
      'def clamp(value: float, low: float, high: float) -> float:',
      '    """Clamp value to [low, high] range."""',
      '    return max(low, min(high, value))',
    ].join('\n'),
    'tests/test_stats.py': [
      'from src.stats import calculate_average, clamp',
      '',
      '',
      'def test_average_basic():',
      '    assert calculate_average([1.0, 2.0, 3.0]) == 2.0',
      '',
      '',
      'def test_average_empty():',
      '    """BUG: this test fails with ZeroDivisionError"""',
      '    assert calculate_average([]) == 0.0',
      '',
      '',
      'def test_clamp():',
      '    assert clamp(5, 0, 10) == 5',
      '    assert clamp(-1, 0, 10) == 0',
      '    assert clamp(15, 0, 10) == 10',
    ].join('\n'),
  });

  await commitFiles(repo.path, 'feat: initial Python project');
  return repo;
}
