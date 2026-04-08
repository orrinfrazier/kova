import { describe, expect, it } from 'vitest';
import { QualityGateResultSchema, QualityRemediationSchema } from './waves.js';

describe('QualityGateResultSchema', () => {
  it('parses a valid gate result', () => {
    const input = {
      gate: 'lint',
      status: 'passed',
      auto_fixable: false,
      fix_applied: false,
      remaining_errors: [],
      suggested_action: 'none',
    };
    const result = QualityGateResultSchema.parse(input);
    expect(result.gate).toBe('lint');
    expect(result.status).toBe('passed');
    expect(result.suggested_action).toBe('none');
  });

  it('parses a failed gate with remaining errors and suggested action', () => {
    const input = {
      gate: 'tests',
      status: 'failed',
      auto_fixable: false,
      fix_applied: false,
      remaining_errors: ['test/auth.test.ts: assertion failed at line 42'],
      suggested_action: 'retry_impl',
    };
    const result = QualityGateResultSchema.parse(input);
    expect(result.status).toBe('failed');
    expect(result.remaining_errors).toHaveLength(1);
    expect(result.suggested_action).toBe('retry_impl');
  });

  it('parses a gate where auto-fix was applied', () => {
    const input = {
      gate: 'lint',
      status: 'passed',
      auto_fixable: true,
      fix_applied: true,
      remaining_errors: [],
      suggested_action: 'none',
    };
    const result = QualityGateResultSchema.parse(input);
    expect(result.auto_fixable).toBe(true);
    expect(result.fix_applied).toBe(true);
  });

  it('accepts all valid gate names', () => {
    for (const gate of ['lint', 'typecheck', 'tests', 'coverage', 'audit', 'secrets']) {
      const input = {
        gate,
        status: 'skipped',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      };
      expect(() => QualityGateResultSchema.parse(input)).not.toThrow();
    }
  });

  it('rejects unknown gate name', () => {
    const input = {
      gate: 'unknown_gate',
      status: 'passed',
      auto_fixable: false,
      fix_applied: false,
      remaining_errors: [],
      suggested_action: 'none',
    };
    expect(() => QualityGateResultSchema.parse(input)).toThrow();
  });

  it('accepts all valid suggested_action values', () => {
    for (const action of ['none', 'retry_impl', 'manual_intervention', 'accept_known_issue']) {
      const input = {
        gate: 'lint',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: action,
      };
      expect(() => QualityGateResultSchema.parse(input)).not.toThrow();
    }
  });
});

describe('QualityRemediationSchema', () => {
  const validRemediation = {
    gates: [
      {
        gate: 'lint',
        status: 'passed',
        auto_fixable: true,
        fix_applied: true,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'typecheck',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'tests',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'coverage',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'audit',
        status: 'skipped',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
      {
        gate: 'secrets',
        status: 'passed',
        auto_fixable: false,
        fix_applied: false,
        remaining_errors: [],
        suggested_action: 'none',
      },
    ],
    all_passing: true,
    coverage_percent: 87,
    auto_fixes_applied: ['Fixed trailing comma in src/index.ts'],
    files_modified: ['src/index.ts'],
  };

  it('parses a full valid remediation plan', () => {
    const result = QualityRemediationSchema.parse(validRemediation);
    expect(result.gates).toHaveLength(6);
    expect(result.all_passing).toBe(true);
    expect(result.coverage_percent).toBe(87);
    expect(result.auto_fixes_applied).toHaveLength(1);
    expect(result.files_modified).toHaveLength(1);
  });

  it('allows optional coverage_percent', () => {
    const input = { ...validRemediation, coverage_percent: undefined };
    const result = QualityRemediationSchema.parse(input);
    expect(result.coverage_percent).toBeUndefined();
  });

  it('reports not all_passing when a gate fails', () => {
    const input = {
      ...validRemediation,
      gates: [
        ...validRemediation.gates.slice(0, 2),
        {
          gate: 'tests',
          status: 'failed',
          auto_fixable: false,
          fix_applied: false,
          remaining_errors: ['1 test failed'],
          suggested_action: 'retry_impl',
        },
        ...validRemediation.gates.slice(3),
      ],
      all_passing: false,
    };
    const result = QualityRemediationSchema.parse(input);
    expect(result.all_passing).toBe(false);
    const failedGate = result.gates.find((g) => g.gate === 'tests');
    expect(failedGate?.suggested_action).toBe('retry_impl');
  });

  it('rejects missing required fields', () => {
    expect(() => QualityRemediationSchema.parse({ gates: [] })).toThrow();
  });
});
