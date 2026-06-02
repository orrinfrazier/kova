// Typed handoff contract between waves.
// Every wave produces a WaveHandoff<T> written to .kova/handoffs/{wave}.json.
// Next wave consumes it with Zod validation.

import { z } from 'zod';
import { fs, path } from 'zx';
import { log } from '../utils/logger.js';

const WaveNameSchema = z.enum(['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship', 'brainstorm']);

/**
 * Per-wave structured-output extraction telemetry (issue #247).
 *
 * Captures which parse path succeeded and how many repair turns were needed,
 * so the harness can measure which models need help with structured output and
 * whether extraction improvements (fuzzy repair, conversation repair) are
 * actually doing useful work.
 *
 * `parse_method` is the canonical {@link ParseMethod} label when extraction
 * succeeded, `null` when all strategies failed.
 */
export const StructuredOutputMetricsSchema = z.object({
  /**
   * Which parse path produced the structured value (or `null` if none did).
   * One of: `json-tag`, `json-tag-repaired`, `markdown-fence`, `markdown-fence-repaired`,
   * `direct-parse`, `direct-parse-repaired`.
   */
  parse_method: z
    .enum([
      'json-tag',
      'json-tag-repaired',
      'markdown-fence',
      'markdown-fence-repaired',
      'direct-parse',
      'direct-parse-repaired',
    ])
    .nullable()
    .optional(),
  /** Total extraction attempts (initial + repair turns). */
  attempts: z.number().int().min(0),
  /** Whether extraction ultimately produced a value that passed Zod validation. */
  success: z.boolean(),
  /** Number of conversation-repair turns the wave used (0..MAX_REPAIR_ATTEMPTS). */
  repair_attempts: z.number().int().min(0),
  /** True when the parsed JSON failed schema validation on the final attempt. */
  zod_validation_failed: z.boolean().optional(),
});
export type StructuredOutputMetrics = z.infer<typeof StructuredOutputMetricsSchema>;

/**
 * INVARIANT: `WaveHandoffSchema` carries TYPED ARTIFACT FIELDS ONLY — never
 * Agent state.
 *
 * This schema is the wire contract between waves. It MUST NOT grow a
 * `messages`, `state`, `agent`, `conversation`, or any equivalently-shaped
 * field that holds raw pi-mono `Agent` data (`AssistantMessage[]`,
 * `RuntimeEvent[]`, tool-call traces, captured closures over an `Agent`
 * instance, …). Adding one would leak prior-wave Agent state into the next
 * wave and break the "fresh per wave" guarantee enforced by `spawnWaveAgent`
 * in `src/ai/wave-executor.ts`.
 *
 * What IS allowed: typed business-domain fields on the wave-specific artifact
 * payload that flows through `artifact: z.unknown()` — e.g. the `spec` wave
 * may emit `{ pieces: [...], dependency_order: [...] }`, the `assess` wave may
 * emit `{ grade, surface_area, risk_summary }`. Those are downstream-typed
 * objects, not Agent state.
 *
 * Why the distinction matters: every wave runs in a brand-new `Agent`. The
 * next wave's prompt is built from `artifact` plus a formatted context string
 * (see `buildWaveContext` in `src/pipeline/context.ts`) — never from prior
 * conversation turns. If `messages` slipped in here, `loadHandoff` /
 * `loadAllHandoffs` would silently propagate them and a downstream wave
 * could end up re-reading another wave's reasoning trace.
 *
 * Violation shapes to reject in review:
 *   - Any new field whose Zod type is `z.array(AssistantMessageSchema)` or
 *     equivalent.
 *   - Any new field named `messages`, `state`, `agent`, `conversation`,
 *     `transcript`, or `history` — regardless of declared type.
 *   - Any new field whose runtime value transitively holds a reference to
 *     the `Agent` instance from `spawnWaveAgent`.
 *
 * If a downstream wave genuinely needs more information from an upstream
 * wave, EXTEND THAT WAVE'S TYPED ARTIFACT SCHEMA (the `T` in
 * `WaveHandoff<T>`). Never widen this base schema to smuggle conversational
 * state across the boundary.
 */
