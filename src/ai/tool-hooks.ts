// Tool-call hooks for pi-agent-core's runtime.
//
// Issue #315 — this module is a backward-compatibility shim. The pure
// truncation primitives (`estimateTokens`, `truncateContent`, default
// constants, `TruncationOptions`/`ToolHookOptions`) live in
// `./tool-result-truncate.ts` and are re-exported below so existing imports
// keep working.
//
// When swapping to claude-agent-sdk, the wrap-at-execute path
// (`withTruncatedResult` in `./tool-result-truncate.ts`) keeps working;
// `afterToolCall` does not — claude-agent-sdk's `PostToolUse` is
// informational only and offers no output-side content-rewrite surface.
// New code should call `withTruncatedResult(tool, opts)` at tool-creation
// time instead of wiring `createAfterToolCallHook` into the runtime.

import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';
import {
  DEFAULT_HEAD_TOKENS,
  DEFAULT_TAIL_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  type TruncationOptions,
  truncateContent,
} from './tool-result-truncate.js';

// Re-export the pure primitives from their new home so existing imports of
// `./tool-hooks` continue to work unchanged.
export {
  DEFAULT_HEAD_TOKENS,
  DEFAULT_TAIL_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  truncateContent,
} from './tool-result-truncate.js';

/**
 * Tool-result truncation options.
 *
 * Alias of `TruncationOptions` (from `./tool-result-truncate.ts`) kept for
 * backward compatibility. New code should prefer `TruncationOptions`.
 */
export type ToolHookOptions = TruncationOptions;

/**
 * Create an `afterToolCall` hook that truncates large tool results.
 *
 * - Concatenates all text content blocks and checks against the token budget
 * - If over budget: keeps head + tail tokens with a truncation marker
 * - Error results (`isError: true`) are always preserved at full length
 * - Non-text content blocks (images) are passed through unchanged
 *
 * @deprecated Issue #315 — pi-agent-core's `afterToolCall` is not portable
 * to claude-agent-sdk's hook model. Prefer `withTruncatedResult(tool, opts)`
 * from `./tool-result-truncate.ts`, which wraps any `AgentTool`'s `execute()`
 * and works across runtimes. Kept here for callers that still need a
 * pi-mono-shaped hook (none inside kova as of #315 — wave-executor now wires
 * truncation at the tool layer).
 */
export function createAfterToolCallHook(
  options?: ToolHookOptions,
): (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
  const tokenBudget = options?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const headTokens = options?.headTokens ?? DEFAULT_HEAD_TOKENS;
  const tailTokens = options?.tailTokens ?? DEFAULT_TAIL_TOKENS;

  return async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    // Never truncate error results — they're diagnostic
    if (context.isError) return undefined;

    const contentBlocks = context.result.content;
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return undefined;

    // Separate text and non-text blocks
    const textBlocks: { type: 'text'; text: string }[] = [];
    const nonTextBlocks: (typeof contentBlocks)[number][] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text' && 'text' in block) {
        textBlocks.push(block as { type: 'text'; text: string });
      } else {
        nonTextBlocks.push(block);
      }
    }

    // Nothing to truncate if no text blocks
    if (textBlocks.length === 0) return undefined;

    // Concatenate all text content
    const fullText = textBlocks.map((b) => b.text).join('\n');
    const estimatedTokenCount = estimateTokens(fullText);

    // Under budget — no truncation needed
    if (estimatedTokenCount <= tokenBudget) return undefined;

    // Truncate
    const truncatedText = truncateContent(fullText, tokenBudget, headTokens, tailTokens);

    return {
      content: [...nonTextBlocks, { type: 'text' as const, text: truncatedText }],
    };
  };
}
