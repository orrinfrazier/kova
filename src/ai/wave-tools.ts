// Wave-specific tool mapping — restricts pi-mono tool access per pipeline wave.
// Read-only waves (assess, spec, review) cannot write or execute.
// Coding waves (test, impl) get full coding tools.
// Quality gets bash + read for running checks.
// Ship gets bash for git operations.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
import type { WaveName } from '../types/index.js';

type ToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls';

export const WAVE_TOOLS: Record<WaveName, ToolName[]> = {
  assess: ['read', 'find', 'grep'],
  spec: ['read', 'find', 'grep'],
  test: ['read', 'write', 'edit', 'bash'],
  impl: ['read', 'write', 'edit', 'bash'],
  quality: ['bash', 'read'],
  review: ['read', 'grep'],
  ship: ['bash'],
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

export function getWaveTools(wave: WaveName, cwd: string): AnyTool[] {
  const allowedNames = WAVE_TOOLS[wave];
  return allowedNames.map((name) => toolCreators[name](cwd));
}
