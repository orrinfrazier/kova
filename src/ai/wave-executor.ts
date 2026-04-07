// Per-wave agent spawner — creates a fresh pi-mono Agent for each pipeline wave.
// spawnWaveAgent() is the primary interface: takes resolved model string, pre-built tools,
// and explicit handoff context. Returns WaveHandoff<T>.
// executeWave() is a backward-compat wrapper that resolves model/tools internally.

import { Agent, type AgentTool } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { convertToLlm } from '@mariozechner/pi-coding-agent';
import type { ModelTier, WaveHandoff, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { resolveModel, resolveModelFromString } from './models.js';
import { getWaveTools } from './wave-tools.js';

export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/** Default wall-clock timeouts per wave type (ms). `undefined` means no timeout. */
export const DEFAULT_WAVE_TIMEOUTS: Record<WaveName, number | undefined> = {
  assess: 5 * 60 * 1000,
  spec: 5 * 60 * 1000,
  review: 5 * 60 * 1000,
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
  } = config;

  const timeoutMs = explicitTimeout ?? DEFAULT_WAVE_TIMEOUTS[wave];

  const model = resolveModelFromString(modelString);
  const startTime = Date.now();

  log.info(`[${wave}] Starting wave — model=${model.id}, cwd=${cwd}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;

  const effectiveSystemPrompt = outputFormat
    ? `${systemPrompt}\n\n${buildStructuredOutputInstructions(outputFormat.schema)}`
    : systemPrompt;

  const effectiveUserMessage = handoffContext ? `${handoffContext}\n\n---\n\n${userMessage}` : userMessage;

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model,
      thinkingLevel: 'off',
      tools,
    },
    streamFn: streamSimple,
    convertToLlm,
    getApiKey: () => apiKey,
  });

  let turnCount = 0;
  let aborted = false;
  let lastErrorMessage: string | undefined;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount % 50 === 0) {
        log.info(`[${wave}] Turn ${turnCount}...`);
      }
      const msg = event.message as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (msg?.role === 'assistant' && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) {
        lastErrorMessage = msg.errorMessage ?? `Agent ${msg.stopReason} during ${wave}`;
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

    // Extract cost from all assistant messages
    let cost = 0;
    const messages = agent.state.messages;
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const assistantMsg = msg as {
          role: 'assistant';
          usage?: { cost?: { total?: number } };
        };
        cost += assistantMsg.usage?.cost?.total ?? 0;
      }
    }

    // Get the final assistant text
    let resultText: string | null = null;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      const textContent = (lastAssistant as { content?: Array<{ type: string; text?: string }> }).content;
      if (textContent) {
        resultText = textContent
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
      }
    }

    // Parse structured output if expected
    let structuredOutput: unknown | undefined;
    if (outputFormat && resultText) {
      structuredOutput = parseStructuredOutput(resultText);
      if (!structuredOutput) {
        log.warn(`[${wave}] Failed to parse structured output from response`);
      }
    }

    // Detect pi-mono errors reported via state or event subscription
    const piMonoError = agent.state.errorMessage ?? lastErrorMessage;
    if (piMonoError) {
      const classified = classifyError(piMonoError);
      throw new KovaError(
        `${classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'config' ? 'Config' : 'Agent'} error during ${wave}: ${piMonoError}`,
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

    // Determine confidence from structured output parsing
    const confidence: 'high' | 'medium' | 'low' = structuredOutput != null ? 'high' : 'medium';

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

    if (classified.type === 'billing' || classified.type === 'config') {
      const label = classified.type === 'billing' ? 'Billing/rate limit' : 'Config';
      throw new KovaError(`${label} error during ${wave}: ${err.message}`, classified.type, classified.retryable);
    }

    log.error(`[${wave}] Failed — ${err.message}`);
    throw new KovaError(`Wave ${wave} failed: ${err.message}`, 'agent', false);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
    unsubscribe();
  }
}

// --- Backward-compat wrapper ---

export interface WaveOptions {
  wave: WaveName;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  modelTier: ModelTier;
  outputFormat?: OutputFormat;
  maxTurns?: number;
}

export interface WaveExecutionResult {
  result: string | null;
  success: boolean;
  duration: number;
  turns: number;
  cost: number;
  model?: string | undefined;
  structuredOutput?: unknown;
}

export async function executeWave(options: WaveOptions): Promise<WaveExecutionResult> {
  const { wave, systemPrompt, userMessage, cwd, modelTier, outputFormat, maxTurns } = options;

  const model = resolveModel(modelTier);
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
    });

    const duration = Date.now() - startTime;

    return {
      result: typeof handoff.artifact === 'string' ? handoff.artifact : JSON.stringify(handoff.artifact),
      success: true,
      duration,
      turns: handoff.turns,
      cost: handoff.cost,
      model: handoff.model,
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

function buildStructuredOutputInstructions(schema: Record<string, unknown>): string {
  return [
    '## Required Output Format',
    '',
    'Your FINAL message must be ONLY a valid JSON object matching this schema (no markdown fences, no explanation):',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'Return ONLY the JSON object as your final message after completing all work.',
  ].join('\n');
}

function parseStructuredOutput(text: string): unknown | undefined {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not pure JSON
  }

  // Try extracting from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Not valid JSON in fence
    }
  }

  // Try finding the last JSON object in the text
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Not valid JSON
    }
  }

  return undefined;
}
