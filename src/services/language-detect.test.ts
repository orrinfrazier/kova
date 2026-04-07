import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DetectedTooling, detectTooling, formatToolingContext } from './language-detect.js';

describe('detectTooling', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `kova-lang-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('language detection', () => {
    it('detects TypeScript from package.json + tsconfig.json', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');

      const result = await detectTooling(workDir);
      expect(result.language).toBe('typescript');
    });

    it('detects JavaScript from package.json without tsconfig', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const result = await detectTooling(workDir);
      expect(result.language).toBe('javascript');
    });

    it('detects Rust from Cargo.toml', async () => {
      await writeFile(join(workDir, 'Cargo.toml'), '[package]\nname = "test"');

      const result = await detectTooling(workDir);
      expect(result.language).toBe('rust');
    });

    it('detects Go from go.mod', async () => {
      await writeFile(join(workDir, 'go.mod'), 'module example.com/test');

      const result = await detectTooling(workDir);
      expect(result.language).toBe('go');
    });

    it('detects Python from pyproject.toml', async () => {
      await writeFile(join(workDir, 'pyproject.toml'), '[project]\nname = "test"');

      const result = await detectTooling(workDir);
      expect(result.language).toBe('python');
    });

    it('returns unknown for empty directory', async () => {
      const result = await detectTooling(workDir);
      expect(result.language).toBe('unknown');
    });
  });

  describe('TypeScript/JavaScript tooling detection', () => {
    it('detects vitest from vitest.config.ts', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, 'vitest.config.ts'), 'export default {}');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('vitest');
    });

    it('detects vitest from package.json scripts', async () => {
      await writeFile(
        join(workDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { test: 'vitest run' } }),
      );
      await writeFile(join(workDir, 'tsconfig.json'), '{}');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('vitest');
    });

    it('detects jest from jest.config.js', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, 'jest.config.js'), 'module.exports = {}');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('jest');
    });

    it('detects biome linter', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, 'biome.json'), '{}');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('biome');
      expect(result.formatter).toBe('biome');
    });

    it('detects eslint from .eslintrc.json', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, '.eslintrc.json'), '{}');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('eslint');
    });

    it('detects eslint from eslint.config.js (flat config)', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, 'eslint.config.js'), 'export default []');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('eslint');
    });

    it('detects prettier formatter', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'tsconfig.json'), '{}');
      await writeFile(join(workDir, '.prettierrc'), '{}');

      const result = await detectTooling(workDir);
      expect(result.formatter).toBe('prettier');
    });

    it('detects pnpm package manager', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'pnpm-lock.yaml'), '');

      const result = await detectTooling(workDir);
      expect(result.packageManager).toBe('pnpm');
    });

    it('detects npm package manager', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'package-lock.json'), '{}');

      const result = await detectTooling(workDir);
      expect(result.packageManager).toBe('npm');
    });

    it('detects yarn package manager', async () => {
      await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'test' }));
      await writeFile(join(workDir, 'yarn.lock'), '');

      const result = await detectTooling(workDir);
      expect(result.packageManager).toBe('yarn');
    });
  });

  describe('Rust tooling', () => {
    it('always reports clippy/rustfmt/cargo-test', async () => {
      await writeFile(join(workDir, 'Cargo.toml'), '[package]\nname = "test"');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('cargo-test');
      expect(result.linter).toBe('clippy');
      expect(result.formatter).toBe('rustfmt');
    });
  });

  describe('Go tooling', () => {
    it('detects golangci-lint when config exists', async () => {
      await writeFile(join(workDir, 'go.mod'), 'module example.com/test');
      await writeFile(join(workDir, '.golangci.yml'), '');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('go-test');
      expect(result.linter).toBe('golangci-lint');
      expect(result.formatter).toBe('gofmt');
    });

    it('falls back to go-vet when no golangci-lint config', async () => {
      await writeFile(join(workDir, 'go.mod'), 'module example.com/test');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('go-vet');
    });
  });

  describe('Python tooling', () => {
    it('detects ruff from ruff config in pyproject.toml', async () => {
      await writeFile(join(workDir, 'pyproject.toml'), '[tool.ruff]\nline-length = 100');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('ruff');
      expect(result.formatter).toBe('ruff');
    });

    it('detects ruff from ruff.toml', async () => {
      await writeFile(join(workDir, 'pyproject.toml'), '[project]\nname = "test"');
      await writeFile(join(workDir, 'ruff.toml'), 'line-length = 100');

      const result = await detectTooling(workDir);
      expect(result.linter).toBe('ruff');
    });

    it('detects pytest from pyproject.toml', async () => {
      await writeFile(join(workDir, 'pyproject.toml'), '[tool.pytest]\nminversion = "7.0"');

      const result = await detectTooling(workDir);
      expect(result.testRunner).toBe('pytest');
    });

    it('detects mypy from pyproject.toml', async () => {
      await writeFile(join(workDir, 'pyproject.toml'), '[tool.mypy]\nstrict = true');

      const result = await detectTooling(workDir);
      expect(result.typeChecker).toBe('mypy');
    });
  });

  describe('formatToolingContext', () => {
    it('formats tooling into structured text', () => {
      const tooling: DetectedTooling = {
        language: 'typescript',
        testRunner: 'vitest',
        linter: 'biome',
        formatter: 'biome',
        packageManager: 'npm',
      };

      const context = formatToolingContext(tooling);
      expect(context).toContain('Language: typescript');
      expect(context).toContain('Test runner: vitest');
      expect(context).toContain('Linter: biome');
      expect(context).toContain('Formatter: biome');
      expect(context).toContain('Package manager: npm');
    });

    it('omits undefined fields', () => {
      const tooling: DetectedTooling = {
        language: 'rust',
        testRunner: 'cargo-test',
        linter: 'clippy',
        formatter: 'rustfmt',
      };

      const context = formatToolingContext(tooling);
      expect(context).toContain('Language: rust');
      expect(context).not.toContain('Package manager');
    });
  });
});
