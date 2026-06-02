// Per-wave agent spawner — creates a fresh agent runtime for each pipeline wave.
// spawnWaveAgent() is the primary interface: takes resolved model string, pre-built tools,
// and explicit handoff context. Returns WaveHandoff<T>.
// executeWave() is a backward-compat wrapper that resolves model/tools internally.
//
// Agent construction goes through the kova-owned `AgentRuntimeFactory` (kova#309)
// rather than instantiating pi-mono `Agent` directly. The default factory wraps
// pi-mono today; kova#310 will extract a full `PiAgentRuntime` with event/message
// translation, and kova#NEW-13 will add a ClaudeCliRuntime alternative.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { z } from 'zod';
import type { EventBus } from '../services/event-bus/bus.js';
import type { EventWaveName } from '../services/event-bus/schema.js';
import type { WaveHandoff, WaveModelConfig, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { createTransformContext } from './context-transform.js';
import { createDestructiveEditGuard, type DestructiveEditGuardOptions } from './destructive-edit-guard.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { getModelString, resolveModelFromString, resolveWaveModel } from './models.js';
import { isOllamaProvider, resolveOllamaApiKey } from './ollama.js';
import { isRouterProvider, resolveRouterApiKey } from './router.js';
import {
  type AgentMessage,
  type AgentRuntimeFactory,
  type AssistantTurn,
  defaultAgentRuntimeFactory,
  type RuntimeAfterToolCallHook,
  type RuntimeBeforeToolCallHook,
  type RuntimeTransformContext,
  type ThinkingLevel,
} from './runtime/index.js';
import { createAfterToolCallHook, type ToolHookOptions } from './tool-hooks.js';
import { type AIWaveName, DEFAULT_THINKING_LEVELS, getWaveTools } from './wave-tools.js';

export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
  zodSchema?: z.ZodType;
}

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/**
 * Runtime type guard for the kova-owned `AssistantTurn` shape (kova#309).
 *
 * Validates the structural surface wave-executor actually reads — `role`,
 * `content` array, `usage` object. The narrower `usage.input` / `usage.cost.total`
 * fields are accessed defensively at the call sites that need them so adapters
 * that supply only one of the two (e.g. local models with no cost data) still
 * progress.
 *
 * The shape is intentionally structural so pi-mono `AssistantMessage` objects
 * (today's runtime backing) and future runtime-translated `AssistantTurn`
 * objects (post-kova#310) both pass.
 */
export function isAssistantMessage(msg: unknown): msg is AssistantTurn {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'role' in msg &&
    (msg as { role: unknown }).role === 'assistant' &&
    'content' in msg &&
    Array.isArray((msg as { content: unknown }).content) &&
    'usage' in msg &&
    typeof (msg as { usage: unknown }).usage === 'object' &&
    (msg as { usage: unknown }).usage !== null
  );
}

/**
 * Default wall-clock timeouts per wave type (ms). `undefined` means no timeout.
 *
 * Sized for large workspaces (e.g. Rust monorepos where `cargo test` compilation
 * alone takes 2-5 minutes) and local-model inference (15-30s per turn). See
 * issue #244. Override per-repo via `rules.wave_timeout` in repos.yaml (seconds).
 */
export const DEFAULT_WAVE_TIMEOUTS: Record<WaveName, number | undefined> = {
  assess: 5 * 60 * 1000,
  spec: 5 * 60 * 1000,
  review: 5 * 60 * 1000,
  brainstorm: 10 * 60 * 1000,
  test: 30 * 60 * 1000,
  impl: 30 * 60 * 1000,
  quality: 20 * 60 * 1000,
  ship: undefined,
};

type PublishWaveEvent = (
  payload:
    | { type: 'wave-enter'; wave: EventWaveName }
    | { type: 'wave-output'; wave: EventWaveName; turn: number; text?: string; costDelta?: number }
    | { type: 'cost'; wave: EventWaveName; costUsd: number }
    | { type: 'steered'; wave: EventWaveName; tier: 'steer' | 'trim' | 'abort'; usageRatio: number }
    | { type: 'aborted'; wave: EventWaveName; reason: string },
) => void;

function makeWavePublisher(
  bus: EventBus | undefined,
  context: SpawnWaveAgentConfig['eventContext'] | undefined,
  wave: WaveName,
): PublishWaveEvent {
  if (!bus || !context) {
    return () => {
      /* no-op when caller has not opted in */
    };
  }
  return (payload) => {
    // Narrow guard: 'ship' is a WaveName but not an EventWaveName. Treat as no-op.
    if (wave === ('ship' as WaveName)) return;
    bus.publish({
      runId: context.runId,
      repoId: context.repoId,
      fixId: context.fixId,
      ...(context.pieceId != null ? { pieceId: context.pieceId } : {}),
      ...payload,
    });
  };
}

