// Programmatic tool calling — collapse multi-step waves into one zero-context-cost RPC turn.
//
// Problem: every individual AgentTool call is a model round-trip that spends
// context. A quality wave (lint → typecheck → test → coverage → grep) is 5+
// round-trips, each result re-entering the context.
//
// Solution (borrowed from hermes-agent's code_execution_tool): the model emits
// ONE script that calls tools via in-process RPC. Only the script's captured
// stdout returns to the model — intermediate tool results never enter context.
//
// Wired into impl + quality waves behind a flag (default off). See
// `getWaveTools` in `./wave-tools.ts`.

import { runInNewContext } from 'node:vm';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/** Tunable limits for an `execute_pipeline` invocation. */
export interface PipelineToolOptions {
  /** Maximum number of `tools.<name>(...)` invocations the script may make. */
  maxCalls?: number;
  /** Wall-clock timeout for the script in milliseconds. */
  timeoutMs?: number;
  /** Maximum bytes of captured stdout/stderr returned to the agent. */
  maxOutputBytes?: number;
}

/** Defaults used when fields of `PipelineToolOptions` are omitted. */
export const PIPELINE_TOOL_DEFAULTS = {
  maxCalls: 50,
  timeoutMs: 60_000,
  maxOutputBytes: 16 * 1024,
} as const satisfies Required<PipelineToolOptions>;

/** The TypeBox schema for the `execute_pipeline` tool's parameters. */
const PIPELINE_TOOL_PARAMETERS = Type.Object({
  script: Type.String({
    description:
      'JavaScript source body. Inside the script, `tools` is an object whose keys are the names of the wave-allowed AgentTools. Each tool is async and returns the underlying AgentToolResult (use `result.content[0].text` for output). Only console.log/console.error output is returned to the agent — intermediate tool results never enter the conversation context.',
  }),
});

const DESCRIPTION = [
  'Execute a small JS script that drives multiple tools via in-process RPC.',
  'Use this when you need to chain several tool calls (e.g. lint → typecheck → test → grep)',
  'without spending a model round-trip on each intermediate result.',
  'Inside the script, `tools` is an object keyed by the allowed tool names; each function is async.',
  'Only what you `console.log` is returned to the model — intermediate tool outputs stay out of context.',
  'There is a max-call cap and a wall-clock timeout. Output is capped.',
].join(' ');

/** Cap a string to `maxBytes` bytes (UTF-8). Adds a `...truncated...` suffix when cut. */
function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  const sliceBytes = Math.max(0, maxBytes - 32);
  const head = buf.subarray(0, sliceBytes).toString('utf-8');
  return `${head}\n...truncated (output exceeded ${maxBytes} bytes)...`;
}

/**
 * Build a sandbox console that appends to `lines` (one entry per call).
 * Argument formatting mirrors `console.log` semantics: primitives stringify,
 * objects JSON-stringify, multi-arg calls space-join.
 */
function makeSandboxConsole(lines: string[]): {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a == null) return String(a);
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');
  return {
    log: (...args: unknown[]) => lines.push(fmt(args)),
    error: (...args: unknown[]) => lines.push(fmt(args)),
  };
}

/**
 * Build the `tools` object exposed to the sandboxed script.
 *
 * Each allowed AgentTool becomes an async function. Calls increment a counter;
 * when the counter exceeds `maxCalls` the function throws inside the script,
 * surfacing the limit through the standard error path.
 *
 * Tool results are returned directly to the script (NOT to the agent's
 * conversation context). The agent only sees what the script chooses to log.
 */
function buildToolsForSandbox(
  allowedTools: readonly AnyTool[],
  state: { calls: number; maxCalls: number },
  // biome-ignore lint/suspicious/noExplicitAny: dispatch shape varies per tool
): Record<string, (params: unknown) => Promise<AgentToolResult<any>>> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const out: Record<string, (params: unknown) => Promise<AgentToolResult<any>>> = {};
  let nextCallId = 0;
  for (const tool of allowedTools) {
    out[tool.name] = async (params: unknown) => {
      state.calls += 1;
      if (state.calls > state.maxCalls) {
        throw new Error(
          `execute_pipeline: max-call cap exceeded (limit=${state.maxCalls}). Reduce the number of tool calls in your script.`,
        );
      }
      const callId = `pipeline-${++nextCallId}`;
      return tool.execute(callId, (params ?? {}) as never);
    };
  }
  return out;
}

/**
 * Create an `execute_pipeline` AgentTool that runs model-supplied JS scripts
 * against an allowlisted set of in-process tools. Intermediate tool results
 * stay inside the script; only captured stdout/stderr returns to the agent.
 *
 * @param cwd  - The repo working directory (unused directly, but kept in
 *               signature for consistency with sibling tool creators and for
 *               future extension where the script may want it).
 * @param allowedTools - The exact set of AgentTools the script may call.
 *                       Anything outside this list is undefined in the sandbox.
 * @param options - Optional limits (maxCalls, timeoutMs, maxOutputBytes).
 */
export function createPipelineTool(
  cwd: string,
  allowedTools: readonly AnyTool[],
  options?: PipelineToolOptions,
): AnyTool {
  const maxCalls = options?.maxCalls ?? PIPELINE_TOOL_DEFAULTS.maxCalls;
  const timeoutMs = options?.timeoutMs ?? PIPELINE_TOOL_DEFAULTS.timeoutMs;
  const maxOutputBytes = options?.maxOutputBytes ?? PIPELINE_TOOL_DEFAULTS.maxOutputBytes;

  // `cwd` is accepted for signature symmetry with other tool creators and
  // surfaced to the script as a read-only string. Sandboxed code cannot
  // escape the vm context, so this is informational only.
  const sandboxCwd = cwd;

  return {
    name: 'execute_pipeline',
    label: 'execute_pipeline',
    description: DESCRIPTION,
    parameters: PIPELINE_TOOL_PARAMETERS,
    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<undefined>> {
      const script =
        params != null &&
        typeof params === 'object' &&
        'script' in params &&
        typeof (params as { script: unknown }).script === 'string'
          ? (params as { script: string }).script
          : '';
      const lines: string[] = [];
      const state = { calls: 0, maxCalls };
      const sandboxConsole = makeSandboxConsole(lines);
      const tools = buildToolsForSandbox(allowedTools, state);

      const sandbox: Record<string, unknown> = {
        console: sandboxConsole,
        tools,
        cwd: sandboxCwd,
      };

      // Wrap the user script in an async IIFE so `await` is legal at top level.
      const wrapped = `(async () => {\n${script}\n})()`;

      try {
        // `runInNewContext` returns the IIFE's promise. We must await it
        // OUTSIDE the timed call (timeoutMs governs synchronous execution
        // only) but the synchronous busy-wait test covers the vm timeout path.
        const maybePromise = runInNewContext(wrapped, sandbox, {
          timeout: timeoutMs,
          displayErrors: true,
        }) as unknown;

        if (maybePromise && typeof (maybePromise as { then?: unknown }).then === 'function') {
          // Race the async portion against a wall-clock timer so awaited tool
          // calls (which the vm timeout cannot interrupt) are still bounded.
          await Promise.race([
            maybePromise as Promise<unknown>,
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error(`execute_pipeline: script timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        lines.push(`Error: ${msg}`);
      }

      const text = capBytes(lines.join('\n') || '(no output)', maxOutputBytes);
      return {
        content: [{ type: 'text', text }],
        details: undefined,
      };
    },
  };
}
