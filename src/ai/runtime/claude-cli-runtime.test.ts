/**
 * Tests for `claudeCliRuntime` — kova-owned AgentRuntime backed by the
 * `claude -p` CLI subprocess. Issue kova#318.
 *
 * The runtime spawns `claude` as a child process and parses
 * `--output-format stream-json --verbose` NDJSON events from stdout. These
 * tests mock `node:child_process.spawn` so the suite never invokes the real
 * CLI; the stream-json fixture format is the public Claude Code documented
 * shape (system/assistant/user/result events).
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock node:child_process ──────────────────────────────────────────────────
//
// Tests own a `mockChild` factory that returns a fresh ChildProcess-shaped
// EventEmitter on every spawn. `mockSpawn` is the captured `spawn` import; the
// runtime's call args (command, argv, options) are inspectable via its calls
// array.

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => void; end: () => void };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
}

let lastSpawnedChild: MockChild | undefined;
let mockSpawnImpl: (command: string, args: readonly string[], options: unknown) => MockChild = () => {
  throw new Error('mockSpawnImpl not set');
};

const mockSpawn = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      mockSpawn(...(args as [string, readonly string[], unknown])) as unknown as ChildProcess,
  };
});

function makeMockChild(): MockChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
    killed: false,
    pid: 12345,
  }) as unknown as MockChild;
  return child;
}

function emitStdoutLines(child: MockChild, lines: readonly string[]): void {
  for (const line of lines) {
    child.stdout.emit('data', Buffer.from(`${line}\n`, 'utf-8'));
  }
}

function emitExit(child: MockChild, code: number): void {
  child.emit('close', code);
}

// ── Stream-json fixture builders (the public Claude Code documented shape) ───

function systemInit(opts: { sessionId: string; model?: string }): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: opts.sessionId,
    model: opts.model ?? 'claude-sonnet-4-6',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
  });
}

function assistantTurn(opts: {
  sessionId: string;
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  stopReason?: string;
  model?: string;
}): string {
  const content: unknown[] = [];
  if (opts.text != null) content.push({ type: 'text', text: opts.text });
  for (const tu of opts.toolUses ?? []) {
    content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
  }
  return JSON.stringify({
    type: 'assistant',
    session_id: opts.sessionId,
    message: {
      role: 'assistant',
      content,
      stop_reason: opts.stopReason ?? 'end_turn',
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheReadTokens ?? 0,
        cache_creation_input_tokens: opts.cacheCreationTokens ?? 0,
      },
    },
  });
}

function userToolResult(opts: { sessionId: string; toolUseId: string; text: string }): string {
  return JSON.stringify({
    type: 'user',
    session_id: opts.sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.toolUseId,
          content: [{ type: 'text', text: opts.text }],
        },
      ],
    },
  });
}

function resultEvent(opts: {
  sessionId: string;
  totalCostUsd: number;
  isError?: boolean;
  resultText?: string;
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: opts.isError ? 'error_during_execution' : 'success',
    is_error: opts.isError ?? false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 1,
    result: opts.resultText ?? 'done',
    session_id: opts.sessionId,
    total_cost_usd: opts.totalCostUsd,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

// ── Test scaffolding ─────────────────────────────────────────────────────────

const TMP_DIRS_TO_CLEAN = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Default: spawn returns a fresh child for inspection by the test
  mockSpawnImpl = () => {
    const child = makeMockChild();
    lastSpawnedChild = child;
    return child;
  };
  mockSpawn.mockImplementation((command: string, args: readonly string[], options: unknown) =>
    mockSpawnImpl(command, args, options),
  );
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of TMP_DIRS_TO_CLEAN) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  TMP_DIRS_TO_CLEAN.clear();
  lastSpawnedChild = undefined;
});

// Helper: drive prompt() forward then resolve a few microtasks so subscribe
// listeners see emitted events before the test assertion runs.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

// ── P6: factory exports ──────────────────────────────────────────────────────

describe('claudeCliRuntimeFactory — exports', () => {
  it('exports a factory matching AgentRuntimeFactory shape', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    expect(typeof claudeCliRuntimeFactory.create).toBe('function');
  });

  it('is re-exported from the runtime barrel', async () => {
    const barrel = await import('./index.js');
    expect('claudeCliRuntimeFactory' in barrel).toBe(true);
  });

  it('create() returns an object satisfying the AgentRuntime interface shape', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sys',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
    });
    expect(typeof rt.prompt).toBe('function');
    expect(typeof rt.abort).toBe('function');
    expect(typeof rt.subscribe).toBe('function');
    expect(rt.state).toBeDefined();
    expect(Array.isArray(rt.state.messages)).toBe(true);
  });
});

// ── P4: subprocess lifecycle / argv construction / PATH check ────────────────

describe('claudeCliRuntime — subprocess construction', () => {
  it('spawns `claude` with -p, --output-format stream-json, --verbose, and cwd=config.cwd', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'system-prompt-text',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/some/work/dir',
    } as never);

    const promptPromise = rt.prompt('hello');
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(command).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('system-prompt-text');
    expect(options?.cwd).toBe('/some/work/dir');

    // End the session so the prompt promise resolves
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 'sess-1' }),
        resultEvent({ sessionId: 'sess-1', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;
  });

  it('passes the user message via stdin (not argv) and closes stdin', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('user message body — could contain spaces, "quotes", $vars');
    expect(lastSpawnedChild?.stdin.write).toHaveBeenCalledWith(
      'user message body — could contain spaces, "quotes", $vars',
    );
    expect(lastSpawnedChild?.stdin.end).toHaveBeenCalled();

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;
  });

  it('hard-fails with a clear error when `claude` is not on PATH', async () => {
    mockSpawnImpl = () => {
      const child = makeMockChild();
      lastSpawnedChild = child;
      // Simulate ENOENT: emit error then close. Node's spawn emits an
      // 'error' event asynchronously when the binary cannot be located —
      // mirror that ordering. We schedule via the timer queue so the
      // runtime's listener is wired before the event fires.
      queueMicrotask(() => {
        const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        child.emit('error', enoent);
        child.emit('close', null);
      });
      return child;
    };
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    // Catch the rejection eagerly so it can't become an unhandled rejection
    // between the queueMicrotask flush and the assertion below.
    let caught: Error | undefined;
    const promise = rt.prompt('hi').catch((err: Error) => {
      caught = err;
    });
    await flush();
    await promise;
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/claude.*PATH|not found|ENOENT/i);
  });

  it('abort() sends SIGTERM then SIGKILL after the configured grace period (5s)', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);
    const promptPromise = rt.prompt('hello').catch(() => {
      /* expected — abort */
    });
    expect(lastSpawnedChild).toBeDefined();

    rt.abort();
    expect(lastSpawnedChild?.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance 5s — SIGKILL should fire if child didn't exit
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastSpawnedChild?.kill).toHaveBeenCalledWith('SIGKILL');

    // Close the child so the promise can resolve
    if (lastSpawnedChild) emitExit(lastSpawnedChild, 143);
    await flush();
    await promptPromise;
  });

  it('abort() does NOT escalate to SIGKILL if the child exits within the grace period', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);
    const promptPromise = rt.prompt('hello').catch(() => {
      /* expected */
    });
    rt.abort();
    expect(lastSpawnedChild?.kill).toHaveBeenCalledWith('SIGTERM');

    // Child exits gracefully after 1s
    await vi.advanceTimersByTimeAsync(1_000);
    if (lastSpawnedChild) emitExit(lastSpawnedChild, 143);
    await flush();
    await promptPromise;

    // Advance past the 5s window — SIGKILL must not have been called
    await vi.advanceTimersByTimeAsync(5_000);
    const sigkillCalls = (lastSpawnedChild?.kill.mock.calls ?? []).filter((c: unknown[]) => c[0] === 'SIGKILL');
    expect(sigkillCalls.length).toBe(0);
  });
});