export interface SpawnWaveAgentConfig {
  wave: WaveName;
  model: string;
  tools: AnyTool[];
  systemPrompt: string;
  handoffContext: string;
  userMessage: string;
  cwd: string;
  outputFormat?: OutputFormat;
  maxTurns?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
  thinkingLevel?: ThinkingLevel;
  /** Context usage threshold (0-1) — abort if input tokens exceed this fraction of contextWindow. Default: 0.9. Steer warning at 70%, aggressive trim at 80%. */
  contextThreshold?: number;
  /** Tool result truncation options. Set to configure or `false` to disable. Default: enabled with 8k token budget. */
  toolResultTruncation?: ToolHookOptions | false;
  /**
   * Optional `AgentRuntimeFactory` override (kova#309). Defaults to
   * `defaultAgentRuntimeFactory`, which wraps pi-mono `Agent`. Tests may
   * inject a mock factory; future runtimes (claude CLI, OpenAI Assistants)
   * are wired the same way.
   */
  runtimeFactory?: AgentRuntimeFactory;
  /**
   * Destructive-edit guard options. Set to configure thresholds, or `false` to disable.
   * Default: enabled with built-in thresholds (60% write ratio, 20 lines for trivial edit replacement).
   * The guard rejects Write/Edit tool calls that would delete large portions of files unless
   * `allowDestructive: true` is passed in the tool args.
   */
  destructiveEditGuard?: Omit<DestructiveEditGuardOptions, 'cwd'> | false;
  /**
   * Optional `EventBus` for structured observability events (kova#292). When
   * provided, the wave publishes `wave-enter`, `wave-output`, `steered`,
   * `aborted`, and `cost` events tagged with `eventContext`. When omitted, the
   * wave runs unchanged — no events published. Pure side-effect; never alters
   * wave outcomes.
   */
  eventBus?: EventBus;
  /**
   * Identifier tag injected into every published event. Required when
   * `eventBus` is set; ignored otherwise.
   */
  eventContext?: {
    runId: string;
    repoId: string;
    fixId: string;
    pieceId?: string;
  };
}

