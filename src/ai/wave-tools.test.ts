import { describe, expect, it } from 'vitest';
import type { WaveName } from '../types/index.js';
import { getWaveTools, WAVE_TOOLS } from './wave-tools.js';

describe('WAVE_TOOLS', () => {
  it('defines tool sets for all seven waves', () => {
    const waves: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];
    for (const wave of waves) {
      expect(WAVE_TOOLS[wave]).toBeDefined();
      expect(WAVE_TOOLS[wave].length).toBeGreaterThan(0);
    }
  });

  it('assess wave has read-only tools: read, find, grep', () => {
    expect(WAVE_TOOLS.assess).toEqual(['read', 'find', 'grep']);
  });

  it('spec wave has read-only tools: read, find, grep', () => {
    expect(WAVE_TOOLS.spec).toEqual(['read', 'find', 'grep']);
  });

  it('test wave has coding tools: read, write, edit, bash', () => {
    expect(WAVE_TOOLS.test).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('impl wave has coding tools: read, write, edit, bash', () => {
    expect(WAVE_TOOLS.impl).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('quality wave has bash and read', () => {
    expect(WAVE_TOOLS.quality).toEqual(['bash', 'read']);
  });

  it('review wave has read-only subset: read, grep', () => {
    expect(WAVE_TOOLS.review).toEqual(['read', 'grep']);
  });

  it('ship wave has bash only', () => {
    expect(WAVE_TOOLS.ship).toEqual(['bash']);
  });

  it('read-only waves do not include write, edit, or bash', () => {
    const readOnlyWaves: WaveName[] = ['assess', 'spec', 'review'];
    const writeTools = ['write', 'edit', 'bash'];
    for (const wave of readOnlyWaves) {
      for (const tool of writeTools) {
        expect(WAVE_TOOLS[wave]).not.toContain(tool);
      }
    }
  });
});

describe('getWaveTools', () => {
  it('returns an array of Tool objects for a given wave', () => {
    const tools = getWaveTools('assess', '/tmp');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(WAVE_TOOLS.assess.length);
  });

  it('returns tools with correct names matching the wave config', () => {
    const tools = getWaveTools('test', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.test);
  });

  it('returns different tool sets for different waves', () => {
    const assessTools = getWaveTools('assess', '/tmp');
    const implTools = getWaveTools('impl', '/tmp');
    const assessNames = assessTools.map((t) => t.name);
    const implNames = implTools.map((t) => t.name);
    expect(assessNames).not.toEqual(implNames);
  });

  it('assess tools cannot write or execute', () => {
    const tools = getWaveTools('assess', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('bash');
  });

  it('review tools cannot write or execute', () => {
    const tools = getWaveTools('review', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('bash');
  });
});
