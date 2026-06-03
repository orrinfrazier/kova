// Tests for the runtime-agnostic tool-result truncation primitive.
// See ./tool-result-truncate.ts.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type TSchema, Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_TOKENS,
  DEFAULT_TAIL_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  type TruncationOptions,
  truncateContent,
  withTruncatedResult,
} from './tool-result-truncate.js';

// --- estimateTokens / truncateContent: keep parity with the legacy module ---

describe('estimateTokens (re-exported)', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('rounds up for non-divisible lengths', () => {
    expect(estimateTokens('abc')).toBe(1);
  });
});

describe('truncateContent (re-exported)', () => {
  it('returns text unchanged when under budget', () => {
    expect(truncateContent('short text', 1000, 500, 500)).toBe('short text');
  });

  it('truncates text exceeding budget with head + tail + marker', () => {
    const text = 'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40) + 'D'.repeat(40);
    const result = truncateContent(text, 10, 4, 4);
    expect(result).toContain('A'.repeat(16));
    expect(result).toContain('D'.repeat(16));
    expect(result).toMatch(/\[middle truncated — \d+ tokens removed\]/);
  });
});

describe('default constants', () => {
  it('exposes the canonical 8k / 2k / 2k budget', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(8_000);
    expect(DEFAULT_HEAD_TOKENS).toBe(2_000);
    expect(DEFAULT_TAIL_TOKENS).toBe(2_000);
  });
});

// --- withTruncatedResult ---

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

function makeFakeTool(opts: {
  name?: string;
  resultContent: AgentToolResult<unknown>['content'];
  throwError?: Error;
}): AnyTool {
  const params: TSchema = Type.Object({});
  return {
    name: opts.name ?? 'fake-tool',
    label: 'fake-tool',
    description: 'a fake tool used in tests',
    parameters: params,
    async execute(): Promise<AgentToolResult<unknown>> {
      if (opts.throwError) throw opts.throwError;
      return { content: opts.resultContent, details: undefined };
    },
  };
}

describe('withTruncatedResult', () => {
  it('preserves the original tool name, description, label, and parameters', () => {
    const inner = makeFakeTool({ resultContent: [{ type: 'text', text: 'ok' }] });
    const wrapped = withTruncatedResult(inner);
    expect(wrapped.name).toBe(inner.name);
    expect(wrapped.label).toBe(inner.label);
    expect(wrapped.description).toBe(inner.description);
    expect(wrapped.parameters).toBe(inner.parameters);
  });

  it('passes small results through unchanged', async () => {
    const inner = makeFakeTool({ resultContent: [{ type: 'text', text: 'small result' }] });
    const wrapped = withTruncatedResult(inner);
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('small result');
  });

  it('truncates large results with head + tail + marker', async () => {
    const inner = makeFakeTool({ resultContent: [{ type: 'text', text: 'x'.repeat(800) }] });
    const wrapped = withTruncatedResult(inner, { tokenBudget: 100, headTokens: 25, tailTokens: 25 });
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text.length).toBeLessThan(800);
    expect(block.text).toContain('[middle truncated');
  });

  it('concatenates multiple text blocks before deciding whether to truncate', async () => {
    const inner = makeFakeTool({
      resultContent: [
        { type: 'text', text: 'a'.repeat(200) },
        { type: 'text', text: 'b'.repeat(200) },
      ],
    });
    const wrapped = withTruncatedResult(inner, { tokenBudget: 50 });
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    // Combined text > budget, so the wrapper collapses to a single truncated text block.
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toContain('[middle truncated');
  });

  it('preserves non-text content blocks (e.g. images) alongside truncated text', async () => {
    const inner = makeFakeTool({
      resultContent: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'abc' } } as never,
        { type: 'text', text: 'x'.repeat(800) },
      ],
    });
    const wrapped = withTruncatedResult(inner, { tokenBudget: 50 });
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    const images = result.content.filter((b) => b.type === 'image');
    const texts = result.content.filter((b) => b.type === 'text');
    expect(images).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });

  it('returns identity (no wrapping) when options is false', async () => {
    const inner = makeFakeTool({ resultContent: [{ type: 'text', text: 'x'.repeat(800) }] });
    const wrapped = withTruncatedResult(inner, false);
    expect(wrapped).toBe(inner);
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    expect((result.content[0] as { type: 'text'; text: string }).text.length).toBe(800);
  });

  it('propagates thrown errors without attempting truncation', async () => {
    const err = new Error('boom');
    const inner = makeFakeTool({ resultContent: [], throwError: err });
    const wrapped = withTruncatedResult(inner, { tokenBudget: 10 });
    await expect(wrapped.execute('tc_1', {}, undefined, undefined)).rejects.toThrow('boom');
  });

  it('respects custom head/tail token counts', async () => {
    const inner = makeFakeTool({ resultContent: [{ type: 'text', text: 'x'.repeat(400) }] });
    const opts: TruncationOptions = { tokenBudget: 20, headTokens: 5, tailTokens: 5 };
    const wrapped = withTruncatedResult(inner, opts);
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.startsWith('x'.repeat(20))).toBe(true);
    expect(text.endsWith('x'.repeat(20))).toBe(true);
  });

  it('passes through results with no text content', async () => {
    const inner = makeFakeTool({
      resultContent: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'abc' } } as never],
    });
    const wrapped = withTruncatedResult(inner, { tokenBudget: 10 });
    const result = await wrapped.execute('tc_1', {}, undefined, undefined);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('image');
  });
});