export async function spawnWaveAgent<T = unknown>(config: SpawnWaveAgentConfig): Promise<WaveHandoff<T>> {
  const {
    wave,
    model: modelString,
    tools,
    systemPrompt,
    handoffContext,
    userMessage,
    cwd,
    outputFormat,
    maxTurns = 5_000,
    timeoutMs: explicitTimeout,
    maxCostUsd,
    thinkingLevel: explicitThinking,
    contextThreshold: rawThreshold = 0.9,
    toolResultTruncation,
    runtimeFactory = defaultAgentRuntimeFactory,
    destructiveEditGuard,
    eventBus,
    eventContext,
  } = config;

  const timeoutMs = explicitTimeout ?? DEFAULT_WAVE_TIMEOUTS[wave];
  const thinkingLevel = explicitThinking ?? DEFAULT_THINKING_LEVELS[wave];
  const contextThreshold = Math.max(0.1, Math.min(1, rawThreshold));
  const model = resolveModelFromString(modelString);
  const startTime = Date.now();

  // Event publisher — no-op if eventBus or eventContext is missing, so callers
  // who don't opt in pay nothing and outcomes are unchanged. The wave name is
  // narrowed to the EventWaveName union; pi-mono "ship" wave never spawns an
  // agent here, so the cast is safe in practice but we guard anyway.
  const publishEvent: PublishWaveEvent = makeWavePublisher(eventBus, eventContext, wave);
  publishEvent({ type: 'wave-enter', wave: wave as EventWaveName });

  log.info(`[${wave}] Starting wave — model=${model.id}, cwd=${cwd}`);

  const effectiveSystemPrompt = outputFormat
    ? `${systemPrompt}\n\n${buildStructuredOutputInstructions(outputFormat.schema)}`
    : systemPrompt;

  const effectiveUserMessage = handoffContext ? `${handoffContext}\n\n---\n\n${userMessage}` : userMessage;

  const afterToolCallHook =
    toolResultTruncation === false ? undefined : createAfterToolCallHook(toolResultTruncation ?? undefined);

  // Destructive-edit guard: rejects Write/Edit calls that would wipe out large
  // portions of files. Only active on waves that have edit/write tools (test, impl).
  // Disabled via `destructiveEditGuard: false`; otherwise uses defaults plus any
  // caller-provided overrides.
  const beforeToolCallHook =
    destructiveEditGuard === false ? undefined : createDestructiveEditGuard({ cwd, ...(destructiveEditGuard ?? {}) });

  // Construct via the AgentRuntime factory (kova#309). The default factory
  // wraps pi-mono Agent; kova#310 will extract a full PiAgentRuntime adapter.
  //
  // `createTransformContext`, `createAfterToolCallHook`, and `createDestructiveEditGuard`
  // return pi-mono-typed functions today. They are structurally compatible with the
  // kova hooks, but cross the package boundary, so we widen at the call site (the
  // adapter narrows back to pi-mono types). Cleaned up in kova#310 when the adapter
  // owns the translation in one place.
  const agent = runtimeFactory.create({
    systemPrompt: effectiveSystemPrompt,
    model,
    thinkingLevel,
    tools,
    getApiKey: resolveApiKey,
    transformContext: createTransformContext(model.contextWindow) as unknown as RuntimeTransformContext,
    ...(afterToolCallHook && {
      afterToolCall: afterToolCallHook as unknown as RuntimeAfterToolCallHook,
    }),
    ...(beforeToolCallHook && {
      beforeToolCall: beforeToolCallHook as unknown as RuntimeBeforeToolCallHook,
    }),
  });

  let turnCount = 0;
  let aborted = false;
  let costCapExceeded = false;
  let accumulatedCost = 0;
  let contextExhausted = false;
  let contextSteered = false;
  let contextTrimmed = false;
  let lastErrorMessage: string | undefined;

  // Fixed thresholds for graceful degradation
  const STEER_THRESHOLD = 0.7;
  const TRIM_THRESHOLD = 0.8;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount % 50 === 0) {
        log.info(`[${wave}] Turn ${turnCount}...`);
      }
      const msg = event.message;
      if (isAssistantMessage(msg)) {
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          lastErrorMessage = msg.errorMessage ?? `Agent ${msg.stopReason} during ${wave}`;
        }
        // Track cost incrementally from assistant turn_end events
        const turnCost = msg.usage.cost.total;
        accumulatedCost += turnCost;
        publishEvent({
          type: 'wave-output',
          wave: wave as EventWaveName,
          turn: turnCount,
          costDelta: turnCost,
        });
        if (maxCostUsd != null && accumulatedCost >= maxCostUsd && !aborted) {
          costCapExceeded = true;
          aborted = true;
          log.warn(`[${wave}] Cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd}), aborting`);
          publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'cost_cap_exceeded' });
          agent.abort();
        }
      } else {
        const role =
          typeof msg === 'object' && msg !== null && 'role' in msg
            ? String((msg as { role: unknown }).role)
            : 'unknown';
        log.debug(`[${wave}] Skipping non-assistant turn_end message (role=${role})`);
      }

      // Context window monitoring: 3-tier graceful degradation
      // Tier 1 (70%): steer agent with focus warning
      // Tier 2 (80%): set aggressive transformContext trimming
      // Tier 3 (contextThreshold, default 90%): abort as last resort
      const inputTokens = isAssistantMessage(msg) ? msg.usage.input : 0;
      if (inputTokens > 0 && model.contextWindow > 0) {
        const usageRatio = inputTokens / model.contextWindow;
        if (usageRatio >= contextThreshold && !aborted) {
          // Tier 3: abort
          contextExhausted = true;
          aborted = true;
          log.warn(
            `[${wave}] Context exhausted ${(usageRatio * 100).toFixed(0)}% >= ${(contextThreshold * 100).toFixed(0)}% threshold (${inputTokens}/${model.contextWindow} tokens), aborting`,
          );
          publishEvent({ type: 'steered', wave: wave as EventWaveName, tier: 'abort', usageRatio });
          publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'context_exhausted' });
          agent.abort();
        } else if (usageRatio >= TRIM_THRESHOLD && !contextTrimmed) {
          // Tier 2: aggressive trimming via transformContext.
          // Runtimes that do not support transformContext reassignment will
          // collapse to Tier-3 abort at contextThreshold (no-op safe).
          contextTrimmed = true;
          log.warn(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% hit trim threshold (${inputTokens}/${model.contextWindow} tokens), enabling aggressive context compaction`,
          );
          publishEvent({ type: 'steered', wave: wave as EventWaveName, tier: 'trim', usageRatio });
          // Optional chaining is insufficient for assignment — guard explicitly.
          if ('transformContext' in agent) {
            (agent as { transformContext: typeof aggressiveTrimContext }).transformContext = aggressiveTrimContext;
          }
          // Also steer if not already done
          if (!contextSteered) {
            contextSteered = true;
            agent.steer?.({
              role: 'user',
              content:
                'Focus on completing the current task. Avoid reading additional files unless absolutely necessary.',
              timestamp: Date.now(),
            });
          }
        } else if (usageRatio >= STEER_THRESHOLD && !contextSteered) {
          // Tier 1: steer with warning. Runtimes without steer() will collapse
          // to Tier-2 trim or Tier-3 abort (no-op safe).
          contextSteered = true;
          log.info(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% hit steer threshold (${inputTokens}/${model.contextWindow} tokens), steering agent to focus`,
          );
          publishEvent({ type: 'steered', wave: wave as EventWaveName, tier: 'steer', usageRatio });
          agent.steer?.({
            role: 'user',
            content:
              'Focus on completing the current task. Avoid reading additional files unless absolutely necessary.',
            timestamp: Date.now(),
          });
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      log.debug(`[${wave}] Tool: ${event.toolName}`);
    }
    if (event.type === 'turn_end' && turnCount >= maxTurns && !aborted) {
      aborted = true;
      log.warn(`[${wave}] Max turns (${maxTurns}) reached, aborting`);
      publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'max_turns' });
      agent.abort();
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    if (timeoutMs != null) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          agent.abort();
          reject(new KovaError(`Wave ${wave} timed out after ${(timeoutMs / 1000).toFixed(0)}s`, 'agent', false));
        }, timeoutMs);
      });
      await Promise.race([agent.prompt(effectiveUserMessage), timeoutPromise]);
    } else {
      await agent.prompt(effectiveUserMessage);
    }

    // Cost cap exceeded during execution — throw before processing results
    if (costCapExceeded) {
      throw new KovaError(
        `Wave ${wave} cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd})`,
        'billing',
        false,
      );
    }

    // Helper: collect cost + last assistant text from current agent state.
    const collectState = (): { cost: number; resultText: string | null } => {
      let collected = 0;
      const stateMessages = agent.state.messages;
      for (const msg of stateMessages) {
        if (isAssistantMessage(msg)) {
          collected += msg.usage.cost.total;
        }
      }
      const last = [...stateMessages].reverse().find((m): m is AssistantTurn => isAssistantMessage(m));
      const text = last
        ? last.content
            .filter((c) => c.type === 'text' && 'text' in c)
            .map((c) => ('text' in c ? String(c.text) : ''))
            .join('')
        : null;
      return { cost: collected, resultText: text };
    };

    let { cost, resultText } = collectState();

    // Parse structured output if expected
    let structuredOutput: unknown | undefined;
    let zodValidationFailed = false;
    let lastZodErrorMessage: string | undefined;
    if (outputFormat && resultText) {
      structuredOutput = parseStructuredOutput(resultText);
      if (!structuredOutput) {
        log.warn(`[${wave}] Failed to parse structured output from response`);
      } else if (outputFormat.zodSchema) {
        const parseResult = outputFormat.zodSchema.safeParse(structuredOutput);
        if (!parseResult.success) {
          zodValidationFailed = true;
          lastZodErrorMessage = parseResult.error.message;
          log.warn(`[${wave}] Zod validation failed for structured output: ${parseResult.error.message}`);
        }
      }
    }

    // Conversation repair loop: when structured output is required (zodSchema present) and the
    // initial response either failed to parse or failed Zod validation, send a follow-up message
    // asking the model to output ONLY the corrected JSON. The model already has the right answer
    // in context — it just formatted it wrong. This is much cheaper than retrying the whole wave.
    // Max 2 repair turns before giving up.
    let repairAttempts = 0;
    while (
      outputFormat?.zodSchema != null &&
      !aborted &&
      !costCapExceeded &&
      !contextExhausted &&
      repairAttempts < MAX_REPAIR_ATTEMPTS &&
      (zodValidationFailed || structuredOutput == null)
    ) {
      repairAttempts++;
      const repairMessage = buildRepairTurnMessage(outputFormat?.schema, lastZodErrorMessage, structuredOutput == null);
      log.warn(`[${wave}] Sending repair turn ${repairAttempts}/${MAX_REPAIR_ATTEMPTS} for invalid structured output`);

      try {
        await agent.prompt(repairMessage);
      } catch (repairErr) {
        log.warn(
          `[${wave}] Repair turn ${repairAttempts} threw: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
        );
        break;
      }

      if (aborted || costCapExceeded || contextExhausted) break;

      // Re-collect state, re-parse, re-validate.
      const after = collectState();
      cost = after.cost;
      resultText = after.resultText;

      structuredOutput = resultText ? parseStructuredOutput(resultText) : undefined;
      zodValidationFailed = false;
      lastZodErrorMessage = undefined;
      if (structuredOutput && outputFormat?.zodSchema) {
        const reValidate = outputFormat.zodSchema.safeParse(structuredOutput);
        if (!reValidate.success) {
          zodValidationFailed = true;
          lastZodErrorMessage = reValidate.error.message;
          log.warn(
            `[${wave}] Repair turn ${repairAttempts} still has Zod validation failures: ${reValidate.error.message}`,
          );
        } else {
          log.info(`[${wave}] Repair turn ${repairAttempts} succeeded — structured output now valid`);
        }
      } else if (structuredOutput == null) {
        log.warn(`[${wave}] Repair turn ${repairAttempts} did not produce parseable JSON`);
      }
    }

    // Cost cap may have tripped during repair turns — re-check before proceeding.
    if (costCapExceeded) {
      throw new KovaError(
        `Wave ${wave} cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd})`,
        'billing',
        false,
      );
    }

    // Context exhaustion detected by monitoring — throw before other checks
    if (contextExhausted) {
      throw new KovaError(
        `Context window exhausted during ${wave}: usage exceeded ${(contextThreshold * 100).toFixed(0)}% of ${model.contextWindow} tokens`,
        'context',
        true,
      );
    }

    // Detect pi-mono errors reported via state or event subscription
    const piMonoError = agent.state.errorMessage ?? lastErrorMessage;
    if (piMonoError) {
      const classified = classifyError(piMonoError);
      throw new KovaError(
        `${classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'config' ? 'Config' : classified.type === 'context' ? 'Context' : 'Agent'} error during ${wave}: ${piMonoError}`,
        classified.type,
        classified.retryable,
      );
    }

    // Defense-in-depth: detect spending cap behavior
    if (isSpendingCapBehavior(turnCount, cost, resultText ?? '')) {
      throw new KovaError(`Spending cap likely reached (turns=${turnCount}, cost=$0)`, 'billing', true);
    }

    const duration = Date.now() - startTime;
    log.info(
      `[${wave}] Completed — turns=${turnCount}, cost=$${cost.toFixed(4)}, duration=${(duration / 1000).toFixed(1)}s`,
    );
    publishEvent({ type: 'cost', wave: wave as EventWaveName, costUsd: cost });

    // Determine confidence from structured output parsing + Zod validation
    let confidence: 'high' | 'medium' | 'low';
    if (structuredOutput != null && zodValidationFailed) {
      confidence = 'low';
    } else if (structuredOutput != null) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    // `parsed` discriminates the structured-success path from the string-fallback path.
    // When true, `artifact` is the typed `T` (structuredOutput). When false, `artifact`
    // is the raw model `string` (resultText). Issue #308: replaces the
    // `typeof artifact === 'string'` runtime check downstream by making the discriminator
    // explicit on the envelope. The cast below is now sound under this invariant.
    const parsed = structuredOutput != null;
    const artifact = parsed ? (structuredOutput as T) : ((resultText ?? '') as unknown as T);

    return {
      wave,
      timestamp: new Date().toISOString(),
      model: model.id,
      cost,
      turns: turnCount,
      confidence,
      parsed,
      artifact,
      approach_notes: '',
      ...(outputFormat?.zodSchema != null ? { repair_attempts: repairAttempts } : {}),
    };
  } catch (error) {
    if (error instanceof KovaError) throw error;

    const err = error instanceof Error ? error : new Error(String(error));
    const classified = classifyError(err);

    if (classified.type === 'billing' || classified.type === 'config' || classified.type === 'context') {
      const label =
        classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'context' ? 'Context' : 'Config';
      throw new KovaError(`${label} error during ${wave}: ${err.message}`, classified.type, classified.retryable);
    }

    log.error(`[${wave}] Failed — ${err.message}`);
    throw new KovaError(`Wave ${wave} failed: ${err.message}`, 'agent', false);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
    unsubscribe();
  }
}

// --- Local-to-API fallback ---

export interface SpawnWithFallbackConfig extends SpawnWaveAgentConfig {
  /** API model string to fall back to when the primary (local) model fails. */
  fallbackModel?: string | undefined;
}

export interface FallbackWaveHandoff<T = unknown> extends WaveHandoff<T> {
  /** Whether the API fallback model was used instead of the primary local model. */
  fallback_used: boolean;
  /** Cost incurred by the local model attempt (typically 0 for local models). */
  local_attempt_cost?: number | undefined;
}

/**
 * Spawn a wave agent with automatic fallback from local to API model.
 *
 * If the primary model is local (ollama, lmstudio, etc.) and fails —
 * structured output validation fails, empty result, timeout, or error —
 * automatically retries once with the API fallback model.
 *
 * Max 1 fallback attempt (no loop).
 */
export async function spawnWaveAgentWithFallback<T = unknown>(
  config: SpawnWithFallbackConfig,
): Promise<FallbackWaveHandoff<T>> {
  const { fallbackModel, ...baseConfig } = config;
  const shouldFallback = fallbackModel != null && fallbackModel !== config.model;

  try {
    const handoff = await spawnWaveAgent<T>(baseConfig);

    // Check if the result indicates a failure worth falling back from
    if (shouldFallback && needsFallback(handoff, config.outputFormat)) {
      log.warn(
        `[${config.wave}] Local model failed, falling back to API (model=${fallbackModel}): low confidence or empty result`,
      );
      const localCost = handoff.cost;
      const fallbackHandoff = await spawnWaveAgent<T>({ ...baseConfig, model: fallbackModel });
      return {
        ...fallbackHandoff,
        cost: localCost + fallbackHandoff.cost,
        fallback_used: true,
        local_attempt_cost: localCost,
      };
    }

    return { ...handoff, fallback_used: false };
  } catch (error) {
    // If the primary model threw and we can fall back, try the API model
    if (shouldFallback) {
      log.warn(
        `[${config.wave}] Local model failed, falling back to API (model=${fallbackModel}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallbackHandoff = await spawnWaveAgent<T>({ ...baseConfig, model: fallbackModel });
      return {
        ...fallbackHandoff,
        fallback_used: true,
        local_attempt_cost: 0,
      };
    }
    throw error;
  }
}

