// Sandbox wave-dispatch routing.
//
// When `config.isolation === 'docker'` the orchestrator must run every wave
// (assess, spec, test, impl, quality, review, brainstorm) inside the sandbox
// container — NOT on the host. This module is the single decision point for
// that routing.
//
// Callers (`src/pipeline/fix.ts`, `src/pipeline/loops.ts`) pass an optional
// `SandboxContext`. When present, the dispatcher invokes either
// `backend.execWave()` (preferred when `sandbox.backend` is set — see #379)
// or the legacy `execWaveInContainer` (for Docker callers that pass only
// `containerName`+`repoPath`). The return shapes are converted to match the
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
import type { SandboxBackend, SandboxBackendWaveInput } from './backend.js';

/** Sandbox routing context — when present, dispatch routes through the docker container or a SandboxBackend. */
export interface SandboxContext {
  /** Container name to dispatch wave runs into via `docker exec`. */
  containerName: string;
  /** Host path of the mounted repo (the same path the container sees at /workspace). */
  repoPath: string;
  /** Override the docker CLI (for tests). */
  dockerCommand?: string;
  /**
   * Pluggable backend (issue #379). When set, dispatch routes wave execution
   * through `backend.execWave()` instead of `execWaveInContainer`. This is how
   * non-Docker backends (Daytona, Modal, Fly.io, e2b) own wave dispatch end-to-end
   * rather than falling back to `docker exec` against a remote workspace name.
   *
   * Docker callers omit this field and keep the legacy `execWaveInContainer`
   * path — bit-for-bit identical behavior. Both branches converge on the same
   * `FallbackWaveHandoff` / `WaveExecutionResult` return shape.
   */
  backend?: SandboxBackend;
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
 * Build the wire input passed to the sandbox executor (docker-exec or
 * `backend.execWave()`). Centralized so both routing paths produce identical
 * shapes — the runner inside the sandbox doesn't care which path the host took.
 *
 * Issue #306 — `mcpServers` / `mcpWaveOverrides` ride along when the host
 * orchestrator resolved them. The runner uses them to start MCP servers
 * inside the sandbox on /workspace so codegraph (and other MCP servers) are
 * available to sandboxed waves without any host round-trip.
 */
function buildSpawnInput(config: SpawnWithFallbackConfig): SandboxWaveInput {
  return {
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
    ...(config.mcpServers != null && Object.keys(config.mcpServers).length > 0
      ? { mcpServers: config.mcpServers }
      : {}),
    ...(config.mcpWaveOverrides != null && { mcpWaveOverrides: config.mcpWaveOverrides }),
  };
}

/**
 * Spawn a wave — host (default), pluggable `SandboxBackend.execWave()` when
 * `sandbox.backend` is supplied (issue #379), or legacy docker-exec when only
 * `containerName`+`repoPath` are supplied.
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

  const input = buildSpawnInput(config);
  let raw: unknown;

  if (sandbox.backend != null) {
    log.info(`[sandbox] Routing wave '${config.wave}' through backend.execWave (workspace ${sandbox.containerName})`);
    // SandboxBackendWaveInput has the same runtime shape as SandboxWaveInput — the
    // interface alias just keeps the backend abstraction independent of the
    // services/sandbox.ts wire type. Pass the same object both paths see.
    raw = await sandbox.backend.execWave(input as SandboxBackendWaveInput);
  } else {
    log.info(`[sandbox] Routing wave '${config.wave}' through container ${sandbox.containerName}`);
    raw = await execWaveInContainer(sandbox.containerName, input, sandbox.repoPath, sandbox.dockerCommand);
  }

  const handoff = raw as FallbackWaveHandoff<T>;

  // The in-container runner returns a `FallbackWaveHandoff` — preserve `fallback_used`
  // if the runner set it; default to false.
  return {
    ...handoff,
    fallback_used: handoff.fallback_used ?? false,
  };
}

/**
 * Execute a wave with retry semantics — host (default), pluggable
 * `SandboxBackend.execWave()` when `sandbox.backend` is supplied (issue #379),
 * or legacy docker-exec when only `containerName`+`repoPath` are supplied.
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

  const usingBackend = sandbox.backend != null;
  const routeLabel = usingBackend
    ? `backend.execWave (workspace ${sandbox.containerName})`
    : `container ${sandbox.containerName}`;
  log.info(`[sandbox] Routing wave '${options.wave}' through ${routeLabel} (with retry)`);

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
        // Issue #306 — forward MCP server config + wave overrides through the
        // sandbox boundary so the in-container runner can start codegraph and
        // friends on /workspace.
        ...(options.mcpServers != null && Object.keys(options.mcpServers).length > 0
          ? { mcpServers: options.mcpServers }
          : {}),
        ...(options.mcpWaveOverrides != null && { mcpWaveOverrides: options.mcpWaveOverrides }),
      };

      const raw = usingBackend
        ? // SandboxBackendWaveInput and SandboxWaveInput have identical runtime shape;
          // the interface alias keeps the backend abstraction free of the docker-side
          // services/sandbox.ts type.
          await (sandbox.backend as SandboxBackend).execWave(input as SandboxBackendWaveInput)
        : await execWaveInContainer(sandbox.containerName, input, sandbox.repoPath, sandbox.dockerCommand);
      const handoff = raw as WaveHandoff;
      const duration = Date.now() - startTime;

      // Convert WaveHandoff → WaveExecutionResult so loop callers see the same shape
      // they would get from executeWaveWithRetry on the host path.
      // `parsed === false` ↔ artifact is the raw model string (issue #308 discriminator).
      // Fall back to the legacy `typeof artifact === 'string'` check for older handoffs.
      const artifactIsString = handoff.parsed === false || typeof handoff.artifact === 'string';
      const result: WaveExecutionResult = {
        result: artifactIsString ? (handoff.artifact as string) : JSON.stringify(handoff.artifact),
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
