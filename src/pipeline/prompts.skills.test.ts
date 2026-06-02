// Tests for loadPrompt's skills injection (issue #298).
//
// Contract:
//   - When `skills` option is undefined OR empty, prompt is unchanged from
//     pre-#298 behavior (fallback preserved)
//   - When `skills` provided + wave is in `enabledWaves`, formatSkillsForPrompt
//     output is appended to the prompt
//   - When `skills` provided + wave is NOT in `enabledWaves`, no skills section
//   - Default `enabledWaves` includes assess/spec/impl/quality/review/brainstorm

import type { Skill } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { loadPrompt } from './prompts.js';

const makeSkill = (name: string, description: string): Skill => ({
  name,
  description,
  filePath: `/fake/${name}/SKILL.md`,
  baseDir: `/fake/${name}`,
  sourceInfo: {
    // The structural fields tests touch are name/description/filePath. Provide
    // a minimal SourceInfo stub — formatSkillsForPrompt only reads filePath.
    type: 'local',
  } as unknown as Skill['sourceInfo'],
  disableModelInvocation: false,
});

describe('loadPrompt — skills injection', () => {
  it('returns identical prompt when skills option is undefined (backward compat)', async () => {
    const baseline = await loadPrompt('assess');
    const withUndef = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: undefined,
    });
    expect(withUndef).toBe(baseline);
  });

  it('returns identical prompt when skills array is empty', async () => {
    const baseline = await loadPrompt('assess');
    const withEmpty = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: { skills: [], enabledWaves: ['assess'] },
    });
    expect(withEmpty).toBe(baseline);
  });

  it('appends <available_skills> XML section when skills provided + wave enabled', async () => {
    const skills = [makeSkill('research', 'Search the web for documentation')];
    const prompt = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: { skills, enabledWaves: ['assess'] },
    });
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>research</name>');
    expect(prompt).toContain('<description>Search the web for documentation</description>');
  });

  it('does NOT append skills when wave is not in enabledWaves', async () => {
    const skills = [makeSkill('research', 'Search the web')];
    const prompt = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: { skills, enabledWaves: ['impl'] },
    });
    expect(prompt).not.toContain('<available_skills>');
    expect(prompt).not.toContain('<name>research</name>');
  });

  it('uses default enabledWaves when not specified (includes assess)', async () => {
    const skills = [makeSkill('research', 'Search the web')];
    const prompt = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: { skills },
    });
    expect(prompt).toContain('<available_skills>');
  });

  it('default enabledWaves excludes the test wave (mechanical, no skill benefit)', async () => {
    // The issue's "gated per wave" requirement means we choose a sensible default
    // set. The test wave is excluded by default because tests are purely
    // mechanical TDD red-phase work. Users can opt in via explicit enabled_waves.
    const skills = [makeSkill('research', 'Search the web')];
    const prompt = await loadPrompt('test', undefined, undefined, undefined, {
      skills: { skills },
    });
    expect(prompt).not.toContain('<available_skills>');
  });

  it('default enabledWaves excludes the ship wave (orchestrator-only)', async () => {
    const skills = [makeSkill('research', 'Search the web')];
    const prompt = await loadPrompt('ship', undefined, undefined, undefined, {
      skills: { skills },
    });
    expect(prompt).not.toContain('<available_skills>');
  });

  it('skills section is orthogonal to custom tools section', async () => {
    const skills = [makeSkill('research', 'Search the web')];
    const tools = [{ name: 'migrate', description: 'Run migrations', command: 'npm run db:migrate' }];
    const prompt = await loadPrompt('impl', tools, undefined, undefined, {
      skills: { skills, enabledWaves: ['impl'] },
    });
    expect(prompt).toContain('## Custom Tools');
    expect(prompt).toContain('<available_skills>');
    // Both sections present; their order is not contractual.
  });

  it('skips skills with disableModelInvocation=true (formatSkillsForPrompt does the filtering)', async () => {
    const visible = makeSkill('visible', 'A model-invocable skill');
    const hidden: Skill = { ...makeSkill('hidden', 'A user-only skill'), disableModelInvocation: true };
    const prompt = await loadPrompt('assess', undefined, undefined, undefined, {
      skills: { skills: [visible, hidden], enabledWaves: ['assess'] },
    });
    expect(prompt).toContain('<name>visible</name>');
    expect(prompt).not.toContain('<name>hidden</name>');
  });
});
