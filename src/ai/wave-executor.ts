// Core wave executor — wraps Agent SDK query() for each pipeline wave.
// Based on Shannon's claude-executor.ts pattern: stream messages, handle errors,
// detect billing issues, return typed results.

import { type JsonSchemaOutputFormat, query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier, WaveName } from '../types/index.js';
import { KovaError, isSpendingCapBehavior } from './errors.js';
import { resolveModel } from './models.js';
import { log } from '../utils/logger.js';

export interface WaveOptions {
  wave: WaveName;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  modelTier: ModelTier;
  outputFormat?: JsonSchemaOutputFormat;
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
  const {
    wave,
    systemPrompt,
    userMessage,
    cwd,
    modelTier,
    outputFormat,
    maxTurns = 5_000,
  } = options;

  const model = resolveModel(modelTier);
  const startTime = Date.now();

  log.info(`[${wave}] Starting wave — model=${model}, cwd=${cwd}`);

  const sdkOptions = {
    model,
    maxTurns,
    cwd,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: ['user'] as ('user' | 'project' | 'local')[],
    env: buildEnv(),
    ...(outputFormat && { outputFormat }),
  };

  const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

  let turnCount = 0;
  let result: string | null = null;
  let cost = 0;
  let detectedModel: string | undefined;
  let structuredOutput: unknown | undefined;

  try {
    for await (const message of query({ prompt: fullPrompt, options: sdkOptions })) {
      const msg = message as {
        type: string;
        subtype?: string;
        result?: string;
        total_cost_usd?: number;
        model?: string;
        stop_reason?: string | null;
        structured_output?: unknown;
        error?: string;
        message?: { content: unknown };
      };

      if (msg.type === 'assistant') {
        turnCount++;
        if (turnCount % 50 === 0) {
          log.info(`[${wave}] Turn ${turnCount}...`);
        }

        // Check for SDK-reported errors on assistant messages
        if (msg.error) {
          handleSdkError(wave, msg.error);
        }
      }

      if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
        detectedModel = msg.model;
      }

      if (msg.type === 'tool_use') {
        const toolMsg = msg as { type: string; name?: string };
        log.debug(`[${wave}] Tool: ${toolMsg.name ?? 'unknown'}`);
      }

      if (msg.type === 'result') {
        result = msg.result ?? null;
        cost = msg.total_cost_usd ?? 0;
        if (msg.structured_output !== undefined) {
          structuredOutput = msg.structured_output;
        }
        break;
      }
    }

    // Defense-in-depth: detect spending cap that slipped through
    if (isSpendingCapBehavior(turnCount, cost, result ?? '')) {
      throw new KovaError(
        `Spending cap likely reached (turns=${turnCount}, cost=$0)`,
        'billing',
        true,
      );
    }

    const duration = Date.now() - startTime;
    log.info(`[${wave}] Completed — turns=${turnCount}, cost=$${cost.toFixed(4)}, duration=${(duration / 1000).toFixed(1)}s`);

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost,
      model: detectedModel,
      ...(structuredOutput !== undefined && { structuredOutput }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));

    log.error(`[${wave}] Failed — ${err.message} (${(duration / 1000).toFixed(1)}s)`);

    return {
      result: null,
      success: false,
      duration,
      turns: turnCount,
      cost,
      model: detectedModel,
    };
  }
}

export async function executeWaveWithRetry(
  options: WaveOptions,
  maxRetries: number = 2,
): Promise<WaveExecutionResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await executeWave(options);

    if (result.success) return result;

    if (attempt < maxRetries) {
      const delay = Math.min(5000 * 2 ** attempt, 60_000);
      log.warn(`[${options.wave}] Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should not reach here, but satisfy the compiler
  throw new KovaError(`Wave ${options.wave} failed after ${maxRetries + 1} attempts`, 'agent', false);
}

function handleSdkError(wave: WaveName, errorType: string): void {
  switch (errorType) {
    case 'billing_error':
    case 'rate_limit':
      throw new KovaError(`${errorType} during ${wave}`, 'billing', true);
    case 'authentication_failed':
      throw new KovaError(`Authentication failed during ${wave}`, 'config', false);
    default:
      log.warn(`[${wave}] SDK error: ${errorType}`);
  }
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'HOME',
    'PATH',
  ];

  for (const name of passthrough) {
    const val = process.env[name];
    if (val) {
      env[name] = val;
    }
  }

  return env;
}