/** Determine whether a successful-but-poor-quality result warrants a fallback retry. */
function needsFallback<T>(handoff: WaveHandoff<T>, outputFormat?: OutputFormat): boolean {
  // Zod validation failed → low confidence
  if (handoff.confidence === 'low') return true;
  // Expected structured output but got nothing (medium confidence = no structured output parsed)
  if (outputFormat && handoff.confidence === 'medium') return true;
  return false;
}

// --- Backward-compat wrapper ---

export interface WaveOptions {
  wave: AIWaveName;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  modelTier: WaveModelConfig;
  outputFormat?: OutputFormat;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  customTools?: readonly import('../types/index.js').CustomTool[] | undefined;
  playwright?: { enabled: boolean } | undefined;
}

export interface WaveExecutionResult {
  result: string | null;
  success: boolean;
  duration: number;
  turns: number;
  cost: number;
  model?: string | undefined;
  provider?: string | undefined;
  structuredOutput?: unknown;
}

export async function executeWave(options: WaveOptions): Promise<WaveExecutionResult> {
  const {
    wave,
    systemPrompt,
    userMessage,
    cwd,
    modelTier,
    outputFormat,
    maxTurns,
    thinkingLevel,
    customTools,
    playwright,
  } = options;

  const model = resolveWaveModel(modelTier);
  const toolOptions = customTools || playwright ? { customTools, playwright } : undefined;
  const tools = getWaveTools(wave, cwd, toolOptions);
  const startTime = Date.now();

  try {
    const handoff = await spawnWaveAgent({
      wave,
      model: getModelString(model),
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd,
      ...(outputFormat && { outputFormat }),
      ...(maxTurns != null && { maxTurns }),
      ...(thinkingLevel != null && { thinkingLevel }),
    });

    const duration = Date.now() - startTime;

    // `parsed === false` ↔ artifact is the raw model string (issue #308 discriminator).
    // For backward compat with older handoffs that lack `parsed`, fall back to the
    // legacy `typeof artifact === 'string'` shape check.
    const artifactIsString = handoff.parsed === false || typeof handoff.artifact === 'string';
    return {
      result: artifactIsString ? (handoff.artifact as string) : JSON.stringify(handoff.artifact),
      success: true,
      duration,
      turns: handoff.turns,
      cost: handoff.cost,
      model: handoff.model,
      provider: model.provider,
      ...(handoff.confidence === 'high' && { structuredOutput: handoff.artifact }),
    };
  } catch (error) {
    if (error instanceof KovaError) throw error;

    const duration = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(`[${wave}] Failed — ${err.message} (${(duration / 1000).toFixed(1)}s)`);

    return {
      result: null,
      success: false,
      duration,
      turns: 0,
      cost: 0,
      model: model.id,
      provider: model.provider,
    };
  }
}

