// Unit tests for the MCP server schema bridge (issue #311).
// Schemas are the wire contract between external MCP clients and kova waves —
// they must (a) accept the hand-written input shape per wave, (b) derive valid
// JSON Schema (draft-07) output schemas from the existing Zod result schemas,
// and (c) round-trip a sample WaveHandoff JSON without information loss.

import { describe, expect, it } from 'vitest';
import {
  getMcpServerToolName,
  getWaveInputSchema,
  getWaveOutputJsonSchema,
  KOVA_MCP_WAVES,
  type KovaMcpWave,
  parseWaveInput,
  type WaveInput,
} from './schemas.js';

describe('mcp-server/schemas — wave enumeration', () => {
  it('exports the 6 waves listed in issue #311', () => {
    // assess, spec, test, impl, quality, review — issue text lists exactly these.
    expect([...KOVA_MCP_WAVES].sort()).toEqual(['assess', 'impl', 'quality', 'review', 'spec', 'test']);
  });

  it('maps each wave to a kova.run_<wave> MCP tool name', () => {
    expect(getMcpServerToolName('assess')).toBe('kova.run_assess');
    expect(getMcpServerToolName('spec')).toBe('kova.run_spec');
    expect(getMcpServerToolName('test')).toBe('kova.run_test');
    expect(getMcpServerToolName('impl')).toBe('kova.run_impl');
    expect(getMcpServerToolName('quality')).toBe('kova.run_quality');
    expect(getMcpServerToolName('review')).toBe('kova.run_review');
  });
});

describe('mcp-server/schemas — input schemas', () => {
  const requiredFields: WaveInput = {
    handoff_context: 'previous wave output',
    user_message: 'do the thing',
    cwd: '/tmp/repo',
  };

  it.each([
    'assess',
    'spec',
    'test',
    'impl',
    'quality',
    'review',
  ] as const)('%s parses a minimal valid payload', (wave) => {
    const result = parseWaveInput(wave, requiredFields);
    expect(result.handoff_context).toBe('previous wave output');
    expect(result.user_message).toBe('do the thing');
    expect(result.cwd).toBe('/tmp/repo');
  });

  it('accepts optional issue_number, max_cost_usd, model', () => {
    const result = parseWaveInput('assess', {
      ...requiredFields,
      issue_number: 311,
      max_cost_usd: 2.5,
      model: 'anthropic:claude-sonnet-4-6',
    });
    expect(result.issue_number).toBe(311);
    expect(result.max_cost_usd).toBe(2.5);
    expect(result.model).toBe('anthropic:claude-sonnet-4-6');
  });

  it('rejects missing required fields', () => {
    // biome-ignore lint/suspicious/noExplicitAny: we intentionally pass an invalid payload to assert it rejects.
    expect(() => parseWaveInput('assess', { handoff_context: 'x' } as any)).toThrow();
  });

  it('rejects non-numeric max_cost_usd', () => {
    // biome-ignore lint/suspicious/noExplicitAny: invalid-by-design assertion.
    expect(() => parseWaveInput('assess', { ...requiredFields, max_cost_usd: 'free' } as any)).toThrow();
  });

  it('exposes the input shape as a JSON Schema for MCP tool registration', () => {
    const schema = getWaveInputSchema('assess');
    // Standard JSON Schema fields — MCP SDK requires an object schema with `properties`.
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect((schema.properties as Record<string, unknown>).handoff_context).toBeDefined();
    expect((schema.properties as Record<string, unknown>).user_message).toBeDefined();
    expect((schema.properties as Record<string, unknown>).cwd).toBeDefined();
    // `required` must list the mandatory keys so MCP clients enforce them.
    expect(schema.required).toEqual(expect.arrayContaining(['handoff_context', 'user_message', 'cwd']));
  });
});

describe('mcp-server/schemas — output schemas (auto-derived from waves.ts)', () => {
  it.each([
    'assess',
    'spec',
    'test',
    'impl',
    'quality',
    'review',
  ] as const)('%s exposes a JSON Schema derived from the Zod result schema', (wave) => {
    const schema = getWaveOutputJsonSchema(wave);
    expect(schema).toBeDefined();
    // The wave-result schemas are top-level objects.
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
  });

  it('assess output schema mirrors AssessResultSchema fields', () => {
    const schema = getWaveOutputJsonSchema('assess');
    const props = schema.properties as Record<string, unknown>;
    expect(props.grade).toBeDefined();
    expect(props.surface_area).toBeDefined();
    expect(props.risk).toBeDefined();
    expect(props.should_proceed).toBeDefined();
  });

  it('spec output schema mirrors SpecResultSchema fields', () => {
    const schema = getWaveOutputJsonSchema('spec');
    const props = schema.properties as Record<string, unknown>;
    expect(props.summary).toBeDefined();
    expect(props.pieces).toBeDefined();
    expect(props.dependency_order).toBeDefined();
  });

  it('review output schema mirrors ReviewResultSchema fields', () => {
    const schema = getWaveOutputJsonSchema('review');
    const props = schema.properties as Record<string, unknown>;
    expect(props.verdict).toBeDefined();
    expect(props.findings).toBeDefined();
    expect(props.summary).toBeDefined();
  });

  it('rejects an unsupported wave name', () => {
    // biome-ignore lint/suspicious/noExplicitAny: invalid-by-design assertion — 'brainstorm' is not in KOVA_MCP_WAVES.
    expect(() => getWaveOutputJsonSchema('brainstorm' as any as KovaMcpWave)).toThrow(/unsupported/i);
  });
});
