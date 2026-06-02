import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeforeToolCallContext } from '@mariozechner/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDestructiveEditGuard,
  DEFAULT_MIN_EDIT_DELETE_LINES,
  DEFAULT_MIN_WRITE_RATIO,
} from './destructive-edit-guard.js';

// --- Helpers ---

function makeToolCallContext(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    assistantMessage: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc_1', name: toolName, arguments: args }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'tool_call',
    } as unknown as BeforeToolCallContext['assistantMessage'],
    toolCall: {
      type: 'toolCall',
      id: 'tc_1',
      name: toolName,
      arguments: args,
    } as unknown as BeforeToolCallContext['toolCall'],
    args,
    context: {} as unknown as BeforeToolCallContext['context'],
  };
}

function makeWriteContext(opts: { path: string; content: string }): BeforeToolCallContext {
  return makeToolCallContext('write', opts);
}

function makeEditContext(opts: { path: string; edits: { oldText: string; newText: string }[] }): BeforeToolCallContext {
  return makeToolCallContext('edit', opts);
}

function makeBashContext(args: Record<string, unknown>): BeforeToolCallContext {
  return makeToolCallContext('bash', args);
}

// --- Test sandbox ---

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kova-destructive-edit-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// --- defaults ---

describe('destructive-edit-guard defaults', () => {
  it('has DEFAULT_MIN_WRITE_RATIO = 0.6', () => {
    expect(DEFAULT_MIN_WRITE_RATIO).toBe(0.6);
  });

  it('has DEFAULT_MIN_EDIT_DELETE_LINES = 20', () => {
    expect(DEFAULT_MIN_EDIT_DELETE_LINES).toBe(20);
  });
});

// --- write guard ---

describe('createDestructiveEditGuard — write tool', () => {
  it('passes through write to non-existent file (new file)', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: 'newfile.ts', content: 'export const x = 1;' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through write that preserves >= 60% of original size', async () => {
    const file = join(sandbox, 'file.ts');
    const original = 'x'.repeat(1000);
    writeFileSync(file, original);

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: 'file.ts', content: 'x'.repeat(700) });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects write that shrinks file below 60% threshold', async () => {
    const file = join(sandbox, 'file.ts');
    const original = 'x'.repeat(1000);
    writeFileSync(file, original);

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    // 300 bytes is 30% of 1000 — under 60% threshold
    const ctx = makeWriteContext({ path: 'file.ts', content: 'x'.repeat(300) });
    const result = await guard(ctx);
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('rejected');
    expect(result?.reason).toMatch(/30%|0\.3/); // mentions the shrink ratio
  });

  it('uses configurable threshold (90% strict)', async () => {
    const file = join(sandbox, 'file.ts');
    writeFileSync(file, 'x'.repeat(1000));

    const guard = createDestructiveEditGuard({ cwd: sandbox, minWriteRatio: 0.9 });
    // 800 bytes is 80% — under strict 90% threshold
    const ctx = makeWriteContext({ path: 'file.ts', content: 'x'.repeat(800) });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
  });

  it('allows write when bypass flag is set in args', async () => {
    const file = join(sandbox, 'file.ts');
    writeFileSync(file, 'x'.repeat(1000));

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({
      path: 'file.ts',
      content: 'x'.repeat(100),
    });
    // Inject bypass flag into args (simulating a tool-arg passthrough or per-call override)
    (ctx.args as { allowDestructive?: boolean }).allowDestructive = true;
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('allows write when guard is constructed with allowDestructive=true', async () => {
    const file = join(sandbox, 'file.ts');
    writeFileSync(file, 'x'.repeat(1000));

    const guard = createDestructiveEditGuard({ cwd: sandbox, allowDestructive: true });
    const ctx = makeWriteContext({ path: 'file.ts', content: 'x' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through write to file outside cwd (absolute path)', async () => {
    const file = join(sandbox, 'outside.ts');
    writeFileSync(file, 'x'.repeat(1000));

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: file, content: 'x'.repeat(700) });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects with helpful error message naming the file and ratio', async () => {
    const file = join(sandbox, 'critical.ts');
    writeFileSync(file, 'x'.repeat(1000));

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: 'critical.ts', content: 'x'.repeat(100) });
    const result = await guard(ctx);
    expect(result?.reason).toContain('critical.ts');
    expect(result?.reason).toMatch(/preserve|preserving/i);
  });
});

// --- edit guard ---

describe('createDestructiveEditGuard — edit tool', () => {
  it('passes through edit with small newText replacements', async () => {
    const file = join(sandbox, 'file.ts');
    writeFileSync(file, 'line1\nline2\nline3\n');

    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: 'line2', newText: 'line2-modified' }],
    });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through edit that deletes <20 lines (default threshold)', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const fifteenLines = Array.from({ length: 15 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: fifteenLines, newText: '' }],
    });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects edit that deletes >20 lines with empty newText', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: thirtyLines, newText: '' }],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/30 lines/);
  });

  it('rejects edit that deletes >20 lines with trivial newText (whitespace only)', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: thirtyLines, newText: '   \n\t  ' }],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
  });

  it('passes through edit that deletes >20 lines BUT replaces with substantive content', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const newContent = Array.from({ length: 25 }, (_, i) => `newline${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: thirtyLines, newText: newContent }],
    });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects edit when any single edit in array exceeds threshold', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [
        { oldText: 'small', newText: 'tiny' },
        { oldText: thirtyLines, newText: '' },
      ],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
  });

  it('uses configurable minEditDeleteLines threshold', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox, minEditDeleteLines: 5 });
    const tenLines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: tenLines, newText: '' }],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
  });

  it('allows edit when bypass flag is set in args', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'file.ts',
      edits: [{ oldText: thirtyLines, newText: '' }],
    });
    (ctx.args as { allowDestructive?: boolean }).allowDestructive = true;
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejection message includes line count and file path', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const ctx = makeEditContext({
      path: 'src/important.ts',
      edits: [{ oldText: fiftyLines, newText: '' }],
    });
    const result = await guard(ctx);
    expect(result?.reason).toContain('important.ts');
    expect(result?.reason).toContain('50');
    expect(result?.reason).toMatch(/preserve|preserving/i);
  });
});

// --- non-destructive tool passthrough ---

describe('createDestructiveEditGuard — non-destructive tools', () => {
  it('passes through bash tool calls', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeBashContext({ command: 'ls' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through unknown tool calls', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeToolCallContext('grep', { q: 'x' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });
});

// --- robustness ---

describe('createDestructiveEditGuard — robustness', () => {
  it('passes through (returns undefined) on invalid write args (no path)', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: '', content: 'x' });
    // bogus args — guard should not throw; safest default is allow (let pi-mono surface the validation error)
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through write when original file read fails (treat as new file)', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: 'never-existed.ts', content: 'x' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('does not throw on malformed edits array', async () => {
    const guard = createDestructiveEditGuard({ cwd: sandbox });
    const ctx = makeEditContext({ path: 'file.ts', edits: [] });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });
});