export async function executeWaveWithRetry(options: WaveOptions, maxRetries = 2): Promise<WaveExecutionResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await executeWave(options);

    if (result.success) return result;

    if (attempt < maxRetries) {
      const delay = Math.min(5000 * 2 ** attempt, 60_000);
      log.warn(`[${options.wave}] Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new KovaError(`Wave ${options.wave} failed after ${maxRetries + 1} attempts`, 'agent', false);
}

// --- API key resolution ---

/** Resolve the API key for a given provider. Provider-specific env vars take priority. */
export function resolveApiKey(provider: string): string | undefined {
  if (isRouterProvider(provider)) return resolveRouterApiKey();
  if (isOllamaProvider(provider)) return resolveOllamaApiKey();
  switch (provider) {
    case 'google':
      return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    default:
      return process.env.ANTHROPIC_API_KEY;
  }
}

// --- Helpers ---

export function buildStructuredOutputInstructions(schema: Record<string, unknown>): string {
  return [
    '## Required Output Format',
    '',
    'Your FINAL message must contain a valid JSON object matching this schema, wrapped in `<json>` tags:',
    '',
    '```',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'Wrap your JSON output like this:',
    '<json>',
    '{ ... your JSON here ... }',
    '</json>',
    '',
    'The `<json>` tags are REQUIRED. Do not include any text inside the tags other than the JSON object.',
  ].join('\n');
}

