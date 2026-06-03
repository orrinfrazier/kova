// MCP server schema bridge (issue #311).
//
// Hand-written input schemas + auto-derived output schemas for the 6 wave
// tools exposed by the kova MCP server. Output schemas are derived from the
// existing Zod `*ResultSchema` definitions in `src/types/waves.ts` via Zod
// v4's native `z.toJSONSchema()` so they cannot drift from the types every
// other wave already speaks.
//
// Inputs are intentionally hand-written and minimal — MCP clients invoke
// these tools as one-shot RPCs over stdio, so the schema documents the
// public contract rather than internal wave plumbing.

import { z } from 'zod';
import {
  AssessResultSchema,
  ImplResultSchema,
  QualityResultSchema,
  ReviewResultSchema,
  SpecResultSchema,
  TestResultSchema,
} from '../../types/waves.js';

/** The waves the kova MCP server exposes — exactly the 6 listed in issue #311. */
export const KOVA_MCP_WAVES = ['assess', 'spec', 'test', 'impl', 'quality', 'review'] as const;
export type KovaMcpWave = (typeof KOVA_MCP_WAVES)[number];

/** Map a wave name to its `kova.run_<wave>` MCP tool name. */
export function getMcpServerToolName(wave: KovaMcpWave): string {
  return `kova.run_${wave}`;
}

/** Hand-written input schema for every wave tool.
 *  Kept identical across waves on purpose — the wave name is part of the tool
 *  name, not the payload, so external orchestrators don't have to remember a
 *  different shape per wave. */
export const WaveInputSchema = z.object({
  /** Formatted prior-wave handoff context (string) — see `buildWaveContext`. */
  handoff_context: z.string(),
  /** The wave's user message — e.g. issue body for assess, spec excerpt for impl. */
  user_message: z.string(),
  /** Absolute path the wave should treat as `$CWD`. */
  cwd: z.string(),
  /** Optional GitHub issue number — surfaces in logs and prompts. */
  issue_number: z.number().int().positive().optional(),
  /** Optional hard cap on USD spend for this wave (forwards to `SpawnWaveAgentConfig.maxCostUsd`). */
  max_cost_usd: z.number().positive().optional(),
  /** Optional `provider:modelId` override. Falls back to the wave's default tier. */
  model: z.string().optional(),
});
export type WaveInput = z.input<typeof WaveInputSchema>;
export type WaveInputParsed = z.output<typeof WaveInputSchema>;

/** Parse and validate a wave input payload. Throws on shape errors so the MCP
 *  server can return a structured `isError` response. */
export function parseWaveInput(_wave: KovaMcpWave, payload: unknown): WaveInputParsed {
  return WaveInputSchema.parse(payload);
}

/** Type alias for the JSON Schema shape we return — `zod-to-json-schema` and
 *  the MCP SDK both expect a draft-07 object schema. */
export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

/** JSON Schema for the wave input — identical across waves today, but exposed
 *  per-wave so future per-wave overrides remain a non-breaking change. */
export function getWaveInputSchema(_wave: KovaMcpWave): JsonSchemaObject {
  return z.toJSONSchema(WaveInputSchema, { target: 'draft-7' }) as JsonSchemaObject;
}

const WAVE_OUTPUT_ZOD: Record<KovaMcpWave, z.ZodTypeAny> = {
  assess: AssessResultSchema,
  spec: SpecResultSchema,
  test: TestResultSchema,
  impl: ImplResultSchema,
  quality: QualityResultSchema,
  review: ReviewResultSchema,
};

/** Auto-derived JSON Schema for the wave's structured result — sourced from
 *  the existing Zod schemas in `src/types/waves.ts` so external MCP clients
 *  and kova-internal wave runners cannot drift. */
export function getWaveOutputJsonSchema(wave: KovaMcpWave): JsonSchemaObject {
  const schema = WAVE_OUTPUT_ZOD[wave];
  if (schema == null) {
    throw new Error(`Unsupported wave: ${String(wave)}`);
  }
  return z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchemaObject;
}