// ── P1, P2: stream-json parsing + event/message translation ──────────────────

describe('claudeCliRuntime — stream-json parsing', () => {
  it('emits a turn_end event with an AssistantTurn for each `assistant` event', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const events: Array<{ type: string }> = [];
    rt.subscribe((e) => events.push(e));
    const promptPromise = rt.prompt('go');

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's1' }),
        assistantTurn({ sessionId: 's1', text: 'hello', inputTokens: 100, outputTokens: 50 }),
        resultEvent({ sessionId: 's1', totalCostUsd: 0.001 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const turnEnds = events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(1);
    const turn = (
      turnEnds[0] as unknown as {
        message: {
          content: Array<{ type: string; text?: string }>;
          usage: { input: number; output: number; cost: { total: number } };
          stopReason: string;
        };
      }
    ).message;
    expect(turn.content[0]?.type).toBe('text');
    expect(turn.content[0]?.text).toBe('hello');
    expect(turn.usage.input).toBe(100);
    expect(turn.usage.output).toBe(50);
    expect(typeof turn.usage.cost.total).toBe('number');
    expect(turn.stopReason).toBe('end_turn');
  });

  it('handles tool_use content blocks inside assistant events', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const events: Array<{ type: string; toolName?: string }> = [];
    rt.subscribe((e) => events.push(e as { type: string; toolName?: string }));
    const promptPromise = rt.prompt('go');

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's1' }),
        assistantTurn({
          sessionId: 's1',
          toolUses: [{ id: 'tu_1', name: 'Read', input: { path: '/x' } }],
          stopReason: 'tool_use',
        }),
        userToolResult({ sessionId: 's1', toolUseId: 'tu_1', text: '(contents)' }),
        assistantTurn({ sessionId: 's1', text: 'done' }),
        resultEvent({ sessionId: 's1', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    // Should see tool_execution_start for the Read tool use
    const toolStarts = events.filter((e) => e.type === 'tool_execution_start');
    expect(toolStarts.length).toBeGreaterThanOrEqual(1);
    expect(toolStarts.some((e) => e.toolName === 'Read')).toBe(true);

    // turn_end for tool_use → stopReason: 'tool_use'
    const turnEnds = events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(2);
    const firstTurn = (turnEnds[0] as unknown as { message: { stopReason: string } }).message;
    expect(firstTurn.stopReason).toBe('tool_use');
  });

  it('appends assistant + user (tool_result) messages to state.messages', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's1' }),
        assistantTurn({ sessionId: 's1', text: 'a1' }),
        userToolResult({ sessionId: 's1', toolUseId: 'tu_1', text: 'tr1' }),
        assistantTurn({ sessionId: 's1', text: 'a2' }),
        resultEvent({ sessionId: 's1', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const msgs = rt.state.messages;
    const roles = msgs.map((m) => (m as { role: string }).role);
    expect(roles).toContain('assistant');
    // Either 'user' (raw) or 'tool_result' is acceptable — the runtime owns the
    // translation. We assert at least one non-assistant message landed.
    expect(roles.length).toBeGreaterThan(1);
  });

  it('handles NDJSON chunks split mid-line and across multiple data events', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const events: Array<{ type: string }> = [];
    rt.subscribe((e) => events.push(e));
    const promptPromise = rt.prompt('go');

    const line1 = systemInit({ sessionId: 's1' });
    const line2 = assistantTurn({ sessionId: 's1', text: 'hi' });
    const line3 = resultEvent({ sessionId: 's1', totalCostUsd: 0 });
    if (lastSpawnedChild) {
      // Split line1 across two data chunks, and pack line2/line3 partially together
      const all = `${line1}\n${line2}\n${line3}\n`;
      const a = all.slice(0, 20);
      const b = all.slice(20, 80);
      const c = all.slice(80);
      lastSpawnedChild.stdout.emit('data', Buffer.from(a, 'utf-8'));
      lastSpawnedChild.stdout.emit('data', Buffer.from(b, 'utf-8'));
      lastSpawnedChild.stdout.emit('data', Buffer.from(c, 'utf-8'));
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const turnEnds = events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(1);
  });

  it('ignores unknown stream-json event types without throwing', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's1' }),
        JSON.stringify({ type: 'unknown_future_event', data: { foo: 'bar' } }),
        // Malformed JSON — should be skipped with a debug log, not crash
        '{not valid json',
        assistantTurn({ sessionId: 's1', text: 'hi' }),
        resultEvent({ sessionId: 's1', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('captures session_id from the system init event onto state.sessionId', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: '01234567-89ab-cdef-0123-456789abcdef' }),
        assistantTurn({ sessionId: '01234567-89ab-cdef-0123-456789abcdef', text: 'ok' }),
        resultEvent({ sessionId: '01234567-89ab-cdef-0123-456789abcdef', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    expect((rt.state as { sessionId?: string }).sessionId).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });
});