/** Maximum number of conversation repair turns when structured output validation fails. */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Build a follow-up user message asking the agent to re-emit valid structured output.
 *
 * The model already has its reasoning + tool reads in context — only the output formatting
 * was wrong. Asking for ONLY the corrected JSON costs a fraction of a full wave retry.
 */
export function buildRepairTurnMessage(
  schema: Record<string, unknown> | undefined,
  zodErrors: string | undefined,
  parseFailed: boolean,
): string {
  const lines: string[] = [];
  if (parseFailed) {
    lines.push("Your response didn't match the required JSON schema: no valid JSON was found in your output.");
  } else {
    lines.push("Your response didn't match the required JSON schema.", `Validation errors: ${zodErrors ?? 'unknown'}`);
  }
  if (schema) {
    lines.push('', 'Required schema:', '```json', JSON.stringify(schema, null, 2), '```');
  }
  lines.push(
    '',
    'Output ONLY the corrected JSON wrapped in <json>...</json> tags, with no other text before or after.',
  );
  return lines.join('\n');
}

/**
 * Aggressive context trimmer for when context usage exceeds 80%.
 * Keeps the first user message and the last 3 tool-result/assistant turn pairs,
 * dropping intermediate messages to free context space.
 */
async function aggressiveTrimContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  // Keep at most the first message + last 6 messages (≈ 3 turn pairs)
  const KEEP_TAIL = 6;
  if (messages.length <= KEEP_TAIL + 1) return messages;

  const head = messages.slice(0, 1);
  const tail = messages.slice(-KEEP_TAIL);
  return [...head, ...tail];
}

