import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomTool } from '../types/index.js';
import {
  buildCustomToolsSection,
  exportPrompts,
  getDefaultPromptsDir,
  loadPrompt,
  resolvePromptsDir,
} from './prompts.js';

const WAVES = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'] as const;

// Patterns that indicate Claude Code-specific references not adapted for Agent SDK
const CLAUDE_CODE_PATTERNS = [
  /\$ARGUMENTS/,
  /skill frontmatter/i,
  /SKILL\.md/,
  /user-invocable/,
  /allowed-tools:/,
  /subagent_type/,
  /AskUserQuestion/,
  /---\nname:/,
];

describe('wave prompts', () => {
  for (const wave of WAVES) {
    describe(wave, () => {
      it('loads from prompts/ directory (not fallback)', async () => {
        const prompt = await loadPrompt(wave);
        // Fallback prompts are short single paragraphs; production prompts are substantial
        expect(prompt.length).toBeGreaterThan(500);
      });

      it('does not contain Claude Code-specific references', async () => {
        const prompt = await loadPrompt(wave);
        for (const pattern of CLAUDE_CODE_PATTERNS) {
          expect(prompt).not.toMatch(pattern);
        }
      });

      it('instructs the agent to read codebase files', async () => {
        const prompt = await loadPrompt(wave);
        // Each prompt should tell the agent to read/examine the codebase
        const readsCodebase =
          /read/i.test(prompt) && (/file/i.test(prompt) || /code/i.test(prompt) || /codebase/i.test(prompt));
        expect(readsCodebase).toBe(true);
      });
    });
  }
});

describe('buildCustomToolsSection', () => {
  const tools: CustomTool[] = [
    { name: 'run-migrations', description: 'Run database migrations', command: 'npm run db:migrate' },
    { name: 'seed-data', description: 'Seed test database', command: 'npm run db:seed' },
  ];

  it('includes all tool names', () => {
    const section = buildCustomToolsSection(tools);
    expect(section).toContain('run-migrations');
    expect(section).toContain('seed-data');
  });

  it('includes tool descriptions', () => {
    const section = buildCustomToolsSection(tools);
    expect(section).toContain('Run database migrations');
    expect(section).toContain('Seed test database');
  });

  it('includes tool commands', () => {
    const section = buildCustomToolsSection(tools);
    expect(section).toContain('npm run db:migrate');
    expect(section).toContain('npm run db:seed');
  });

  it('has a Custom Tools header', () => {
    const section = buildCustomToolsSection(tools);
    expect(section).toContain('## Custom Tools');
  });
});

describe('loadPrompt with custom tools', () => {
  const tools: CustomTool[] = [
    { name: 'run-migrations', description: 'Run database migrations', command: 'npm run db:migrate' },
  ];

  it('appends custom tools section to impl prompt', async () => {
    const prompt = await loadPrompt('impl', tools);
    expect(prompt).toContain('## Custom Tools');
    expect(prompt).toContain('run-migrations');
  });

  it('appends custom tools section to quality prompt', async () => {
    const prompt = await loadPrompt('quality', tools);
    expect(prompt).toContain('## Custom Tools');
    expect(prompt).toContain('run-migrations');
  });

  it('does NOT append custom tools to assess prompt', async () => {
    const prompt = await loadPrompt('assess', tools);
    expect(prompt).not.toContain('## Custom Tools');
  });

  it('does NOT append custom tools to spec prompt', async () => {
    const prompt = await loadPrompt('spec', tools);
    expect(prompt).not.toContain('## Custom Tools');
  });

  it('does NOT append custom tools to review prompt', async () => {
    const prompt = await loadPrompt('review', tools);
    expect(prompt).not.toContain('## Custom Tools');
  });

  it('does NOT append custom tools to test prompt', async () => {
    const prompt = await loadPrompt('test', tools);
    expect(prompt).not.toContain('## Custom Tools');
  });

  it('does not append when no custom tools provided', async () => {
    const prompt = await loadPrompt('impl');
    expect(prompt).not.toContain('## Custom Tools');
  });

  it('does not append for empty custom tools array', async () => {
    const prompt = await loadPrompt('impl', []);
    expect(prompt).not.toContain('## Custom Tools');
  });
});

/* ------------------------------------------------------------------ */
/*  Piece 2: loadPrompt with custom prompts dir                        */
/* ------------------------------------------------------------------ */

