import { describe, expect, it } from 'vitest';
import { loadPrompt } from './prompts.js';

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