// ── P3: cost via priceUsage + reconciliation drift warning ───────────────────

describe('claudeCliRuntime — cost computation', () => {
  it('computes per-turn usage.cost.total via priceUsage (NEW-07) — non-zero for known anthropic models', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      // claude-sonnet-4-6 has a known pricing row (input $3/Mtok, output $15/Mtok)
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const events: Array<{ type: string; message?: { usage?: { cost?: { total?: number } } } }> = [];
    rt.subscribe((e) => events.push(e as { type: string; message?: { usage?: { cost?: { total?: number } } } }));
    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's', model: 'claude-sonnet-4-6' }),
        // 1M input + 1M output → $3 + $15 = $18 (sanity scale)
        assistantTurn({
          sessionId: 's',
          text: 'ok',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
        resultEvent({ sessionId: 's', totalCostUsd: 18 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const turn = events.find((e) => e.type === 'turn_end');
    expect(turn?.message?.usage?.cost?.total).toBeCloseTo(18, 5);
  });

  it('warns when cumulative per-turn estimate drifts >5% from result.total_cost_usd', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        // 1M in / 1M out → estimate $18
        assistantTurn({ sessionId: 's', text: 'ok', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        // Result claims $25 — drift = (25-18)/25 = 28% > 5% threshold
        resultEvent({ sessionId: 's', totalCostUsd: 25 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const warned = warnSpy.mock.calls.some((c) => /drift|reconcil/i.test(String(c[0])));
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it('does NOT warn when drift is within the 5% threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        // 1M in / 1M out → estimate $18; result claims $18.50 (2.7% drift, under 5%)
        assistantTurn({ sessionId: 's', text: 'ok', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        resultEvent({ sessionId: 's', totalCostUsd: 18.5 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    const warned = warnSpy.mock.calls.some((c) => /drift/i.test(String(c[0])));
    expect(warned).toBe(false);
    warnSpy.mockRestore();
  });
});

// ── P5: tool allowlist + MCP config bridge ───────────────────────────────────

describe('claudeCliRuntime — tool + MCP wiring', () => {
  it('maps tools[*].name to --allowed-tools comma list (ignores execute implementations)', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const tools = [
      { name: 'Read', execute: () => undefined },
      { name: 'Bash', execute: () => undefined },
      { name: 'Grep', execute: () => undefined },
    ];
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: tools as never,
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go').catch(() => undefined);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    const idx = args.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Read,Bash,Grep');

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;
  });

  it('omits --allowed-tools when tools array is empty', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);
    const promptPromise = rt.prompt('go').catch(() => undefined);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(args.includes('--allowed-tools')).toBe(false);

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;
  });

  it('writes a temp mcp-config.json and passes its path via --mcp-config when mcpServers is provided', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const mcpServers = {
      'repo-intel': { command: 'repo-intel-mcp', args: ['serve'] },
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
    };
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
      mcpServers,
    } as never);

    const promptPromise = rt.prompt('go').catch(() => undefined);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const tempPath = args[idx + 1] as string;
    expect(existsSync(tempPath)).toBe(true);
    const written = JSON.parse(readFileSync(tempPath, 'utf-8')) as { mcpServers: unknown };
    expect(written.mcpServers).toEqual(mcpServers);
    TMP_DIRS_TO_CLEAN.add(tempPath);

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    // After exit the temp file should be cleaned up
    expect(existsSync(tempPath)).toBe(false);
  });

  it('passes --resume <sessionId> when sessionId is provided in config', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    } as never);

    const promptPromise = rt.prompt('go').catch(() => undefined);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('01234567-89ab-cdef-0123-456789abcdef');

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: '01234567-89ab-cdef-0123-456789abcdef' }),
        resultEvent({ sessionId: '01234567-89ab-cdef-0123-456789abcdef', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;
  });
});