export const WaveHandoffSchema = z.object({
  wave: WaveNameSchema,
  timestamp: z.string().datetime(),
  model: z.string(),
  cost: z.number(),
  turns: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  artifact: z.unknown(),
  approach_notes: z.string(),
  /**
   * True when `artifact` is the typed structured-output result (`T`).
   * False when `artifact` is the raw model string fallback (parse failure
   * or no outputFormat requested). Callers should check `parsed` before
   * treating `artifact` as `T` — replaces the legacy `typeof artifact === 'string'`
   * runtime check that proved the declared type was a lie (issue #308).
   *
   * Optional in the schema for backward-compat with persisted handoffs
   * written before this field existed. New emissions from `spawnWaveAgent`
   * always include it.
   */
  parsed: z.boolean().optional(),
  fallback_used: z.boolean().optional(),
  local_attempt_cost: z.number().optional(),
  /** Number of structured-output repair turns used (0..2). Present when outputFormat+zodSchema was set. */
  repair_attempts: z.number().int().min(0).max(2).optional(),
  /**
   * Structured-output extraction telemetry (issue #247). Populated by
   * `spawnWaveAgent` whenever `outputFormat` is set; omitted on waves that
   * don't request structured output. Backward-compat: legacy persisted
   * handoffs without this field still load.
   */
  structured_output_metrics: StructuredOutputMetricsSchema.optional(),
  /**
   * Per-wave aggregated tool-call telemetry (issue #278). Captures the
   * agent's own tool calls (Read, Grep, Edit, Bash, …) so the retrieval-quality
   * eval harness can measure whether injected context reduced retrieval cost.
   * Populated on every spawnWaveAgent run; omitted on legacy handoffs.
   */
  toolCallCounts: z
    .object({
      total: z.number().int().min(0),
      reads: z.number().int().min(0),
      byTool: z.record(z.string(), z.number().int().min(0)),
    })
    .optional(),
});

export type WaveHandoff<T = unknown> = Omit<z.infer<typeof WaveHandoffSchema>, 'artifact'> & {
  artifact: T;
};

function handoffDir(workDir: string): string {
  return path.join(workDir, '.kova', 'handoffs');
}

function handoffPath(workDir: string, wave: string): string {
  return path.join(handoffDir(workDir), `${wave}.json`);
}

export async function saveHandoff<T>(workDir: string, handoff: WaveHandoff<T>): Promise<void> {
  const dir = handoffDir(workDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(handoffPath(workDir, handoff.wave), JSON.stringify(handoff, null, 2));
  log.debug(`Handoff saved: ${handoff.wave} (confidence: ${handoff.confidence})`);
}

export async function loadHandoff<T = unknown>(workDir: string, wave: string): Promise<WaveHandoff<T> | null> {
  if (!WaveNameSchema.safeParse(wave).success) {
    log.warn(`Invalid wave name: ${wave}`);
    return null;
  }

  try {
    const content = await fs.readFile(handoffPath(workDir, wave), 'utf-8');
    const raw: unknown = JSON.parse(content);
    const result = WaveHandoffSchema.safeParse(raw);
    if (!result.success) {
      log.warn(`Invalid handoff for wave ${wave}: ${result.error.message}`);
      return null;
    }
    return result.data as WaveHandoff<T>;
  } catch {
    return null;
  }
}

export async function loadAllHandoffs(workDir: string): Promise<WaveHandoff[]> {
  const dir = handoffDir(workDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const handoffs: WaveHandoff[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const wave = entry.replace('.json', '');
    const handoff = await loadHandoff(workDir, wave);
    if (handoff) handoffs.push(handoff);
  }
  return handoffs;
}
