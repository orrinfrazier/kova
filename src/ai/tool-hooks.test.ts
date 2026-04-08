import { describe, expect, it } from 'vitest';
import {
  createAfterToolCallHook,
  estimateTokens,
  truncateContent,
  DEFAULT_TOKEN_BUDGET,
} from './tool-hooks.js';
import type { AfterToolCallContext } from '@mariozechner/pi-agent-core';

// --- Helpers ---

function makeTextContent(text: string) {
  return { type: 'text' as const, text };
}

function makeContext(opts: {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  toolName?: string;
}): AfterToolCallContext {
  return {
    assistantMessage: {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 'tc_1', toolName: opts.toolName ?? 'read', args: {} }],
      timestamp: Date.now(),
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'tool_call',
    } as unknown as AfterToolCallContext['assistantMessage'],
    toolCall: { type: 'toolCall', toolCallId: 'tc_1', toolName: opts.toolName ?? 'read', args: {} } as unknown as AfterToolCallContext['toolCall'],
    args: {},
    result: { content: opts.content } as unknown as AfterToolCallContext['result'],
    isError: opts.isError ?? false,
    context: {} as unknown as AfterToolCallContext['context'],
  };
}

// --- estimateTokens ---

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~1 token per 4 characters', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('rounds up for non-divisible lengths', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/4 = 0.75 → ceil = 1
  });

  it('handles multi-byte characters by character count', () => {
    // 8 chars → 2 tokens
    const text = 'hello!!!';
    expect(estimateTokens(text)).toBe(2);
  });
});

// --- truncateContent ---

describe('truncateContent', () => {
  it('returns text unchanged when under budget', () => {
    const text = 'short text';
    expect(truncateContent(text, 1000, 500, 500)).toBe(text);
  });

  it('truncates text exceeding budget with head + tail + marker', () => {
    // Create text that is exactly 40 tokens (160 chars) at 4 chars/token
    const text = 'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40) + 'D'.repeat(40);
    // Budget = 10 tokens (40 chars), head = 4 tokens (16 chars), tail = 4 tokens (16 chars)
    const result = truncateContent(text, 10, 4, 4);

    expect(result).toContain('A'.repeat(16));
    expect(result).toContain('D'.repeat(16));
    expect(result).toMatch(/\[middle truncated — \d+ tokens removed\]/);
  });

  it('marker includes correct removed token count', () => {
    // 100 chars = 25 tokens. Budget 10, head 4 (16 chars), tail 4 (16 chars)
    const text = 'x'.repeat(100);
    const result = truncateContent(text, 10, 4, 4);
    // Middle removed: 100 - 16 - 16 = 68 chars = 17 tokens
    expect(result).toContain('[middle truncated — 17 tokens removed]');
  });

  it('returns text unchanged when exactly at budget', () => {
    const text = 'a'.repeat(32); // 8 tokens
    expect(truncateContent(text, 8, 4, 4)).toBe(text);
  });
});

// --- createAfterToolCallHook ---

describe('createAfterToolCallHook', () => {
  it('returns undefined for small tool results (no truncation needed)', async () => {
    const hook = createAfterToolCallHook();
    const ctx = makeContext({ content: [makeTextContent('small result')] });
    const result = await hook(ctx);
    expect(result).toBeUndefined();
  });

  it('truncates large tool results exceeding token budget', async () => {
    const hook = createAfterToolCallHook({ tokenBudget: 100, headTokens: 25, tailTokens: 25 });
    // Create content that is ~200 tokens (800 chars)
    const largeText = 'x'.repeat(800);
    const ctx = makeContext({ content: [makeTextContent(largeText)] });

    const result = await hook(ctx);
    expect(result).toBeDefined();
    expect(result!.content).toHaveLength(1);

    const truncatedText = (result!.content![0] as { type: 'text'; text: string }).text;
    expect(truncatedText.length).toBeLessThan(largeText.length);
    expect(truncatedText).toContain('[middle truncated');
  });

  it('preserves error results at full length', async () => {
    const hook = createAfterToolCallHook({ tokenBudget: 10 });
    const largeError = 'E'.repeat(800);
    const ctx = makeContext({ content: [makeTextContent(largeError)], isError: true });

    const result = await hook(ctx);
    expect(result).toBeUndefined();
  });

  it('concatenates multiple text content blocks before truncating', async () => {
    const hook = createAfterToolCallHook({ tokenBudget: 50 });
    const ctx = makeContext({
      content: [
        makeTextContent('a'.repeat(200)),
        makeTextContent('b'.repeat(200)),
      ],
    });

    const result = await hook(ctx);
    expect(result).toBeDefined();
    // Result should be a single content block with the combined+truncated text
    expect(result!.content).toHaveLength(1);
  });

  it('uses default token budget of 8000', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(8000);
  });

  it('uses configurable head/tail token counts', async () => {
    const hook = createAfterToolCallHook({
      tokenBudget: 20,
      headTokens: 5,
      tailTokens: 5,
    });
    const largeText = 'x'.repeat(400); // 100 tokens
    const ctx = makeContext({ content: [makeTextContent(largeText)] });

    const result = await hook(ctx);
    expect(result).toBeDefined();

    const truncatedText = (result!.content![0] as { type: 'text'; text: string }).text;
    // head = 5 tokens (20 chars) + marker + tail = 5 tokens (20 chars)
    expect(truncatedText.startsWith('x'.repeat(20))).toBe(true);
    expect(truncatedText.endsWith('x'.repeat(20))).toBe(true);
  });

  it('handles image content blocks by passing them through unchanged', async () => {
    const hook = createAfterToolCallHook({ tokenBudget: 10 });
    const ctx = makeContext({ content: [] });
    // Override with mixed content including an image
    (ctx.result as { content: unknown[] }).content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      makeTextContent('x'.repeat(200)),
    ];

    const result = await hook(ctx);
    expect(result).toBeDefined();
    // Image block preserved, text block truncated into single text block
    const content = result!.content!;
    const imageBlocks = content.filter((b) => b.type === 'image');
    const textBlocks = content.filter((b) => b.type === 'text');
    expect(imageBlocks).toHaveLength(1);
    expect(textBlocks).toHaveLength(1);
  });

  it('returns undefined when no text content blocks exist', async () => {
    const hook = createAfterToolCallHook({ tokenBudget: 10 });
    const ctx = makeContext({ content: [] });
    // Only image content
    (ctx.result as { content: unknown[] }).content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ];

    const result = await hook(ctx);
    expect(result).toBeUndefined();
  });
});