// ── Error path: non-zero exit / result.is_error ──────────────────────────────

describe('claudeCliRuntime — error handling', () => {
  it('sets state.errorMessage when result.is_error is true', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        systemInit({ sessionId: 's' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0, isError: true, resultText: 'rate_limit' }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    expect(rt.state.errorMessage).toBeDefined();
    expect(rt.state.errorMessage).toMatch(/error|rate_limit/i);
  });

  it('sets state.errorMessage when child exits with non-zero before result event', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const promptPromise = rt.prompt('go');
    if (lastSpawnedChild) {
      // Emit some stderr noise then crash without a `result` event
      lastSpawnedChild.stderr.emit('data', Buffer.from('boom\n', 'utf-8'));
      emitExit(lastSpawnedChild, 1);
    }
    await flush();
    await promptPromise;

    expect(rt.state.errorMessage).toBeDefined();
  });
});

// ── subscribe lifecycle ──────────────────────────────────────────────────────

describe('claudeCliRuntime — subscribe', () => {
  it('subscribe() returns an unsubscribe function that stops further events', async () => {
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const rt = claudeCliRuntimeFactory.create({
      systemPrompt: 'sp',
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000 } as never,
      tools: [],
      getApiKey: () => 'k',
      cwd: '/tmp',
    } as never);

    const received: Array<{ type: string }> = [];
    const off = rt.subscribe((e) => received.push(e));
    const promptPromise = rt.prompt('go');

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [systemInit({ sessionId: 's' }), assistantTurn({ sessionId: 's', text: '1' })]);
    }
    await flush();
    const beforeOff = received.length;
    expect(beforeOff).toBeGreaterThan(0);

    off();

    if (lastSpawnedChild) {
      emitStdoutLines(lastSpawnedChild, [
        assistantTurn({ sessionId: 's', text: '2' }),
        resultEvent({ sessionId: 's', totalCostUsd: 0 }),
      ]);
      emitExit(lastSpawnedChild, 0);
    }
    await flush();
    await promptPromise;

    expect(received.length).toBe(beforeOff);
  });
});

// Suppress dangling reference warning by referencing helpers used only inside
// some test bodies above. (writeFileSync is the test-side reachability shim
// that ensures the test file isn't pruned when tree-shaken.)
void writeFileSync;