export function parseStructuredOutput(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // 1. Primary: extract from <json>...</json> tags
  const tagMatch = trimmed.match(/<json>([\s\S]*?)<\/json>/);
  if (tagMatch?.[1]) {
    const inner = tagMatch[1].trim();
    try {
      const result = JSON.parse(inner);
      log.debug('[parse] Extracted structured output via json-tag');
      return result;
    } catch {
      // Try repair pass before falling through
      const repaired = tryRepairParse(inner);
      if (repaired !== undefined) {
        log.debug('[parse] Extracted structured output via json-tag-repaired');
        return repaired;
      }
    }
  }

  // 2. Secondary: extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    try {
      const result = JSON.parse(inner);
      log.debug('[parse] Extracted structured output via markdown-fence');
      return result;
    } catch {
      const repaired = tryRepairParse(inner);
      if (repaired !== undefined) {
        log.debug('[parse] Extracted structured output via markdown-fence-repaired');
        return repaired;
      }
    }
  }

  // 3. Tertiary: direct JSON parse of entire text
  try {
    const result = JSON.parse(trimmed);
    log.debug('[parse] Extracted structured output via direct-parse');
    return result;
  } catch {
    const repaired = tryRepairParse(trimmed);
    if (repaired !== undefined) {
      log.debug('[parse] Extracted structured output via direct-parse-repaired');
      return repaired;
    }
  }

  // No greedy regex fallback — return undefined if none of the above worked
  return undefined;
}

