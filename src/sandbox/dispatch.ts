// Sandbox wave-dispatch routing.
//
// When `config.isolation === 'docker'` the orchestrator must run every wave
// (assess, spec, test, impl, quality, review, brainstorm) inside the sandbox
// container — NOT on the host. This module is the single decision point for
// that routing.
//
// Callers (`src/pipeline/fix.ts`, `src/pipeline/loops.ts`) pass an optional
// `SandboxContext`. When present, the dispatcher invokes
// `execWaveInContainer` instead of `spawnWaveAgentWithFallback` /
// `executeWaveWithRetry`. The return shapes are converted to match the
// existing in-process callers so the rest of the pipeline is unchanged.

import {
  executeWaveWithRetry,
  type FallbackWaveHandoff,
  getModelString,
  resolveWaveModel,
  type SpawnWithFallbackConfig,
  spawnWaveAgentWithFallback,
  type WaveExecutionResult,
  type WaveOptions,
} from '../ai/index.js';
import { execWaveInContainer, type SandboxWaveInput } from '../services/sandbox.js';
import type { WaveHandoff, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';

/** Sandbox routing context — when present, dispatch routes through the docker container. */
export interface SandboxContext {
  /** Container name to dispatch wave runs into via `docker exec`. */
  containerName: string;
  /** Host path of the mounted repo (the same path the container sees at /workspace). */
  repoPath: string;
  /** Override the docker CLI (for tests). */
  dockerCommand?: string;
}

/**
 * Map a `z.toJSONSchema` schema reference to the runner-side schema name.
 *
 * The host orchestrator builds the `OutputFormat` from a Zod schema. Inside the
 * container the runner re-derives the schema from a registry so the JSON wire
 * format does not need to carry a runtime Zod object.
 *
 * The mapping is wave-name → schema-name. The runner (`run-wave.ts`) keeps a
 * parallel registry. Both sides must stay in sync — any new wave-level
 * structured output schema must be registered in both places. The runner does
 * not require a schema for impl/test waves today (they return free-form
 * markdown / file edits), so those waves omit the field.
 */
const WAVE_OUTPUT_SCHEMA_NAMES: Partial<Record<WaveName, string>> = {
  assess: 'assess',
  spec: 'spec',
  quality: 'quality',
  review: 'review',
  brainstorm: 'brainstorm',
};

/** Resolve the schema name the in-container runner should use for a given wave. */
export function resolveOutputSchemaName(wave: WaveName, hasOutputFormat: boolean): string | undefined {
  if (!hasOutputFormat) return undefined;
  return WAVE_OUTPUT_SCHEMA_NAMES[wave];
}

/**
 * Spawn a wave — either in-process on the host (default) or inside the
 * docker sandbox container when a `SandboxContext` is supplied.
 *
 * Mirrors the return contract of `spawnWaveAgentWithFallback` so callers can
 * substitute this for the direct call without further branching.
 */
export async function dispatchSpawnWave<T = unknown>(
  config: SpawnWithFallbackConfig,
  sandbox?: SandboxContext | undefined,
): Promise<FallbackWaveHandoff<T>> {
  if (!sandbox) {
    return spawnWaveAgentWithFallback<T>(config);
  }

  log.info(`[sandbox] Routing wave '${config.wave}' through container ${sandbox.containerName}`);

  const input: SandboxWaveInput = {
    wave: config.wave,
    model: config.model,
    systemPrompt: config.systemPrompt,
    userMessage: config.handoffContext
      ? `${config.handoffContext}\n\n---\n\n${config.userMessage}`
      : config.userMessage,
    // The container sees the repo bind-mounted at /workspace — always use that path
    // inside the container regardless of the host cwd the caller provided.
    cwd: '/workspace',
    ...(config.thinkingLevel != null && { thinkingLevel: config.thinkingLevel }),
    ...(config.fallbackModel != null && { fallbackModel: config.fallbackModel }),
    ...(config.outputFormat != null && {
      outputSchemaName: resolveOutputSchemaName(config.wave, true),
    }),
  };

  const raw = await execWaveInContainer(sandbox.containerName, input, sandbox.repoPath, sandbox.dockerCommand);
  const handoff = raw as FallbackWaveHandoff<T>;

  // The in-container runner returns a `FallbackWaveHandoff` — preserve `fallback_used`
  // if the runner set it; default to false.
  return {
    ...handoff,
    fallback_used: handoff.fallback_used ?? false,
  };
}

/**
 * Execute a wave with retry semantics — either in-process or routed through
 * the docker sandbox container.
 *
 * Mirrors the return contract of `executeWaveWithRetry` so the loop
 * controllers can substitute this for the direct call.
 */
export async function dispatchExecuteWave(
  options: WaveOptions,
  sandbox?: SandboxContext | undefined,
  maxRetries = 2,
): Promise<WaveExecutionResult> {
  if (!sandbox) {
    return executeWaveWithRetry(options, maxRetries);
  }

  const model = resolveWaveModel(options.modelTier);
  const modelString = getModelString(model);
  const startTime = Date.now();

  log.info(`[sandbox] Routing wave '${options.wave}' through container ${sandbox.containerName} (with retry)`);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const input: SandboxWaveInput = {
        wave: options.wave,
        model: modelString,
        systemPrompt: options.systemPrompt,
        userMessage: options.userMessage,
        cwd: '/workspace',
        ...(options.thinkingLevel != null && { thinkingLevel: options.thinkingLevel }),
        ...(options.outputFormat != null && {
          outputSchemaName: resolveOutputSchemaName(options.wave, true),
        }),
      };

      const raw = await execWaveInContainer(sandbox.containerName, input, sandbox.repoPath, sandbox.dockerCommand);
      const handoff = raw as WaveHandoff;
      const duration = Date.now() - startTime;

      // Convert WaveHandoff → WaveExecutionResult so loop callers see the same shape
      // they would get from executeWaveWithRetry on the host path.
      const result: WaveExecutionResult = {
        result: typeof handoff.artifact === 'string' ? handoff.artifact : JSON.stringify(handoff.artifact),
        success: true,
        duration,
        turns: handoff.turns,
        cost: handoff.cost,
        model: handoff.model,
        provider: model.provider,
        ...(handoff.confidence === 'high' && { structuredOutput: handoff.artifact }),
      };
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = Math.min(5000 * 2 ** attempt, 60_000);
        log.warn(
          `[sandbox] Wave '${options.wave}' attempt ${attempt + 1} failed in container, retrying in ${delay / 1000}s: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted — return a failed result rather than throwing, so
  // upstream callers (which handle `result.success === false`) can decide
  // policy. This matches the host-path semantics of `executeWaveWithRetry`
  // which only throws on KovaError; for sandbox-side errors we propagate via
  // success=false instead.
  log.error(`[sandbox] Wave '${options.wave}' failed after ${maxRetries + 1} attempts: ${lastError?.message}`);
  return {
    result: null,
    success: false,
    duration: Date.now() - startTime,
    turns: 0,
    cost: 0,
    model: modelString,
    provider: model.provider,
  };
}
