import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAllHandoffs, loadHandoff, saveHandoff, type WaveHandoff, WaveHandoffSchema } from './handoffs.js';
import type { AssessResult, SpecResult, WaveName } from './index.js';

function makeAssessHandoff(overrides?: Partial<WaveHandoff<AssessResult>>): WaveHandoff<AssessResult> {
  return {
    wave: 'assess',
    timestamp: '2026-04-06T12:00:00.000Z',
    model: 'claude-opus-4-6',
    cost: 0.05,
    turns: 3,
    confidence: 'high',
    artifact: {
      grade: 'A',
      surface_area: { files: ['src/foo.ts'], estimated_lines: 50, modules_affected: ['foo'] },
      risk: 'low',
      reasoning: 'Simple change',
      should_proceed: true,
    },
    approach_notes: 'Straightforward implementation',
    ...overrides,
  };
}

function makeSpecHandoff(overrides?: Partial<WaveHandoff<SpecResult>>): WaveHandoff<SpecResult> {
  return {
    wave: 'spec',
    timestamp: '2026-04-06T12:01:00.000Z',
    model: 'claude-opus-4-6',
    cost: 0.08,
    turns: 5,
    confidence: 'high',
    artifact: {
      summary: 'Add a foo module',
      pieces: [
        {
          name: 'foo',
          description: 'the foo thing',
          files: ['src/foo.ts'],
          acceptance_criteria: ['it foos'],
          wiring: [],
        },
      ],
      dependency_order: [[0]],
      constraints: [],
    },
    approach_notes: 'Single piece, no deps',
    ...overrides,
  };
}

describe('WaveHandoff', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-handoff-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('WaveHandoffSchema', () => {
    it('validates a well-formed handoff', () => {
      const handoff = makeAssessHandoff();
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
    });

    it('rejects missing required fields', () => {
      const result = WaveHandoffSchema.safeParse({ wave: 'assess' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid wave name', () => {
      const handoff = makeAssessHandoff({ wave: 'bogus' as WaveName });
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(false);
    });

    it('rejects invalid confidence value', () => {
      const handoff = makeAssessHandoff({ confidence: 'maybe' as 'high' });
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(false);
    });
  });

  describe('saveHandoff', () => {
    it('writes handoff to .kova/handoffs/{wave}.json', async () => {
      const handoff = makeAssessHandoff();
      await saveHandoff(workDir, handoff);

      const content = await readFile(join(workDir, '.kova', 'handoffs', 'assess.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.wave).toBe('assess');
      expect(parsed.artifact.grade).toBe('A');
    });

    it('creates .kova/handoffs/ directory if it does not exist', async () => {
      const handoff = makeAssessHandoff();
      await saveHandoff(workDir, handoff);

      const content = await readFile(join(workDir, '.kova', 'handoffs', 'assess.json'), 'utf-8');
      expect(content).toBeTruthy();
    });

    it('overwrites existing handoff for the same wave', async () => {
      const handoff1 = makeAssessHandoff({ cost: 0.05 });
      await saveHandoff(workDir, handoff1);

      const handoff2 = makeAssessHandoff({ cost: 0.1 });
      await saveHandoff(workDir, handoff2);

      const content = await readFile(join(workDir, '.kova', 'handoffs', 'assess.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.cost).toBe(0.1);
    });
  });

  describe('loadHandoff', () => {
    it('loads and validates a saved handoff', async () => {
      const handoff = makeAssessHandoff();
      await saveHandoff(workDir, handoff);

      const loaded = await loadHandoff<AssessResult>(workDir, 'assess');
      expect(loaded).not.toBeNull();
      expect(loaded?.wave).toBe('assess');
      expect(loaded?.artifact.grade).toBe('A');
      expect(loaded?.confidence).toBe('high');
    });

    it('returns null when no handoff file exists', async () => {
      const loaded = await loadHandoff(workDir, 'assess');
      expect(loaded).toBeNull();
    });

    it('returns null when handoff file contains invalid JSON', async () => {
      await mkdir(join(workDir, '.kova', 'handoffs'), { recursive: true });
      await writeFile(join(workDir, '.kova', 'handoffs', 'assess.json'), 'not json');

      const loaded = await loadHandoff(workDir, 'assess');
      expect(loaded).toBeNull();
    });

    it('returns null when handoff fails Zod validation', async () => {
      await mkdir(join(workDir, '.kova', 'handoffs'), { recursive: true });
      await writeFile(join(workDir, '.kova', 'handoffs', 'assess.json'), JSON.stringify({ wave: 'assess', bad: true }));

      const loaded = await loadHandoff(workDir, 'assess');
      expect(loaded).toBeNull();
    });

    it('rejects invalid wave names (path traversal prevention)', async () => {
      const loaded = await loadHandoff(workDir, '../../etc/passwd');
      expect(loaded).toBeNull();
    });

    it('preserves typed artifact through save/load cycle', async () => {
      const handoff = makeSpecHandoff();
      await saveHandoff(workDir, handoff);

      const loaded = await loadHandoff<SpecResult>(workDir, 'spec');
      expect(loaded).not.toBeNull();
      expect(loaded?.artifact.pieces).toHaveLength(1);
      expect(loaded?.artifact.pieces[0]?.name).toBe('foo');
    });
  });

  describe('loadAllHandoffs', () => {
    it('returns empty array when no handoffs exist', async () => {
      const all = await loadAllHandoffs(workDir);
      expect(all).toEqual([]);
    });

    it('returns empty array when handoffs directory does not exist', async () => {
      const all = await loadAllHandoffs(workDir);
      expect(all).toEqual([]);
    });

    it('loads all saved handoffs', async () => {
      await saveHandoff(workDir, makeAssessHandoff());
      await saveHandoff(workDir, makeSpecHandoff());

      const all = await loadAllHandoffs(workDir);
      expect(all).toHaveLength(2);

      const waves = all.map((h) => h.wave);
      expect(waves).toContain('assess');
      expect(waves).toContain('spec');
    });

    it('skips invalid handoff files', async () => {
      await saveHandoff(workDir, makeAssessHandoff());
      // Write an invalid handoff
      await writeFile(join(workDir, '.kova', 'handoffs', 'test.json'), 'garbage');

      const all = await loadAllHandoffs(workDir);
      expect(all).toHaveLength(1);
      expect(all[0]?.wave).toBe('assess');
    });

    it('skips non-json files in handoffs directory', async () => {
      await saveHandoff(workDir, makeAssessHandoff());
      await writeFile(join(workDir, '.kova', 'handoffs', 'notes.txt'), 'some notes');

      const all = await loadAllHandoffs(workDir);
      expect(all).toHaveLength(1);
    });
  });
});
