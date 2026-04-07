import { describe, expect, it } from 'vitest';
import type { CustomTool } from '../types/index.js';
import { buildCustomToolsSection, loadPrompt } from './prompts.js';

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
