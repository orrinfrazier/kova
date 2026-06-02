// afterToolCall hook — truncates large tool results to stay within a token budget.
// Wired into spawnWaveAgent() via the pi-agent-core Agent constructor.

import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';

/** Default token budget for tool results. Results exceeding this are truncated. */
export const DEFAULT_TOKEN_BUDGET = 8_000;

/** Default number of tokens to keep from the start of a truncated result. */
export const DEFAULT_HEAD_TOKENS = 2_000;

/** Default number of tokens to keep from the end of a truncated result. */
export const DEFAULT_TAIL_TOKENS = 2_000;

export interface ToolHookOptions {
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

/**
 * Create an `afterToolCall` hook that truncates large tool results.
 *
 * - Concatenates all text content blocks and checks against the token budget
 * - If over budget: keeps head + tail tokens with a truncation marker
 * - Error results (`isError: true`) are always preserved at full length
 * - Non-text content blocks (images) are passed through unchanged
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
