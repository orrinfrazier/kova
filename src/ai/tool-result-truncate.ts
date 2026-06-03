// Runtime-agnostic tool-result truncation primitive (issue #315).
//
// Why this lives here: kova's previous truncation path went through
// pi-agent-core's `afterToolCall` hook (`createAfterToolCallHook` in
// `./tool-hooks.ts`), which rewrites tool-result content between
// tool-execute and model-handoff. claude-agent-sdk's hook model
// (`PreToolUse` / `PostToolUse` / `canUseTool`) has no output-side
// content-rewrite surface — `PostToolUse` is informational only,
// `canUseTool` is input-only.
//
// To stay runtime-agnostic, truncation happens at a layer above the
// runtime: each `AgentTool`'s `execute()` is wrapped so the budget is
// applied inside the tool itself, before the result ever reaches the
// runtime's tool-result message. The wrap-at-execute path keeps working
// regardless of which agent SDK underpins kova.
//
// `tool-hooks.ts` keeps `createAfterToolCallHook` as a thin
// backward-compatible alias and re-exports the pure helpers here so
// existing imports continue to work.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

/** Default token budget for tool results. Results exceeding this are truncated. */
export const DEFAULT_TOKEN_BUDGET = 8_000;

/** Default number of tokens to keep from the start of a truncated result. */
export const DEFAULT_HEAD_TOKENS = 2_000;

/** Default number of tokens to keep from the end of a truncated result. */
export const DEFAULT_TAIL_TOKENS = 2_000;

/** Options for tool-result truncation. */
export interface TruncationOptions {
  /** Max tokens for a single tool result before truncation. Default: 8000 */
  tokenBudget?: number;
  /** Tokens to keep from the start of a truncated result. Default: 2000 */
  headTokens?: number;
  /** Tokens to keep from the end of a truncated result. Default: 2000 */
  tailTokens?: number;
}

/** Rough token estimate: ~4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Truncate text to head + tail tokens with a marker in the middle. */
export function truncateContent(text: string, tokenBudget: number, headTokens: number, tailTokens: number): string {
  if (estimateTokens(text) <= tokenBudget) return text;

  const headChars = headTokens * 4;
  const tailChars = tailTokens * 4;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const removedChars = text.length - headChars - tailChars;
  const removedTokens = Math.ceil(removedChars / 4);

  return `${head}\n[middle truncated — ${removedTokens} tokens removed]\n${tail}`;
}

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/** Apply the truncation budget to an `AgentToolResult`'s content. Pure. */
function truncateResultContent(
  content: AgentToolResult<unknown>['content'],
  tokenBudget: number,
  headTokens: number,
  tailTokens: number,
): AgentToolResult<unknown>['content'] {
  if (!Array.isArray(content) || content.length === 0) return content;

  const textBlocks: { type: 'text'; text: string }[] = [];
  const nonTextBlocks: AgentToolResult<unknown>['content'] = [];

  for (const block of content) {
    if (block && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      textBlocks.push(block as { type: 'text'; text: string });
    } else {
      nonTextBlocks.push(block);
    }
  }

  if (textBlocks.length === 0) return content;

  const fullText = textBlocks.map((b) => b.text).join('\n');
  const estimatedTokenCount = estimateTokens(fullText);

  // Under budget — pass through unchanged.
  if (estimatedTokenCount <= tokenBudget) return content;

  const truncatedText = truncateContent(fullText, tokenBudget, headTokens, tailTokens);
  return [...nonTextBlocks, { type: 'text' as const, text: truncatedText }];
}

/**
 * Wrap any `AgentTool` so its `execute()` truncates large results to a token
 * budget. Runtime-agnostic — works on pi-agent-core tools today and on any
 * future tool shape that conforms to `AgentTool`.
 *
 * - Successful results are inspected: text content is concatenated; if it
 *   exceeds `tokenBudget`, the wrapper keeps `headTokens + tailTokens` with
 *   a marker in the middle. Non-text blocks (images) pass through unchanged.
 * - Errors thrown from the inner `execute()` propagate unchanged — truncation
 *   never runs on the error path. This matches the legacy `afterToolCall`
 *   semantics where `isError: true` skipped truncation.
 * - Pass `false` as the second argument to disable wrapping entirely; the
 *   original tool is returned by reference (identity).
 *
 * The wrapper preserves all other `AgentTool` fields (`name`, `label`,
 * `description`, `parameters`, `prepareArguments`, `executionMode`, etc.) so
 * downstream code that inspects tool metadata is unaffected.
 */
export function withTruncatedResult<T extends AnyTool>(tool: T, opts?: TruncationOptions | false): T {
  if (opts === false) return tool;

  // Defensive: tests sometimes pass mock tool objects without an `execute`
  // implementation (e.g. `{ name: 'read' }`). Wrapping such an object would
  // crash later when the runtime calls `execute`; return the tool unchanged
  // and let the runtime surface the missing-execute error in its own terms.
  if (typeof tool.execute !== 'function') return tool;

  const tokenBudget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const headTokens = opts?.headTokens ?? DEFAULT_HEAD_TOKENS;
  const tailTokens = opts?.tailTokens ?? DEFAULT_TAIL_TOKENS;

  const originalExecute = tool.execute.bind(tool);

  // Spread preserves all `AgentTool` fields; only `execute` is overridden.
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: Parameters<T['execute']>[3],
    ): Promise<AgentToolResult<unknown>> {
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool parameter generics widen at this boundary
      const result = await originalExecute(toolCallId, params as any, signal, onUpdate as never);
      return {
        ...result,
        content: truncateResultContent(result.content, tokenBudget, headTokens, tailTokens),
      };
    },
  } as T;
}
