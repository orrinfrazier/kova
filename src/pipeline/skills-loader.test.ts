// Tests for loadWaveSkills — kova's wrapper around pi-mono's loadSkillsFromDir.
//
// Behavior contract:
//   - Discovers SKILL.md files from configured dirs
//   - Expands `~` to $HOME
//   - Resolves relative paths against `cwd`
//   - Missing dirs → empty result, no throw, optional warning log
//   - Dedupes by skill name (first-win, so ~/.claude wins over per-repo overrides
//     when listed first — matches the issue's "default ~/.claude/skills + per-repo
//     .kova/skills" ordering)

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWaveSkills } from './skills-loader.js';

const skillMd = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody for ${name}.\n`;

describe('loadWaveSkills', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `kova-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns empty array when all configured dirs are missing', async () => {
    const skills = await loadWaveSkills({
      dirs: [join(tmp, 'nope'), join(tmp, 'also-nope')],
      cwd: tmp,
    });
    expect(skills).toEqual([]);
  });

  it('returns empty array when dirs list is empty', async () => {
    const skills = await loadWaveSkills({ dirs: [], cwd: tmp });
    expect(skills).toEqual([]);
  });

  it('discovers SKILL.md files inside subdirectories of a configured dir', async () => {
    const dir = join(tmp, 'skills');
    await mkdir(join(dir, 'alpha'), { recursive: true });
    await mkdir(join(dir, 'beta'), { recursive: true });
    await writeFile(join(dir, 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha skill'));
    await writeFile(join(dir, 'beta', 'SKILL.md'), skillMd('beta', 'Beta skill'));

    const skills = await loadWaveSkills({ dirs: [dir], cwd: tmp });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('resolves relative dir paths against cwd', async () => {
    const dir = join(tmp, '.kova', 'skills');
    await mkdir(join(dir, 'gamma'), { recursive: true });
    await writeFile(join(dir, 'gamma', 'SKILL.md'), skillMd('gamma', 'Gamma skill'));

    const skills = await loadWaveSkills({
      dirs: ['.kova/skills'],
      cwd: tmp,
    });
    expect(skills.map((s) => s.name)).toEqual(['gamma']);
  });

  it('expands ~ to $HOME', async () => {
    // We cannot safely write under $HOME during tests, so we just verify the
    // function does not throw and tolerates a missing ~/.claude/skills dir.
    const skills = await loadWaveSkills({
      dirs: ['~/this-path-should-not-exist-kova-test'],
      cwd: tmp,
    });
    expect(skills).toEqual([]);
  });

  it('exposes the resolved $HOME (sanity: ~ is not passed through verbatim)', async () => {
    // Build a fake "~/something" by creating it under homedir, then reading via ~.
    const home = homedir();
    const tag = `kova-test-${Date.now()}`;
    const fakeHomeDir = join(home, tag, 'skills');
    try {
      await mkdir(join(fakeHomeDir, 'delta'), { recursive: true });
      await writeFile(join(fakeHomeDir, 'delta', 'SKILL.md'), skillMd('delta', 'Delta skill'));

      const skills = await loadWaveSkills({
        dirs: [`~/${tag}/skills`],
        cwd: tmp,
      });
      expect(skills.map((s) => s.name)).toContain('delta');
    } finally {
      await rm(join(home, tag), { recursive: true, force: true });
    }
  });

  it('dedupes by skill name (first dir wins)', async () => {
    const dirA = join(tmp, 'a');
    const dirB = join(tmp, 'b');
    await mkdir(join(dirA, 'shared'), { recursive: true });
    await mkdir(join(dirB, 'shared'), { recursive: true });
    await writeFile(join(dirA, 'shared', 'SKILL.md'), skillMd('shared', 'From A'));
    await writeFile(join(dirB, 'shared', 'SKILL.md'), skillMd('shared', 'From B'));

    const skills = await loadWaveSkills({ dirs: [dirA, dirB], cwd: tmp });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('From A');
  });

  it('merges distinct skills from multiple dirs', async () => {
    const dirA = join(tmp, 'a');
    const dirB = join(tmp, 'b');
    await mkdir(join(dirA, 'one'), { recursive: true });
    await mkdir(join(dirB, 'two'), { recursive: true });
    await writeFile(join(dirA, 'one', 'SKILL.md'), skillMd('one', 'One skill'));
    await writeFile(join(dirB, 'two', 'SKILL.md'), skillMd('two', 'Two skill'));

    const skills = await loadWaveSkills({ dirs: [dirA, dirB], cwd: tmp });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('skips skills with missing description (logged via diagnostics, not thrown)', async () => {
    const dir = join(tmp, 'skills');
    await mkdir(join(dir, 'bad'), { recursive: true });
    await writeFile(join(dir, 'bad', 'SKILL.md'), '---\nname: bad\n---\n\n# Bad\n');

    const skills = await loadWaveSkills({ dirs: [dir], cwd: tmp });
    expect(skills).toEqual([]);
  });
});
