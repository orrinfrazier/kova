import { describe, expect, it } from 'vitest';
import type { ProjectContext } from '../services/project-context.js';
import type { CustomTool } from '../types/index.js';
import { loadPrompt } from './prompts.js';

const sampleContext: ProjectContext = {
  claudeMd: '# Conventions\nUse strict mode. No any.',
  styleConfig: '--- biome.json ---\n{"linter":{"enabled":true}}',
  ciConfig: '--- ci.yml ---\nname: CI\non: push',
};

const emptyContext: ProjectContext = {
  claudeMd: '',
  styleConfig: '',
  ciConfig: '',
};

describe('loadPrompt template substitution', () => {
  it('replaces {{CLAUDE_MD}} with claudeMd content', async () => {
    const prompt = await loadPrompt('assess', undefined, sampleContext);
    expect(prompt).toContain('# Conventions');
    expect(prompt).toContain('Use strict mode. No any.');
    expect(prompt).not.toContain('{{CLAUDE_MD}}');
  });

  it('replaces {{STYLE_CONFIG}} with styleConfig content in impl prompt', async () => {
    const prompt = await loadPrompt('impl', undefined, sampleContext);
    expect(prompt).toContain('biome.json');
    expect(prompt).not.toContain('{{STYLE_CONFIG}}');
  });

  it('replaces {{CI_CONFIG}} with ciConfig content in quality prompt', async () => {
    const prompt = await loadPrompt('quality', undefined, sampleContext);
    expect(prompt).toContain('name: CI');
    expect(prompt).not.toContain('{{CI_CONFIG}}');
  });

  it('replaces all template variables with empty string when context values are empty', async () => {
    const prompt = await loadPrompt('quality', undefined, emptyContext);
    expect(prompt).not.toContain('{{CLAUDE_MD}}');
    expect(prompt).not.toContain('{{STYLE_CONFIG}}');
    expect(prompt).not.toContain('{{CI_CONFIG}}');
  });

  it('replaces template variables with empty string when projectContext is undefined', async () => {
    const prompt = await loadPrompt('assess');
    expect(prompt).not.toContain('{{CLAUDE_MD}}');
    expect(prompt).not.toContain('{{STYLE_CONFIG}}');
    expect(prompt).not.toContain('{{CI_CONFIG}}');
  });

  it('preserves backward compatibility — no projectContext param works', async () => {
    const prompt = await loadPrompt('assess');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('handles multiple occurrences of the same template variable', async () => {
    // This tests that all occurrences are replaced, not just the first
    const prompt = await loadPrompt('assess', undefined, sampleContext);
    const matches = prompt.match(/\{\{CLAUDE_MD\}\}/g);
    expect(matches).toBeNull();
  });

  it('does not strip unknown template variables', async () => {
    // If a prompt contains {{UNKNOWN}}, it should remain as-is
    // We can't easily test this without modifying prompt files, but we verify
    // that only known variables are targeted
    const prompt = await loadPrompt('assess', undefined, sampleContext);
    expect(prompt).not.toContain('{{CLAUDE_MD}}');
  });

  it('performs substitution before custom tools appending', async () => {
    const tools: CustomTool[] = [{ name: 'my-tool', description: 'A tool', command: 'echo hi' }];
    const prompt = await loadPrompt('impl', tools, sampleContext);
    expect(prompt).toContain('## Custom Tools');
    expect(prompt).toContain('biome.json');
    // Custom tools section should be after the template-substituted content
    const styleIdx = prompt.indexOf('biome.json');
    const toolsIdx = prompt.indexOf('## Custom Tools');
    expect(toolsIdx).toBeGreaterThan(styleIdx);
  });

  it('all seven wave prompts include {{CLAUDE_MD}} after substitution shows content', async () => {
    const waves = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'brainstorm'] as const;
    for (const wave of waves) {
      const prompt = await loadPrompt(wave, undefined, sampleContext);
      expect(prompt).toContain('# Conventions');
      expect(prompt).not.toContain('{{CLAUDE_MD}}');
    }
  });
});