describe('loadPrompt with custom prompts dir', () => {
  let customDir: string;

  beforeEach(async () => {
    customDir = join(tmpdir(), `kova-custom-prompts-${Date.now()}`);
    await mkdir(customDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(customDir, { recursive: true, force: true });
  });

  it('uses custom prompt when file exists in custom dir', async () => {
    const customContent = '# Custom Assess Prompt\nDo something custom.';
    await writeFile(join(customDir, 'assess.md'), customContent);

    const prompt = await loadPrompt('assess', undefined, customDir);
    expect(prompt).toBe(customContent);
  });

  it('falls back to built-in prompt when custom file does not exist', async () => {
    // customDir exists but has no assess.md
    const prompt = await loadPrompt('assess', undefined, customDir);
    // Should still load the built-in prompt (> 500 chars)
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('replaces {{DEFAULT_PROMPT}} placeholder with built-in prompt content', async () => {
    const builtinPrompt = await loadPrompt('assess');
    const customContent = 'Before\n{{DEFAULT_PROMPT}}\nAfter';
    await writeFile(join(customDir, 'assess.md'), customContent);

    const prompt = await loadPrompt('assess', undefined, customDir);
    expect(prompt).toBe(`Before\n${builtinPrompt}\nAfter`);
  });

  it('replaces all occurrences of {{DEFAULT_PROMPT}}', async () => {
    const builtinPrompt = await loadPrompt('spec');
    const customContent = 'A: {{DEFAULT_PROMPT}}\nB: {{DEFAULT_PROMPT}}';
    await writeFile(join(customDir, 'spec.md'), customContent);

    const prompt = await loadPrompt('spec', undefined, customDir);
    expect(prompt).toBe(`A: ${builtinPrompt}\nB: ${builtinPrompt}`);
  });

  it('does not recursively expand {{DEFAULT_PROMPT}} in the default content', async () => {
    // Even if the default prompt somehow contained {{DEFAULT_PROMPT}}, it should not be expanded
    const customContent = '{{DEFAULT_PROMPT}}';
    await writeFile(join(customDir, 'assess.md'), customContent);

    const prompt = await loadPrompt('assess', undefined, customDir);
    // Should be the built-in prompt content, not an infinite expansion
    expect(prompt).not.toContain('{{DEFAULT_PROMPT}}');
  });

  it('still appends custom tools to impl prompt from custom dir', async () => {
    const tools: CustomTool[] = [{ name: 'my-tool', description: 'A tool', command: 'echo hi' }];
    const customContent = '# Custom Impl\nDo custom impl.';
    await writeFile(join(customDir, 'impl.md'), customContent);

    const prompt = await loadPrompt('impl', tools, customDir);
    expect(prompt).toContain('# Custom Impl');
    expect(prompt).toContain('## Custom Tools');
    expect(prompt).toContain('my-tool');
  });

  it('returns built-in prompt when promptsDir is undefined', async () => {
    const prompt = await loadPrompt('assess', undefined, undefined);
    expect(prompt.length).toBeGreaterThan(500);
  });
});

/* ------------------------------------------------------------------ */
/*  Piece 3: resolvePromptsDir                                         */
/* ------------------------------------------------------------------ */

describe('resolvePromptsDir', () => {
  it('resolves relative path against repo root', () => {
    const result = resolvePromptsDir('/home/user/repo', './kova-prompts');
    expect(result).toBe('/home/user/repo/kova-prompts');
  });

  it('preserves absolute paths', () => {
    const result = resolvePromptsDir('/home/user/repo', '/absolute/prompts');
    expect(result).toBe('/absolute/prompts');
  });

  it('returns undefined when promptsDir is undefined', () => {
    const result = resolvePromptsDir('/home/user/repo', undefined);
    expect(result).toBeUndefined();
  });

  it('resolves relative path without leading ./', () => {
    const result = resolvePromptsDir('/home/user/repo', 'custom-prompts');
    expect(result).toBe('/home/user/repo/custom-prompts');
  });
});

/* ------------------------------------------------------------------ */
/*  Piece 4: exportPrompts + getDefaultPromptsDir                      */
/* ------------------------------------------------------------------ */

describe('getDefaultPromptsDir', () => {
  it('returns a path that exists', async () => {
    const dir = getDefaultPromptsDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });
});

describe('exportPrompts', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `kova-export-test-${Date.now()}`);
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('creates output directory and copies all prompt files', async () => {
    const result = await exportPrompts(outputDir);

    expect(result.exported.length).toBeGreaterThanOrEqual(7);
    // All standard waves should be exported
    for (const wave of ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship']) {
      expect(result.exported).toContain(`${wave}.md`);
    }
    expect(result.skipped).toHaveLength(0);
  });

  it('exported files match built-in prompt content', async () => {
    const { readFile } = await import('node:fs/promises');
    await exportPrompts(outputDir);

    const builtinAssess = await loadPrompt('assess');
    const exportedAssess = await readFile(join(outputDir, 'assess.md'), 'utf-8');
    expect(exportedAssess).toBe(builtinAssess);
  });

  it('skips existing files without force flag', async () => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'assess.md'), 'user custom content');

    const result = await exportPrompts(outputDir);

    expect(result.skipped).toContain('assess.md');
    // Other files should still be exported
    expect(result.exported).toContain('spec.md');

    // Verify the existing file was not overwritten
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(outputDir, 'assess.md'), 'utf-8');
    expect(content).toBe('user custom content');
  });

  it('overwrites existing files with force flag', async () => {
    const { readFile } = await import('node:fs/promises');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'assess.md'), 'user custom content');

    const result = await exportPrompts(outputDir, true);

    expect(result.exported).toContain('assess.md');
    expect(result.skipped).toHaveLength(0);

    // Verify the file was overwritten with built-in content
    const content = await readFile(join(outputDir, 'assess.md'), 'utf-8');
    expect(content).not.toBe('user custom content');
    expect(content.length).toBeGreaterThan(100);
  });
});
