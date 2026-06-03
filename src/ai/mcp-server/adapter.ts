// MCP server wave adapter (issue #311).
//
// Bridges an MCP `tools/call` payload to `spawnWaveAgent` and returns the
// resulting `WaveHandoff<T>` serialized into a single `tool_result` text
// content block. The adapter is intentionally `spawnWave`-injectable so unit
// tests don't have to wire a real agent runtime.
//
// We deliberately do NOT widen the `WaveHandoff` schema here — the returned
// JSON is `JSON.stringify(handoff)` verbatim, preserving the existing wire
// contract (see `src/types/handoffs.ts`).

import type { WaveHandoff } from '../../types/index.js';
import { resolveModel } from '../models.js';
import type { SpawnWaveAgentConfig } from '../wave-executor.js';
import { spawnWaveAgent } from '../wave-executor.js';
import { getWaveTools } from '../wave-tools.js';
import { getWaveOutputJsonSchema, type KovaMcpWave, type WaveInputParsed } from './schemas.js';

/** Shape of the wave spawner the adapter calls. Real callers pass
 *  `spawnWaveAgent`; tests inject a mock. */
export type SpawnWaveFn = <T = unknown>(config: SpawnWaveAgentConfig) => Promise<WaveHandoff<T>>;

/** Minimal MCP `CallToolResult`-shaped response. We declare it locally rather
 *  than importing the SDK type so this module stays loadable from the
 *  server-side bootstrap without dragging the full SDK into the type
 *  surface of callers that only build handoff payloads. */
export interface AdapterCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface AdaptWaveCallOptions {
  /** Override the spawner. Defaults to the real `spawnWaveAgent`. */
  spawnWave?: SpawnWaveFn;
  /** Override the system prompt — primarily for tests. Defaults to a brief
   *  wave-runner instruction (the upstream wave-specific prompt is supplied
   *  by callers like /fix; in MCP mode the caller is an external orchestrator
   *  that has already composed any specialized context into `user_message`). */
  systemPromptOverride?: string;
}

const DEFAULT_SYSTEM_PROMPT_BY_WAVE: Record<KovaMcpWave, string> = {
  assess: 'You are running the kova ASSESS wave. Produce a structured AssessResult per the output schema.',
  spec: 'You are running the kova SPEC wave. Produce a structured SpecResult per the output schema.',
  test: 'You are running the kova TEST wave. Produce a structured TestResult per the output schema.',
  impl: 'You are running the kova IMPL wave. Produce a structured ImplResult per the output schema.',
  quality: 'You are running the kova QUALITY wave. Produce a structured QualityResult per the output schema.',
  review: 'You are running the kova REVIEW wave. Produce a structured ReviewResult per the output schema.',
};

/** Default to the `medium` tier (sonnet on Anthropic) when the caller does not
 *  supply an explicit `model` override. Round-trip-safe via `getModelString`.
 *  We compute lazily so the model registry is initialized at call time. */
function defaultWaveModel(): string {
  const m = resolveModel('medium');
  return `${m.provider}:${m.id}`;
}

/**
 * Adapt one MCP `tools/call` to a kova wave run. Returns the wave's
 * `WaveHandoff<T>` serialized as a single text content block. On error,
 * returns a structured `isError: true` response so the MCP client surfaces
 * the failure without losing the message.
 */
export async function adaptWaveCall(
  wave: KovaMcpWave,
  input: WaveInputParsed,
  options?: AdaptWaveCallOptions,
): Promise<AdapterCallResult> {
  const spawnFn: SpawnWaveFn = options?.spawnWave ?? (spawnWaveAgent as SpawnWaveFn);
  const systemPrompt = options?.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT_BY_WAVE[wave];
  const model = input.model ?? defaultWaveModel();

  // `getWaveTools` keys off the AI wave name. Issue #311's 6 waves are all
  // valid `AIWaveName`s (brainstorm/ship are excluded by construction).
  const tools = getWaveTools(wave, input.cwd);
  const outputSchema = getWaveOutputJsonSchema(wave);

  const config: SpawnWaveAgentConfig = {
    wave,
    model,
    tools,
    systemPrompt,
    handoffContext: input.handoff_context,
    userMessage: input.user_message,
    cwd: input.cwd,
    outputFormat: {
      type: 'json_schema',
      schema: outputSchema as Record<string, unknown>,
    },
    ...(input.max_cost_usd != null ? { maxCostUsd: input.max_cost_usd } : {}),
  };

  try {
    const handoff = await spawnFn(config);
    return {
      content: [{ type: 'text', text: JSON.stringify(handoff) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `kova.run_${wave} failed: ${message}` }],
    };
  }
}
