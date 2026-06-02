// Wave-specific tool mapping — restricts pi-mono tool access per pipeline wave.
// Read-only waves (assess, spec, review) cannot write or execute.
// Coding waves (test, impl) get full coding tools.
// Quality gets bash + read for running checks.
// Ship is orchestrator-only (git operations via commitAndPush) — no AI agent spawned.

import type { AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { CustomTool, RepoConfig, WaveName } from '../types/index.js';
import { createPipelineTool, type PipelineToolOptions } from './pipeline-tool.js';

type ToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls';

/** Waves that spawn an AI agent — excludes ship (orchestrator-only, no AI). */
export type AIWaveName = Exclude<WaveName, 'ship'>;

/** Fix-pipeline AI waves — excludes ship and brainstorm (standalone command). */
export type FixAIWaveName = Exclude<AIWaveName, 'brainstorm'>;

/** Default extended thinking levels per wave type.
 *  Reasoning waves (assess, spec, review) benefit from extended thinking.
 *  Coding/mechanical waves (test, impl, quality) do not. */
export const DEFAULT_THINKING_LEVELS: Record<WaveName, ThinkingLevel> = {
  assess: 'medium',
  spec: 'medium',
  review: 'medium',
  brainstorm: 'medium',
  test: 'off',
  impl: 'off',
  quality: 'off',
  ship: 'off',
};

export const WAVE_TOOLS: Record<AIWaveName, ToolName[]> = {
  assess: ['read', 'find', 'grep'],
  spec: ['read', 'find', 'grep'],
  test: ['read', 'write', 'edit', 'bash'],
  impl: ['read', 'write', 'edit', 'bash'],
  quality: ['bash', 'read'],
  review: ['read', 'grep'],
  brainstorm: ['read', 'find', 'grep'],
} as const;

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

const toolCreators: Record<ToolName, (cwd: string) => AnyTool> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: (cwd: string) => {
    throw new Error(`ls tool requested but not wired — add createLsTool import (cwd=${cwd})`);
  },
};

/** Resolve the thinking level for a wave — config override takes precedence over defaults. */
export function resolveThinkingLevel(config: RepoConfig, wave: WaveName): ThinkingLevel {
  const override = config.model.thinking?.[wave as AIWaveName];
  return override ?? DEFAULT_THINKING_LEVELS[wave];
}

/** Waves where custom tools are available. */
const CUSTOM_TOOL_WAVES: ReadonlySet<AIWaveName> = new Set(['impl', 'quality']);

/**
 * Create AgentTool wrappers for custom repo tools.
 * Each custom tool becomes a bash command the agent can invoke by name.
 */
export function createCustomTools(tools: readonly CustomTool[], cwd: string): AnyTool[] {
  return tools.map(
    (tool): AnyTool => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: {} },
      async execute() {
        const { execSync } = await import('node:child_process');
        try {
          const output = execSync(tool.command, {
            cwd,
            encoding: 'utf-8',
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { content: [{ type: 'text', text: output || '(no output)' }], details: undefined };
        } catch (error) {
          const err = error as { stderr?: string; stdout?: string; status?: number };
          const msg = `Command failed (exit ${err.status ?? 1}):\n${err.stderr ?? err.stdout ?? String(error)}`;
          return { content: [{ type: 'text', text: msg }], details: undefined };
        }
      },
    }),
  );
}

/** Waves where the execute_pipeline RPC tool may be appended (issue #300). */
const PIPELINE_TOOL_WAVES: ReadonlySet<AIWaveName> = new Set(['impl', 'quality']);

export interface WaveToolOptions {
  customTools?: readonly CustomTool[] | undefined;
  mcpTools?: AnyTool[] | undefined;
  playwright?: { enabled: boolean } | undefined;
  /** Append the execute_pipeline RPC tool to impl/quality waves (issue #300).
   *  Off by default. When enabled, the wave's existing wave tools (read/bash/etc.)
   *  plus customTools and mcpTools are exposed inside the sandboxed script. */
  pipelineTool?: ({ enabled: boolean } & PipelineToolOptions) | undefined;
  /**
   * Files this spec piece is allowed to modify (issue #250).
   * `getWaveTools` itself does NOT enforce this — enforcement happens in
   * `spawnWaveAgent` via a `beforeToolCall` hook. The field lives in this option
   * bag so callers have one place to put per-wave configuration.
   *
   * Only the `impl` wave enforces this restriction. Test and quality waves are
   * intentionally unrestricted — test needs to create new test files, quality
   * needs to fix lint/type errors anywhere in the repo.
   *
   * Empty/undefined → no restriction (backward compat).
   */
  pieceFiles?: readonly string[] | undefined;
}

/** Waves where the piece-scope guard is applied (issue #250 — impl only). */
export const PIECE_SCOPE_WAVES: ReadonlySet<AIWaveName> = new Set(['impl']);

export function getWaveTools(wave: AIWaveName, cwd: string, options?: WaveToolOptions): AnyTool[] {
  const allowedNames = [...WAVE_TOOLS[wave]];

  // When playwright is enabled, add bash to the review wave for screenshot capture
  if (options?.playwright?.enabled && wave === 'review' && !allowedNames.includes('bash')) {
    allowedNames.push('bash');
  }

  const tools = allowedNames.map((name) => toolCreators[name](cwd));

  if (options?.customTools && options.customTools.length > 0 && CUSTOM_TOOL_WAVES.has(wave)) {
    tools.push(...createCustomTools(options.customTools, cwd));
  }

  if (options?.mcpTools && options.mcpTools.length > 0) {
    tools.push(...options.mcpTools);
  }

  // Issue #300 — programmatic tool calling via execute_pipeline.
  // Only impl + quality waves get this RPC tool, and only when explicitly enabled.
  if (options?.pipelineTool?.enabled === true && PIPELINE_TOOL_WAVES.has(wave)) {
    const { enabled: _enabled, ...limits } = options.pipelineTool;
    tools.push(createPipelineTool(cwd, tools, limits));
  }

  return tools;
}
