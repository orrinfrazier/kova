// Core wave executor — wraps pi-mono createAgentSession for each pipeline wave.
// Each wave creates a fresh in-memory session, sends a prompt, and collects results.

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { ModelTier, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { resolveModel } from './models.js';
import { getWaveTools } from './wave-tools.js';

export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

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
  const { wave, systemPrompt, userMessage, cwd, modelTier, outputFormat, maxTurns = 5_000 } = options;

  const model = resolveModel(modelTier);
  const startTime = Date.now();

  log.info(`[${wave}] Starting wave — model=${model.id}, cwd=${cwd}`);

  const authStorage = AuthStorage.create();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    authStorage.setRuntimeApiKey('anthropic', apiKey);
  }

  const effectiveSystemPrompt = outputFormat
    ? `${systemPrompt}\n\n${buildStructuredOutputInstructions(outputFormat.schema)}`
    : systemPrompt;

  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => effectiveSystemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: 'off',
    tools: getWaveTools(wave, cwd),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    resourceLoader: loader,
  });

  let turnCount = 0;
  let aborted = false;
  let lastErrorMessage: string | undefined;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount % 50 === 0) {
        log.info(`[${wave}] Turn ${turnCount}...`);
      }
      // Detect pi-mono error events: turn_end with an assistant message carrying stopReason "error"/"aborted"
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
    // Enforce max turns
    if (event.type === 'turn_end' && turnCount >= maxTurns && !aborted) {
      aborted = true;
      log.warn(`[${wave}] Max turns (${maxTurns}) reached, aborting`);
      session.abort().catch(() => {});
    }
  });

  let result: string | null = null;
  let cost = 0;
  let structuredOutput: unknown | undefined;

  try {
    await session.prompt(userMessage);

    // Extract cost from all assistant messages
    const messages = session.agent.state.messages;
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const assistantMsg = msg as {
          role: 'assistant';
          usage?: { cost?: { total?: number } };
          content?: Array<{ type: string; text?: string }>;
        };
        cost += assistantMsg.usage?.cost?.total ?? 0;
      }
    }

    // Get the final assistant text
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      const textContent = (lastAssistant as { content?: Array<{ type: string; text?: string }> }).content;
      if (textContent) {
        result = textContent
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
      }
    }

    // Parse structured output if expected
    if (outputFormat && result) {
      structuredOutput = parseStructuredOutput(result);
      if (!structuredOutput) {
        log.warn(`[${wave}] Failed to parse structured output from response`);
      }
    }

    // Detect pi-mono errors reported via state or event subscription
    const stateError = (session.agent.state as { errorMessage?: string }).errorMessage;
    const piMonoError = stateError ?? lastErrorMessage;
    if (piMonoError) {
      const classified = classifyError(piMonoError);
      throw new KovaError(
        `${classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'config' ? 'Config' : 'Agent'} error during ${wave}: ${piMonoError}`,
        classified.type,
        classified.retryable,
      );
    }

    // Defense-in-depth: detect spending cap behavior
    if (isSpendingCapBehavior(turnCount, cost, result ?? '')) {
      throw new KovaError(`Spending cap likely reached (turns=${turnCount}, cost=$0)`, 'billing', true);
    }

    const duration = Date.now() - startTime;
    log.info(
      `[${wave}] Completed — turns=${turnCount}, cost=$${cost.toFixed(4)}, duration=${(duration / 1000).toFixed(1)}s`,
    );

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost,
      model: model.id,
      ...(structuredOutput !== undefined && { structuredOutput }),
    };
  } catch (error) {
    // Re-throw KovaErrors (already classified from pi-mono error detection above)
    if (error instanceof KovaError) throw error;

    const duration = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));
    const classified = classifyError(err);

    // Throw classified retryable/config errors so callers can handle them
    if (classified.type === 'billing' || classified.type === 'config') {
      const label = classified.type === 'billing' ? 'Billing/rate limit' : 'Config';
      throw new KovaError(`${label} error during ${wave}: ${err.message}`, classified.type, classified.retryable);
    }

    log.error(`[${wave}] Failed — ${err.message} (${(duration / 1000).toFixed(1)}s)`);

    return {
      result: null,
      success: false,
      duration,
      turns: turnCount,
      cost,
      model: model.id,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function executeWaveWithRetry(options: WaveOptions, maxRetries: number = 2): Promise<WaveExecutionResult> {
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
