// Per-wave agent spawner — creates a fresh pi-mono Agent for each pipeline wave.
// spawnWaveAgent() is the primary interface: takes resolved model string, pre-built tools,
// and explicit handoff context. Returns WaveHandoff<T>.
// executeWave() is a backward-compat wrapper that resolves model/tools internally.

import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import { type AssistantMessage, streamSimple } from '@mariozechner/pi-ai';
import { convertToLlm } from '@mariozechner/pi-coding-agent';
import type { z } from 'zod';
import type { WaveHandoff, WaveModelConfig, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { createTransformContext } from './context-transform.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { getModelString, resolveModelFromString, resolveWaveModel } from './models.js';
import { isOllamaProvider, resolveOllamaApiKey } from './ollama.js';
import { isRouterProvider, resolveRouterApiKey } from './router.js';
import { createAfterToolCallHook, type ToolHookOptions } from './tool-hooks.js';
import { type AIWaveName, DEFAULT_THINKING_LEVELS, getWaveTools } from './wave-tools.js';

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

  const afterToolCallHook =
    toolResultTruncation === false ? undefined : createAfterToolCallHook(toolResultTruncation ?? undefined);

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
    transformContext: createTransformContext(model.contextWindow),
    ...(afterToolCallHook && { afterToolCall: afterToolCallHook }),
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
          agent.abort();
        } else if (usageRatio >= TRIM_THRESHOLD && !contextTrimmed) {
          // Tier 2: aggressive trimming via transformContext
          contextTrimmed = true;
          log.warn(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% hit trim threshold (${inputTokens}/${model.contextWindow} tokens), enabling aggressive context compaction`,
          );
          agent.transformContext = aggressiveTrimContext;
          // Also steer if not already done
          if (!contextSteered) {
            contextSteered = true;
            agent.steer({
              role: 'user',
              content:
                'Focus on completing the current task. Avoid reading additional files unless absolutely necessary.',
              timestamp: Date.now(),
            });
          }
        } else if (usageRatio >= STEER_THRESHOLD && !contextSteered) {
          // Tier 1: steer with warning
          contextSteered = true;
          log.info(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% hit steer threshold (${inputTokens}/${model.contextWindow} tokens), steering agent to focus`,
          );
          agent.steer({
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
