// Per-wave agent spawner — creates a fresh pi-mono Agent for each pipeline wave.
// spawnWaveAgent() is the primary interface: takes resolved model string, pre-built tools,
// and explicit handoff context. Returns WaveHandoff<T>.
// executeWave() is a backward-compat wrapper that resolves model/tools internally.

import { Agent, type AgentTool, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import { type AssistantMessage, streamSimple } from '@mariozechner/pi-ai';
import { convertToLlm } from '@mariozechner/pi-coding-agent';
import type { z } from 'zod';
import type { WaveHandoff, WaveModelConfig, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { isLocalModel, resolveModelFromString, resolveWaveModel } from './models.js';
import { isOllamaProvider, resolveOllamaApiKey } from './ollama.js';
import { type AIWaveName, DEFAULT_THINKING_LEVELS, getWaveTools } from './wave-tools.js';

/** Provider-aware API key resolution. Maps provider names to their environment variable. */
const PROVIDER_KEY_MAP: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/** Resolve API key for a provider. Known providers map to their env var; unknown falls back to ANTHROPIC_API_KEY. */
export function resolveApiKey(provider: string): string | undefined {
  if (isOllamaProvider(provider)) {
    return resolveOllamaApiKey();
  }
  const envVar = PROVIDER_KEY_MAP[provider] ?? 'ANTHROPIC_API_KEY';
  return process.env[envVar];
}

export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
  zodSchema?: z.ZodType;
}

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/** Runtime type guard for pi-mono AssistantMessage — validates shape instead of unsafe `as` casts. */
export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
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

/** Default wall-clock timeouts per wave type (ms). `undefined` means no timeout. */
export const DEFAULT_WAVE_TIMEOUTS: Record<WaveName, number | undefined> = {
  assess: 5 * 60 * 1000,
  spec: 5 * 60 * 1000,
  review: 5 * 60 * 1000,
  brainstorm: 10 * 60 * 1000,
  test: 15 * 60 * 1000,
  impl: 15 * 60 * 1000,
  quality: 10 * 60 * 1000,
  ship: undefined,
};

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
  /** Context usage threshold (0-1) — abort if input tokens exceed this fraction of contextWindow. Default: 0.8 */
  contextThreshold?: number;
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
    contextThreshold: rawThreshold = 0.8,
  } = config;

  const timeoutMs = explicitTimeout ?? DEFAULT_WAVE_TIMEOUTS[wave];
  const thinkingLevel = explicitThinking ?? DEFAULT_THINKING_LEVELS[wave];
  const contextThreshold = Math.max(0.1, Math.min(1, rawThreshold));
  const model = resolveModelFromString(modelString);
  const startTime = Date.now();

  log.info(`[${wave}] Starting wave — model=${model.id}, cwd=${cwd}`);

  const effectiveSystemPrompt = outputFormat
    ? `${systemPrompt}\n\n${buildStructuredOutputInstructions(outputFormat.schema)}`
    : systemPrompt;

  const effectiveUserMessage = handoffContext ? `${handoffContext}\n\n---\n\n${userMessage}` : userMessage;

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    streamFn: streamSimple,
    convertToLlm,
    getApiKey: resolveApiKey,
  });

  let turnCount = 0;
  let aborted = false;
  let costCapExceeded = false;
  let accumulatedCost = 0;
  let contextExhausted = false;
  let lastErrorMessage: string | undefined;

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
        if (maxCostUsd != null && accumulatedCost >= maxCostUsd && !aborted) {
          costCapExceeded = true;
          aborted = true;
          log.warn(`[${wave}] Cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd}), aborting`);
          agent.abort();
        }
      } else {
        log.debug(
          `[${wave}] Skipping non-assistant turn_end message (role=${String((msg as { role?: unknown }).role ?? 'unknown')})`,
        );
      }

      // Context window monitoring: check input tokens against threshold
      const inputTokens = isAssistantMessage(msg) ? msg.usage.input : 0;
      if (inputTokens > 0 && model.contextWindow > 0) {
        const usageRatio = inputTokens / model.contextWindow;
        if (usageRatio >= contextThreshold && !aborted) {
          contextExhausted = true;
          aborted = true;
          log.warn(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% exceeds ${(contextThreshold * 100).toFixed(0)}% threshold (${inputTokens}/${model.contextWindow} tokens), aborting`,
          );
          agent.abort();
        } else if (usageRatio >= contextThreshold * 0.875) {
          log.warn(
            `[${wave}] Context usage approaching threshold: ${(usageRatio * 100).toFixed(0)}% (${inputTokens}/${model.contextWindow} tokens)`,
          );
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      log.debug(`[${wave}] Tool: ${event.toolName}`);
    }
    if (event.type === 'turn_end' && turnCount >= maxTurns && !aborted) {
      aborted = true;
      log.warn(`[${wave}] Max turns (${maxTurns}) reached, aborting`);
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

    // Extract cost from all assistant messages
    let cost = 0;
    const messages = agent.state.messages;
    for (const msg of messages) {
      if (isAssistantMessage(msg)) {
        cost += msg.usage.cost.total;
      }
    }

    // Get the final assistant text
    let resultText: string | null = null;
    const lastAssistant = [...messages].reverse().find((m): m is AssistantMessage => isAssistantMessage(m));
    if (lastAssistant) {
      resultText = lastAssistant.content
        .filter((c) => c.type === 'text' && 'text' in c)
        .map((c) => ('text' in c ? String(c.text) : ''))
        .join('');
    }

    // Parse structured output if expected
    let structuredOutput: unknown | undefined;
    let zodValidationFailed = false;
    if (outputFormat && resultText) {
      structuredOutput = parseStructuredOutput(resultText);
      if (!structuredOutput) {
        log.warn(`[${wave}] Failed to parse structured output from response`);
      } else if (outputFormat.zodSchema) {
        const parseResult = outputFormat.zodSchema.safeParse(structuredOutput);
        if (!parseResult.success) {
          zodValidationFailed = true;
          log.warn(`[${wave}] Zod validation failed for structured output: ${parseResult.error.message}`);
        }
      }
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

    // Determine confidence from structured output parsing + Zod validation
    let confidence: 'high' | 'medium' | 'low';
    if (structuredOutput != null && zodValidationFailed) {
      confidence = 'low';
    } else if (structuredOutput != null) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    return {
      wave,
      timestamp: new Date().toISOString(),
      model: model.id,
      cost,
      turns: turnCount,
      confidence,
      artifact: (structuredOutput ?? resultText) as T,
      approach_notes: '',
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
  const shouldFallback = fallbackModel != null && isLocalModel(config.model);

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
  const { wave, systemPrompt, userMessage, cwd, modelTier, outputFormat, maxTurns, thinkingLevel } = options;

  const model = resolveWaveModel(modelTier);
  const tools = getWaveTools(wave, cwd);
  const startTime = Date.now();

  try {
    const handoff = await spawnWaveAgent({
      wave,
      model: model.id,
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

    return {
      result: typeof handoff.artifact === 'string' ? handoff.artifact : JSON.stringify(handoff.artifact),
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

export function parseStructuredOutput(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // 1. Primary: extract from <json>...</json> tags
  const tagMatch = trimmed.match(/<json>([\s\S]*?)<\/json>/);
  if (tagMatch?.[1]) {
    try {
      const result = JSON.parse(tagMatch[1].trim());
      log.debug('[parse] Extracted structured output via json-tag');
      return result;
    } catch {
      // Invalid JSON in tags — fall through to next method
    }
  }

  // 2. Secondary: extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      log.debug('[parse] Extracted structured output via markdown-fence');
      return result;
    } catch {
      // Invalid JSON in fence — fall through
    }
  }

  // 3. Tertiary: direct JSON parse of entire text
  try {
    const result = JSON.parse(trimmed);
    log.debug('[parse] Extracted structured output via direct-parse');
    return result;
  } catch {
    // Not pure JSON
  }

  // No greedy regex fallback — return undefined if none of the above worked
  return undefined;
}
