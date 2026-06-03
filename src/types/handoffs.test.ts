import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAllHandoffs,
  loadAssessHandoff,
  loadBrainstormHandoff,
  loadHandoff,
  loadImplHandoff,
  loadQualityHandoff,
  loadReviewHandoff,
  loadSpecHandoff,
  loadTestHandoff,
  saveHandoff,
  type WaveHandoff,
  WaveHandoffSchema,
} from './handoffs.js';
import type {
  AssessResult,
  BrainstormResult,
  ImplResult,
  QualityRemediation,
  QualityResult,
  ReviewResult,
  SpecResult,
  TestResult,
  WaveName,
} from './index.js';

function makeAssessHandoff(overrides?: Partial<WaveHandoff<AssessResult>>): WaveHandoff<AssessResult> {
  return {
    wave: 'assess',
    timestamp: '2026-04-06T12:00:00.000Z',
    model: 'claude-opus-4-6',
    cost: 0.05,
    turns: 3,
    confidence: 'high',
    parsed: true,
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
    parsed: true,
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

    it('accepts optional fallback_used field', () => {
      const handoff = { ...makeAssessHandoff(), fallback_used: true };
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fallback_used).toBe(true);
      }
    });

    it('accepts optional local_attempt_cost field', () => {
      const handoff = { ...makeAssessHandoff(), local_attempt_cost: 0.0 };
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.local_attempt_cost).toBe(0.0);
      }
    });

    it('omits fallback_used when not present (backward compat)', () => {
      const handoff = makeAssessHandoff();
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fallback_used).toBeUndefined();
      }
    });

    it('accepts handoff with parsed=true and typed artifact (structured-success path)', () => {
      const handoff = makeAssessHandoff({ parsed: true });
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parsed).toBe(true);
      }
    });

    it('accepts handoff with parsed=false and string artifact (string-fallback path)', () => {
      const handoff = {
        ...makeAssessHandoff(),
        parsed: false,
        artifact: 'raw model output that could not be parsed as JSON',
      };
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parsed).toBe(false);
        expect(typeof result.data.artifact).toBe('string');
      }
    });

    it('legacy handoff without parsed field is accepted (backward compat with persisted data)', () => {
      // Old persisted handoffs on disk pre-date the parsed field. They must still load.
      const { parsed: _omitted, ...legacy } = makeAssessHandoff();
      void _omitted;
      const result = WaveHandoffSchema.safeParse(legacy);
      expect(result.success).toBe(true);
    });

    it('accepts optional structured_output_metrics with all parse method values', () => {
      const methods = [
        'json-tag',
        'json-tag-repaired',
        'markdown-fence',
        'markdown-fence-repaired',
        'direct-parse',
        'direct-parse-repaired',
      ] as const;
      for (const method of methods) {
        const handoff = {
          ...makeAssessHandoff(),
          structured_output_metrics: {
            parse_method: method,
            attempts: 1,
            success: true,
            repair_attempts: 0,
            zod_validation_failed: false,
          },
        };
        const result = WaveHandoffSchema.safeParse(handoff);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.structured_output_metrics?.parse_method).toBe(method);
        }
      }
    });

    it('accepts structured_output_metrics with parse_method=null for unparseable output', () => {
      const handoff = {
        ...makeAssessHandoff(),
        structured_output_metrics: {
          parse_method: null,
          attempts: 1,
          success: false,
          repair_attempts: 2,
          zod_validation_failed: false,
        },
      };
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.structured_output_metrics?.success).toBe(false);
      }
    });

    it('omits structured_output_metrics when not present (backward compat)', () => {
      const handoff = makeAssessHandoff();
      const result = WaveHandoffSchema.safeParse(handoff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.structured_output_metrics).toBeUndefined();
      }
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

    it('round-trips parsed=true through save/load', async () => {
      const handoff = makeAssessHandoff({ parsed: true });
      await saveHandoff(workDir, handoff);

      const loaded = await loadHandoff<AssessResult>(workDir, 'assess');
      expect(loaded).not.toBeNull();
      expect(loaded?.parsed).toBe(true);
    });

    it('round-trips parsed=false (string-fallback) through save/load', async () => {
      const handoff: WaveHandoff = {
        wave: 'assess',
        timestamp: '2026-04-06T12:00:00.000Z',
        model: 'claude-opus-4-6',
        cost: 0.05,
        turns: 3,
        confidence: 'medium',
        parsed: false,
        artifact: 'unparseable raw output',
        approach_notes: '',
      };
      await saveHandoff(workDir, handoff);

      const loaded = await loadHandoff(workDir, 'assess');
      expect(loaded).not.toBeNull();
      expect(loaded?.parsed).toBe(false);
      expect(loaded?.artifact).toBe('unparseable raw output');
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

  // Per-wave typed loaders — issue #307.
  //
  // loadHandoff<T> is type-only; the generic T is unchecked at runtime.
  // These loaders validate the artifact against the appropriate Zod schema
  // at read time and return null when the shape doesn't match.
  describe('per-wave typed loaders', () => {
    const baseFields = {
      timestamp: '2026-04-06T12:00:00.000Z',
      model: 'claude-opus-4-6',
      cost: 0.05,
      turns: 3,
      confidence: 'high' as const,
      parsed: true,
      approach_notes: '',
    };

    function makeTestHandoff(): WaveHandoff<TestResult> {
      return {
        ...baseFields,
        wave: 'test',
        artifact: { test_files_created: ['src/foo.test.ts'], test_count: 3, all_failing: true },
      };
    }

    function makeImplHandoff(): WaveHandoff<ImplResult> {
      return {
        ...baseFields,
        wave: 'impl',
        artifact: {
          files_modified: ['src/foo.ts'],
          files_created: [],
          tests_passing: true,
          approach_notes: 'minimal change',
        },
      };
    }

    function makeQualityResultHandoff(): WaveHandoff<QualityResult> {
      return {
        ...baseFields,
        wave: 'quality',
        artifact: {
          lint: 'pass',
          typecheck: 'pass',
          tests: 'pass',
          coverage: 85,
          audit: 'pass',
          all_passing: true,
        },
      };
    }

    function makeQualityRemediationHandoff(): WaveHandoff<QualityRemediation> {
      return {
        ...baseFields,
        wave: 'quality',
        artifact: {
          gates: [
            {
              gate: 'lint',
              status: 'passed',
              auto_fixable: true,
              fix_applied: false,
              remaining_errors: [],
              suggested_action: 'none',
            },
          ],
          all_passing: true,
          coverage_percent: 85,
          auto_fixes_applied: [],
          files_modified: [],
        },
      };
    }

    function makeReviewHandoff(): WaveHandoff<ReviewResult> {
      return {
        ...baseFields,
        wave: 'review',
        artifact: { verdict: 'pass', findings: [], summary: 'looks good' },
      };
    }

    function makeBrainstormHandoff(): WaveHandoff<BrainstormResult> {
      return {
        ...baseFields,
        wave: 'brainstorm',
        artifact: { issues: [], summary: 'no issues', coverage: [] },
      };
    }

    describe('loadAssessHandoff', () => {
      it('returns the typed handoff when artifact matches AssessResultSchema', async () => {
        await saveHandoff(workDir, makeAssessHandoff());
        const loaded = await loadAssessHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.wave).toBe('assess');
        expect(loaded?.artifact.grade).toBe('A');
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadAssessHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match AssessResultSchema', async () => {
        // Mismatched shape: missing surface_area, wrong grade type
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'assess',
          artifact: { not: 'an assess result' } as unknown as AssessResult,
        });
        const loaded = await loadAssessHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact is the raw string fallback (parsed=false)', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          parsed: false,
          wave: 'assess',
          artifact: 'raw model output' as unknown as AssessResult,
        });
        const loaded = await loadAssessHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadSpecHandoff', () => {
      it('returns the typed handoff when artifact matches SpecResultSchema', async () => {
        await saveHandoff(workDir, makeSpecHandoff());
        const loaded = await loadSpecHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.artifact.pieces).toHaveLength(1);
        expect(loaded?.artifact.pieces[0]?.name).toBe('foo');
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadSpecHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match SpecResultSchema', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'spec',
          artifact: { summary: 'no pieces array' } as unknown as SpecResult,
        });
        const loaded = await loadSpecHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadTestHandoff', () => {
      it('returns the typed handoff when artifact matches TestResultSchema', async () => {
        await saveHandoff(workDir, makeTestHandoff());
        const loaded = await loadTestHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.artifact.test_count).toBe(3);
        expect(loaded?.artifact.all_failing).toBe(true);
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadTestHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match TestResultSchema', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'test',
          artifact: { test_files_created: 'not an array' } as unknown as TestResult,
        });
        const loaded = await loadTestHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadImplHandoff', () => {
      it('returns the typed handoff when artifact matches ImplResultSchema', async () => {
        await saveHandoff(workDir, makeImplHandoff());
        const loaded = await loadImplHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.artifact.tests_passing).toBe(true);
        expect(loaded?.artifact.files_modified).toEqual(['src/foo.ts']);
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadImplHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match ImplResultSchema', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'impl',
          artifact: { wrong: 'shape' } as unknown as ImplResult,
        });
        const loaded = await loadImplHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadQualityHandoff', () => {
      it('returns the typed handoff when artifact matches QualityRemediationSchema', async () => {
        await saveHandoff(workDir, makeQualityRemediationHandoff());
        const loaded = await loadQualityHandoff(workDir);
        expect(loaded).not.toBeNull();
        // Remediation has a `gates` array.
        const artifact = loaded?.artifact as QualityRemediation;
        expect(Array.isArray(artifact.gates)).toBe(true);
        expect(artifact.gates[0]?.gate).toBe('lint');
      });

      it('returns the typed handoff when artifact matches QualityResultSchema (legacy shape)', async () => {
        await saveHandoff(workDir, makeQualityResultHandoff());
        const loaded = await loadQualityHandoff(workDir);
        expect(loaded).not.toBeNull();
        const artifact = loaded?.artifact as QualityResult;
        expect(artifact.lint).toBe('pass');
        expect(artifact.all_passing).toBe(true);
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadQualityHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact matches neither QualityRemediation nor QualityResult', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'quality',
          artifact: { not: 'a quality result' } as unknown as QualityResult,
        });
        const loaded = await loadQualityHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadReviewHandoff', () => {
      it('returns the typed handoff when artifact matches ReviewResultSchema', async () => {
        await saveHandoff(workDir, makeReviewHandoff());
        const loaded = await loadReviewHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.artifact.verdict).toBe('pass');
        expect(loaded?.artifact.findings).toEqual([]);
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadReviewHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match ReviewResultSchema', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'review',
          artifact: { verdict: 'sometimes' } as unknown as ReviewResult,
        });
        const loaded = await loadReviewHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });

    describe('loadBrainstormHandoff', () => {
      it('returns the typed handoff when artifact matches BrainstormResultSchema', async () => {
        await saveHandoff(workDir, makeBrainstormHandoff());
        const loaded = await loadBrainstormHandoff(workDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.artifact.summary).toBe('no issues');
      });

      it('returns null when no handoff exists', async () => {
        const loaded = await loadBrainstormHandoff(workDir);
        expect(loaded).toBeNull();
      });

      it('returns null when artifact does not match BrainstormResultSchema', async () => {
        await saveHandoff(workDir, {
          ...baseFields,
          wave: 'brainstorm',
          artifact: { issues: 'not an array' } as unknown as BrainstormResult,
        });
        const loaded = await loadBrainstormHandoff(workDir);
        expect(loaded).toBeNull();
      });
    });
  });
});