/** Attempt to repair `input` then JSON.parse it. Returns undefined if still unparseable. */
function tryRepairParse(input: string): unknown | undefined {
  try {
    const repaired = repairJson(input);
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort fuzzy repair for JSON-like text produced by local LLMs.
 *
 * Repairs (in order):
 *   1. Strip markdown fence wrappers (``` or ```json with surrounding text).
 *   2. Strip JS-style `// line` and block comments outside string literals.
 *   3. Convert single-quoted strings to double-quoted (preserves apostrophes
 *      that appear inside already-double-quoted strings).
 *   4. Quote unquoted object keys (e.g. `{grade: "A"}` -> `{"grade": "A"}`).
 *   5. Remove trailing commas before `}` and `]`.
 *   6. Escape raw control characters (newline, tab, etc.) appearing inside
 *      string literals so JSON.parse will accept them.
 *   7. Balance unclosed `{` and `[` by appending closers in correct stack order.
 *
 * Idempotent on already-valid JSON. Pure function (no I/O, no throws).
 *
 * This is a fallback for malformed LLM output -- Zod validation downstream is
 * still the safety net. The repair is best-effort and may produce output that
 * JSON.parse still rejects; callers should handle that case.
 */
export function repairJson(input: string): string {
  let s = input;

  // 1. Strip markdown fence wrappers with optional surrounding text.
  //    Only applied when there is no <json>...</json> tag (callers handle that case).
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    s = fenceMatch[1].trim();
  }

  // 2. Strip JS-style comments outside string literals.
  s = stripJsCommentsOutsideStrings(s);

  // 3. Convert single-quoted strings to double-quoted (outside existing double-quoted strings).
  s = convertSingleQuotedStringsOutsideDoubleQuoted(s);

  // 4. Quote unquoted object keys.
  s = quoteUnquotedKeys(s);

  // 5. Remove trailing commas before } or ].
  s = removeTrailingCommas(s);

  // 6. Escape raw control characters appearing inside string literals.
  s = escapeRawControlCharsInStrings(s);

  // 7. Balance unclosed { and [ by appending closers in stack order.
  s = balanceBrackets(s);

  return s;
}

/** Strip `// line` and block comments outside JSON string literals. */
function stripJsCommentsOutsideStrings(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    // Skip string literals verbatim (handle both " and ' for robustness).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '/' && i + 1 < n) {
      const next = input[i + 1];
      if (next === '/') {
        // Line comment: skip until newline (newline retained).
        i += 2;
        while (i < n && input[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // Block comment: skip until */.
        i += 2;
        while (i + 1 < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Convert single-quoted string literals to double-quoted, preserving content inside existing double-quoted strings. */
function convertSingleQuotedStringsOutsideDoubleQuoted(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      // Pass through existing double-quoted string as-is.
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      // Convert single-quoted string to double-quoted.
      // Escape any " or unescaped \ in the content; unescape \'.
      out += '"';
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          const escNext = input[i + 1];
          if (escNext === "'") {
            // \' -> '
            out += "'";
          } else if (escNext === '"') {
            // \" stays as \"
            out += '\\"';
          } else {
            out += `\\${escNext}`;
          }
          i += 2;
          continue;
        }
        if (c === '"') {
          // Bare double-quote inside single-quoted string -- escape it.
          out += '\\"';
          i++;
          continue;
        }
        if (c === "'") {
          // End of single-quoted string.
          out += '"';
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Quote unquoted object keys: `{foo: 1}` -> `{"foo": 1}`. Skips already-quoted keys and string literals. */
function quoteUnquotedKeys(input: string): string {
  // Match identifier-shaped tokens that appear immediately after `{` or `,` (with optional whitespace)
  // and are followed by `:`. Use a tokenizer that respects string literals.
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '{' || ch === ',') {
      out += ch;
      i++;
      // Skip whitespace
      let j = i;
      while (j < n && /\s/.test(input[j] ?? '')) j++;
      // Check for an unquoted identifier followed by `:` (allow $ and _).
      const idMatch = input.slice(j).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (idMatch) {
        // Emit whitespace, then quoted key, then advance past the identifier.
        out += input.slice(i, j);
        out += `"${idMatch[1]}"`;
        i = j + (idMatch[1]?.length ?? 0);
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Remove trailing commas immediately before `}` or `]` (outside string literals). */
function removeTrailingCommas(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === ',') {
      // Look ahead past whitespace for } or ].
      let j = i + 1;
      while (j < n && /\s/.test(input[j] ?? '')) j++;
      if (j < n && (input[j] === '}' || input[j] === ']')) {
        // Drop the comma; emit the whitespace verbatim.
        out += input.slice(i + 1, j);
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Escape raw control characters appearing inside double-quoted string literals. */
function escapeRawControlCharsInStrings(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          out += c + input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          out += c;
          i++;
          break;
        }
        // Escape raw control chars.
        if (c === '\n') {
          out += '\\n';
        } else if (c === '\r') {
          out += '\\r';
        } else if (c === '\t') {
          out += '\\t';
        } else if (c === '\b') {
          out += '\\b';
        } else if (c === '\f') {
          out += '\\f';
        } else if (c !== undefined && c.charCodeAt(0) < 0x20) {
          // Other ASCII control chars -> \uXXXX.
          out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += c;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Append matching closers for any unclosed `{` / `[` in stack order. Respects string literals. */
function balanceBrackets(input: string): string {
  const stack: Array<'}' | ']'> = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      // Only pop if the top matches; otherwise leave the input alone (don't try to be clever).
      if (stack[stack.length - 1] === ch) stack.pop();
    }
    i++;
  }
  if (stack.length === 0) return input;
  // Trim trailing comma+whitespace before appending closers -- common LLM artifact.
  let trimmed = input.replace(/[\s,]+$/, '');
  while (stack.length > 0) {
    const closer = stack.pop();
    if (closer !== undefined) trimmed += closer;
  }
  return trimmed;
}
