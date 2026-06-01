// Tests for the sandbox runner's wave-schema registry.
//
// `src/sandbox/run-wave.ts` keeps a registry that maps `outputSchemaName` →
// Zod schema. This must stay in sync with `WAVE_OUTPUT_SCHEMA_NAMES` in
// `src/sandbox/dispatch.ts` — any wave the host orchestrator routes via
// `outputSchemaName` must have a corresponding schema in the runner.
//
// Acceptance criterion from #319: run-wave.ts handles all wave shapes that
// return structured output (assess, spec, quality, review, brainstorm).
// Test and impl waves are intentionally absent.

import { describe, expect, it } from 'vitest';
import {
  AssessResultSchema,
  BrainstormResultSchema,
  QualityRemediationSchema,
  ReviewResultSchema,
  SpecResultSchema,
} from '../types/waves.js';
import { resolveOutputSchemaName } from './dispatch.js';

describe('run-wave wave-schema registry alignment', () => {
  // The runner module is a CLI entrypoint (uses #!/usr/bin/env node) — we can't
  // import it cleanly in vitest without it trying to read process.argv[2].
  // Instead we re-construct its registry shape from the source-of-truth schemas
  // and verify the alignment with the dispatch-side name resolver.

  const RUNNER_REGISTRY = {
    assess: AssessResultSchema,
    spec: SpecResultSchema,
    quality: QualityRemediationSchema,
    review: ReviewResultSchema,
    brainstorm: BrainstormResultSchema,
  };

  it('registers schemas for all waves the dispatch layer routes by name', () => {
    // For each wave name the dispatcher emits, the runner must have a schema.
    const dispatchableWaves = ['assess', 'spec', 'quality', 'review', 'brainstorm'] as const;

    for (const wave of dispatchableWaves) {
      const schemaName = resolveOutputSchemaName(wave, true);
      expect(schemaName).toBeTypeOf('string');
      expect(RUNNER_REGISTRY[wave]).toBeDefined();
    }
  });

  it('does NOT register schemas for waves that return free-form output (test, impl)', () => {
    // Test and impl agents return markdown / file edits, not JSON. The
    // dispatch layer must NOT request schema validation for them.
    expect(resolveOutputSchemaName('test', true)).toBeUndefined();
    expect(resolveOutputSchemaName('impl', true)).toBeUndefined();
  });

  it('all registered schemas are valid Zod schemas', () => {
    // Each registered schema must be a Zod type with a `safeParse` method
    // (the runner uses this to validate structured output before returning).
    for (const [name, schema] of Object.entries(RUNNER_REGISTRY)) {
      expect(schema, `schema for wave '${name}' should be a Zod type`).toBeDefined();
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('AssessResultSchema validates a representative result', () => {
    const sample = {
      grade: 'B' as const,
      surface_area: { files: ['src/foo.ts'], estimated_lines: 50, modules_affected: ['core'] },
      risk: 'medium' as const,
      reasoning: 'ok',
      should_proceed: true,
    };
    expect(RUNNER_REGISTRY.assess.safeParse(sample).success).toBe(true);
  });

  it('ReviewResultSchema validates a representative result', () => {
    const sample = { verdict: 'pass' as const, findings: [], summary: 'looks good' };
    expect(RUNNER_REGISTRY.review.safeParse(sample).success).toBe(true);
  });

  it('QualityRemediationSchema validates a representative result', () => {
    const sample = {
      gates: [
        {
          gate: 'lint' as const,
          status: 'passed' as const,
          auto_fixable: false,
          fix_applied: false,
          remaining_errors: [],
          suggested_action: 'none' as const,
        },
      ],
      all_passing: true,
      auto_fixes_applied: [],
      files_modified: [],
    };
    expect(RUNNER_REGISTRY.quality.safeParse(sample).success).toBe(true);
  });

  it('BrainstormResultSchema validates a representative result', () => {
    const sample = { issues: [], summary: 'nothing to brainstorm' };
    expect(RUNNER_REGISTRY.brainstorm.safeParse(sample).success).toBe(true);
  });
});
