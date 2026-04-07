// Wave-specific tool mapping — restricts pi-mono tool access per pipeline wave.
// Read-only waves (assess, spec, review) cannot write or execute.
// Coding waves (test, impl) get full coding tools.
// Quality gets bash + read for running checks.
// Ship is orchestrator-only (git operations via commitAndPush) — no AI agent spawned.

import type { AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
import type { CustomTool, RepoConfig, WaveName } from '../types/index.js';

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

export function getWaveTools(wave: AIWaveName, cwd: string, customTools?: readonly CustomTool[]): AnyTool[] {
  const allowedNames = WAVE_TOOLS[wave];
  const tools = allowedNames.map((name) => toolCreators[name](cwd));

  if (customTools && customTools.length > 0 && CUSTOM_TOOL_WAVES.has(wave)) {
    tools.push(...createCustomTools(customTools, cwd));
  }

  return tools;
}
