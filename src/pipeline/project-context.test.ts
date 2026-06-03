import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectContext, type ProjectContextBudget } from './project-context.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kova-pctx-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('loadProjectContext', () => {
  describe('claudeMd', () => {
    it('reads CLAUDE.md and returns content in claudeMd field', async () => {
      await writeFile(join(workDir, 'CLAUDE.md'), '# Project\nUse strict mode.');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.claudeMd).toContain('# Project');
      expect(ctx.claudeMd).toContain('Use strict mode.');
    });

    it('returns empty string when CLAUDE.md does not exist', async () => {
      const ctx = await loadProjectContext(workDir);
      expect(ctx.claudeMd).toBe('');
    });
  });

  describe('styleConfig', () => {
    it('reads biome.json when present', async () => {
      await writeFile(join(workDir, 'biome.json'), '{"linter":{"enabled":true}}');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toContain('biome.json');
      expect(ctx.styleConfig).toContain('"linter"');
    });

    it('reads biome.jsonc when biome.json is absent', async () => {
      await writeFile(join(workDir, 'biome.jsonc'), '// biome config\n{"formatter":{}}');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toContain('biome.jsonc');
    });

    it('reads .eslintrc.json when biome configs are absent', async () => {
      await writeFile(join(workDir, '.eslintrc.json'), '{"rules":{}}');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toContain('.eslintrc.json');
    });

    it('reads .editorconfig as last resort', async () => {
      await writeFile(join(workDir, '.editorconfig'), 'root = true\n[*]\nindent_style = space');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toContain('.editorconfig');
      expect(ctx.styleConfig).toContain('indent_style');
    });

    it('respects priority: biome.json wins over .eslintrc.json', async () => {
      await writeFile(join(workDir, 'biome.json'), '{"biome":true}');
      await writeFile(join(workDir, '.eslintrc.json'), '{"eslint":true}');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toContain('biome.json');
      expect(ctx.styleConfig).not.toContain('.eslintrc.json');
    });

    it('returns empty string when no style config found', async () => {
      const ctx = await loadProjectContext(workDir);
      expect(ctx.styleConfig).toBe('');
    });
  });

  describe('ciConfig', () => {
    it('reads GitHub Actions workflow YAML files', async () => {
      await mkdir(join(workDir, '.github', 'workflows'), { recursive: true });
      await writeFile(join(workDir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\njobs: {}');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.ciConfig).toContain('ci.yml');
      expect(ctx.ciConfig).toContain('name: CI');
    });

    it('concatenates multiple workflow files with filenames', async () => {
      await mkdir(join(workDir, '.github', 'workflows'), { recursive: true });
      await writeFile(join(workDir, '.github', 'workflows', 'ci.yml'), 'name: CI');
      await writeFile(join(workDir, '.github', 'workflows', 'deploy.yaml'), 'name: Deploy');
      const ctx = await loadProjectContext(workDir);
      expect(ctx.ciConfig).toContain('ci.yml');
      expect(ctx.ciConfig).toContain('deploy.yaml');
      expect(ctx.ciConfig).toContain('name: CI');
      expect(ctx.ciConfig).toContain('name: Deploy');
    });

    it('returns empty string when .github/workflows does not exist', async () => {
      const ctx = await loadProjectContext(workDir);
      expect(ctx.ciConfig).toBe('');
    });

    it('returns empty string when workflows directory is empty', async () => {
      await mkdir(join(workDir, '.github', 'workflows'), { recursive: true });
      const ctx = await loadProjectContext(workDir);
      expect(ctx.ciConfig).toBe('');
    });
  });

  describe('truncation', () => {
    it('truncates claudeMd when exceeding token budget', async () => {
      const longContent = 'x'.repeat(50_000);
      await writeFile(join(workDir, 'CLAUDE.md'), longContent);
      const budget: ProjectContextBudget = { claudeMd: 100, styleConfig: 100, ciConfig: 100 };
      const ctx = await loadProjectContext(workDir, budget);
      expect(ctx.claudeMd).toContain('[truncated');
      expect(ctx.claudeMd.length).toBeLessThan(longContent.length);
    });

    it('truncates styleConfig when exceeding token budget', async () => {
      const longContent = 'x'.repeat(50_000);
      await writeFile(join(workDir, 'biome.json'), longContent);
      const budget: ProjectContextBudget = { claudeMd: 100, styleConfig: 100, ciConfig: 100 };
      const ctx = await loadProjectContext(workDir, budget);
      expect(ctx.styleConfig).toContain('[truncated');
    });

    it('truncates ciConfig when exceeding token budget', async () => {
      await mkdir(join(workDir, '.github', 'workflows'), { recursive: true });
      const longContent = 'x'.repeat(50_000);
      await writeFile(join(workDir, '.github', 'workflows', 'ci.yml'), longContent);
      const budget: ProjectContextBudget = { claudeMd: 100, styleConfig: 100, ciConfig: 100 };
      const ctx = await loadProjectContext(workDir, budget);
      expect(ctx.ciConfig).toContain('[truncated');
    });

    it('uses default budgets when none specified', async () => {
      const longContent = 'x'.repeat(50_000);
      await writeFile(join(workDir, 'CLAUDE.md'), longContent);
      const ctx = await loadProjectContext(workDir);
      // Default claudeMd budget is 2000 tokens — should truncate 50k chars
      expect(ctx.claudeMd).toContain('[truncated');
    });
  });

  describe('error handling', () => {
    it('returns empty strings for unreadable files', async () => {
      // Non-existent directory — should not throw
      const ctx = await loadProjectContext('/nonexistent/path/that/does/not/exist');
      expect(ctx.claudeMd).toBe('');
      expect(ctx.styleConfig).toBe('');
      expect(ctx.ciConfig).toBe('');
    });
  });

  describe('ProjectContext shape', () => {
    it('returns an object with exactly claudeMd, styleConfig, ciConfig fields', async () => {
      const ctx = await loadProjectContext(workDir);
      expect(Object.keys(ctx).sort()).toEqual(['ciConfig', 'claudeMd', 'styleConfig']);
    });
  });
});
