import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeBeforeToolCallHooks, createPieceScopeGuard } from './piece-scope-guard.js';

// --- Helpers ---

function makeToolCallContext(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    assistantMessage: {} as unknown as BeforeToolCallContext['assistantMessage'],
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

function makeWriteContext(path: string, content = 'x'): BeforeToolCallContext {
  return makeToolCallContext('write', { path, content });
}

function makeEditContext(path: string): BeforeToolCallContext {
  return makeToolCallContext('edit', {
    path,
    edits: [{ oldText: 'a', newText: 'b' }],
  });
}

function makeBashContext(command: string): BeforeToolCallContext {
  return makeToolCallContext('bash', { command });
}

function makeReadContext(path: string): BeforeToolCallContext {
  return makeToolCallContext('read', { path });
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kova-piece-scope-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// --- Empty / no-restriction cases ---

describe('createPieceScopeGuard — no-restriction cases', () => {
  it('returns undefined for write when pieceFiles is empty (backward compat)', async () => {
    const guard = createPieceScopeGuard({ cwd: sandbox, pieceFiles: [] });
    const result = await guard(makeWriteContext('any/file.ts'));
    expect(result).toBeUndefined();
  });

  it('returns undefined for edit when pieceFiles is empty', async () => {
    const guard = createPieceScopeGuard({ cwd: sandbox, pieceFiles: [] });
    const result = await guard(makeEditContext('any/file.ts'));
    expect(result).toBeUndefined();
  });
});

// --- Write tool — allow / block ---

describe('createPieceScopeGuard — write tool', () => {
  it('allows write to an in-scope relative file', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts', 'src/bar.ts'],
    });
    const result = await guard(makeWriteContext('src/foo.ts'));
    expect(result).toBeUndefined();
  });

  it('blocks write to an out-of-scope file with descriptive error', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeWriteContext('src/unrelated.ts'));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Cannot modify');
    expect(result?.reason).toContain('src/unrelated.ts');
    expect(result?.reason).toContain('src/foo.ts');
  });

  it('error message lists all in-scope files', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    const result = await guard(makeWriteContext('src/d.ts'));
    expect(result?.reason).toContain('src/a.ts');
    expect(result?.reason).toContain('src/b.ts');
    expect(result?.reason).toContain('src/c.ts');
  });

  it('allows write to in-scope absolute path matching cwd-relative entry', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const absPath = resolve(sandbox, 'src/foo.ts');
    const result = await guard(makeWriteContext(absPath));
    expect(result).toBeUndefined();
  });

  it('blocks write to absolute path outside cwd entries', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const absPath = resolve(sandbox, 'src/unrelated.ts');
    const result = await guard(makeWriteContext(absPath));
    expect(result?.block).toBe(true);
  });

  it('allows write when piece file is stored as absolute path', async () => {
    const absScopedPath = resolve(sandbox, 'src/foo.ts');
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: [absScopedPath],
    });
    const result = await guard(makeWriteContext('src/foo.ts'));
    expect(result).toBeUndefined();
  });

  it('returns undefined for write with empty path arg (malformed)', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeWriteContext(''));
    // Defer to the tool's own validation rather than masking with a spurious block.
    expect(result).toBeUndefined();
  });
});

// --- Edit tool — allow / block ---

describe('createPieceScopeGuard — edit tool', () => {
  it('allows edit to an in-scope file', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeEditContext('src/foo.ts'));
    expect(result).toBeUndefined();
  });

  it('blocks edit to an out-of-scope file', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeEditContext('src/unrelated.ts'));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Cannot modify');
    expect(result?.reason).toContain('src/unrelated.ts');
  });
});

// --- Other tools — never blocked ---

describe('createPieceScopeGuard — non-write/edit tools', () => {
  it('never blocks bash even with non-empty pieceFiles', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeBashContext('rm -rf /'));
    expect(result).toBeUndefined();
  });

  it('never blocks read', async () => {
    const guard = createPieceScopeGuard({
      cwd: sandbox,
      pieceFiles: ['src/foo.ts'],
    });
    const result = await guard(makeReadContext('src/anything.ts'));
    expect(result).toBeUndefined();
  });
});

// --- Composition ---

describe('composeBeforeToolCallHooks', () => {
  it('returns undefined when all hooks are undefined', () => {
    const composed = composeBeforeToolCallHooks([undefined, undefined]);
    expect(composed).toBeUndefined();
  });

  it('returns the single hook when only one is provided', async () => {
    const single = createPieceScopeGuard({ cwd: sandbox, pieceFiles: ['a.ts'] });
    const composed = composeBeforeToolCallHooks([undefined, single, undefined]);
    expect(composed).toBe(single);
  });

  it('runs all hooks in order, blocking on the first block:true', async () => {
    const scopeGuard = createPieceScopeGuard({ cwd: sandbox, pieceFiles: ['a.ts'] });
    let secondCalled = false;
    const secondHook = async () => {
      secondCalled = true;
      return undefined;
    };
    const composed = composeBeforeToolCallHooks([scopeGuard, secondHook]);
    expect(composed).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: just checked
    const result = await composed!(makeWriteContext('b.ts'));
    expect(result?.block).toBe(true);
    // First hook blocked → second hook should not run (short-circuit).
    expect(secondCalled).toBe(false);
  });

  it('returns undefined when no hook blocks', async () => {
    const scopeGuard = createPieceScopeGuard({ cwd: sandbox, pieceFiles: ['a.ts'] });
    const passthrough = async () => undefined;
    const composed = composeBeforeToolCallHooks([scopeGuard, passthrough]);
    // biome-ignore lint/style/noNonNullAssertion: just checked
    const result = await composed!(makeWriteContext('a.ts'));
    expect(result).toBeUndefined();
  });
});
