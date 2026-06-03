#!/usr/bin/env node
// Sandbox wave runner — executes a single Agent SDK wave inside a Docker container.
// Input:  JSON file path (SandboxWaveInput) passed as CLI argument.
// Output: WaveHandoff JSON on stdout (single line).
// All logging is redirected to stderr to keep stdout clean for the result.

import { readFile } from 'node:fs/promises';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { z } from 'zod';
import type { SpawnWithFallbackConfig } from '../ai/wave-executor.js';
import { spawnWaveAgentWithFallback } from '../ai/wave-executor.js';
import { type AIWaveName, getWaveTools } from '../ai/wave-tools.js';
import type { MCPServerConfig, WaveName } from '../types/config.js';
import {
  AssessResultSchema,
  BrainstormResultSchema,
  QualityRemediationSchema,
  ReviewResultSchema,
  SpecResultSchema,
} from '../types/waves.js';
import { bootstrapMCPForWave } from './run-wave-mcp.js';

// Redirect console.log → stderr so stdout is reserved for result JSON only.
console.log = (...args: unknown[]) => {
  console.error(...args);
};

interface SandboxWaveInput {
  wave: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  thinkingLevel?: string;
  fallbackModel?: string;
  outputSchemaName?: string;
  /**
   * Issue #306 — host-forwarded MCP server config. The runner reconstructs and
   * starts these servers locally on /workspace so codegraph (and other MCP
   * servers) are available to sandboxed waves. Omit → no MCP startup.
   */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Issue #306 — per-wave MCP server allowlist override. */
  mcpWaveOverrides?: Partial<Record<AIWaveName, string[]>>;
}

interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
  zodSchema?: z.ZodType;
}

/**
 * Wave-name → Zod schema registry for in-container structured output validation.
 *
 * MUST stay in sync with `WAVE_OUTPUT_SCHEMA_NAMES` in `src/sandbox/dispatch.ts` —
 * any wave the host orchestrator routes via `outputSchemaName` must have its schema
 * registered here. Waves that do not return structured JSON (test, impl, ship) are
 * intentionally absent; the runner falls through to returning the raw assistant
 * text in that case.
 */
const WAVE_SCHEMAS: Record<string, z.ZodType> = {
  assess: AssessResultSchema,
  spec: SpecResultSchema,
  quality: QualityRemediationSchema,
  review: ReviewResultSchema,
  brainstorm: BrainstormResultSchema,
};

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: run-wave.js <input-json-path>');
    process.exit(1);
  }

  const raw = await readFile(inputPath, 'utf-8');
  const input: SandboxWaveInput = JSON.parse(raw);

  const wave = input.wave as AIWaveName;

  // Issue #306 — start MCP servers (codegraph + others) inside the sandbox so
  // structured navigation / context tools are available to sandboxed waves.
  // When the host did not forward `mcpServers` this is a noop and behavior is
  // identical to the pre-#306 runner.
  const mcp = await bootstrapMCPForWave({
    wave,
    cwd: input.cwd,
    ...(input.mcpServers != null && { mcpServers: input.mcpServers }),
    ...(input.mcpWaveOverrides != null && { mcpWaveOverrides: input.mcpWaveOverrides }),
  });

  try {
    const tools = getWaveTools(wave, input.cwd, {
      ...(mcp.tools.length > 0 && { mcpTools: mcp.tools }),
    });

    let outputFormat: OutputFormat | undefined;
    if (input.outputSchemaName && input.outputSchemaName in WAVE_SCHEMAS) {
      // biome-ignore lint/style/noNonNullAssertion: key checked above
      const zodSchema = WAVE_SCHEMAS[input.outputSchemaName]!;
      const { z } = await import('zod');
      outputFormat = {
        type: 'json_schema',
        schema: z.toJSONSchema(zodSchema, { target: 'draft-07' }) as Record<string, unknown>,
        zodSchema,
      };
    }

    const config: SpawnWithFallbackConfig = {
      wave: wave as WaveName,
      model: input.model,
      tools,
      systemPrompt: input.systemPrompt,
      handoffContext: '',
      userMessage: input.userMessage,
      cwd: input.cwd,
      ...(input.thinkingLevel != null && { thinkingLevel: input.thinkingLevel as ThinkingLevel }),
      ...(input.fallbackModel != null && { fallbackModel: input.fallbackModel }),
      ...(outputFormat != null && { outputFormat }),
    };

    const handoff = await spawnWaveAgentWithFallback(config);

    // Write result to stdout — the only stdout output in this process.
    process.stdout.write(`${JSON.stringify(handoff)}\n`);
  } finally {
    // Always tear down MCP servers — even when wave execution throws.
    await mcp.stop();
  }
}

main().catch((err: unknown) => {
  console.error(`[sandbox] Wave execution failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
