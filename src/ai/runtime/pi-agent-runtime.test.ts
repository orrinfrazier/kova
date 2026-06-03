import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pi-mono Agent to capture construction args
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockSteer = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
const mockAgentState = { messages: [] as unknown[], errorMessage: undefined as string | undefined };

vi.mock('@earendil-works/pi-agent-core', () => {
  const MockAgent = vi.fn();
  MockAgent.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      prompt: mockPrompt,
      abort: mockAbort,
      steer: mockSteer,
      subscribe: mockSubscribe,
      transformContext: undefined,
      get state() {
        return mockAgentState;
      },
    });
  });
  return { Agent: MockAgent };
});

vi.mock('@earendil-works/pi-ai', () => ({
  streamSimple: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  convertToLlm: vi.fn(),
}));

describe('defaultAgentRuntimeFactory (PiAgentRuntime stub)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockAgentState.messages = [];
    mockAgentState.errorMessage = undefined;
  });

  it('create() returns an object satisfying the AgentRuntime interface shape', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 'system',
      model: { id: 'm', provider: 'anthropic', contextWindow: 100_000 } as never,
      tools: [],
      getApiKey: () => 'k',
    });
    expect(typeof rt.prompt).toBe('function');
    expect(typeof rt.abort).toBe('function');
    expect(typeof rt.subscribe).toBe('function');
    expect(rt.state).toBeDefined();
    expect(Array.isArray(rt.state.messages)).toBe(true);
  });

  it('create() forwards systemPrompt, model, tools to the underlying Agent', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const { Agent } = await import('@earendil-works/pi-agent-core');

    const model = { id: 'gpt-4o', provider: 'openai', contextWindow: 128_000 } as never;
    const tools = [{ name: 't1' }, { name: 't2' }] as never[];

    defaultAgentRuntimeFactory.create({
      systemPrompt: 'sys-prompt',
      model,
      thinkingLevel: 'medium' as never,
      tools,
      getApiKey: (p: string) => (p === 'openai' ? 'openai-key' : undefined),
    });

    expect(Agent).toHaveBeenCalledOnce();
    const cfg = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { systemPrompt: string; model: unknown; tools: unknown; thinkingLevel: string };
      getApiKey: (p: string) => string | undefined;
    };
    expect(cfg.initialState.systemPrompt).toBe('sys-prompt');
    expect(cfg.initialState.model).toBe(model);
    expect(cfg.initialState.tools).toBe(tools);
    expect(cfg.initialState.thinkingLevel).toBe('medium');
    expect(cfg.getApiKey('openai')).toBe('openai-key');
  });

  it('prompt(msg) delegates to the underlying Agent.prompt', async () => {
    mockPrompt.mockResolvedValue(undefined);
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt.prompt('hello');
    expect(mockPrompt).toHaveBeenCalledWith('hello');
  });

  it('abort() delegates to the underlying Agent.abort', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    rt.abort();
    expect(mockAbort).toHaveBeenCalledOnce();
  });

  it('subscribe(listener) registers via underlying Agent.subscribe and returns unsubscribe', async () => {
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const listener = vi.fn();
    const off = rt.subscribe(listener);
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(typeof off).toBe('function');
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('state proxies the underlying Agent.state', async () => {
    mockAgentState.messages = [{ role: 'user', content: 'x' }];
    mockAgentState.errorMessage = 'boom';
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    expect(rt.state.messages).toEqual([{ role: 'user', content: 'x' }]);
    expect(rt.state.errorMessage).toBe('boom');
  });

  it('forwards sessionId to the underlying Agent constructor (issue #297)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const { Agent } = await import('@earendil-works/pi-agent-core');
    defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
      sessionId: 'kova-foo-bar-impl',
    });
    const cfg = vi.mocked(Agent).mock.calls[0]?.[0] as { sessionId?: string };
    expect(cfg.sessionId).toBe('kova-foo-bar-impl');
  });

  it('does not set sessionId on the Agent when none is provided (issue #297)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const { Agent } = await import('@earendil-works/pi-agent-core');
    defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const cfg = vi.mocked(Agent).mock.calls[0]?.[0] as { sessionId?: string };
    expect(cfg.sessionId).toBeUndefined();
  });

  it('wraps streamFn with cacheRetention when retention is set (issue #297)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const piAi = await import('@earendil-works/pi-ai');
    defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
      cacheRetention: 'long',
    });
    const cfg = vi.mocked(Agent).mock.calls[0]?.[0] as {
      streamFn?: (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown;
    };
    expect(typeof cfg.streamFn).toBe('function');
    vi.mocked(piAi.streamSimple).mockReturnValue('STREAM' as unknown as never);
    cfg.streamFn?.({ id: 'm', provider: 'anthropic' }, {}, { foo: 'bar' });
    const passed = vi.mocked(piAi.streamSimple).mock.calls[0]?.[2] as
      | { cacheRetention?: string; foo?: string }
      | undefined;
    expect(passed?.cacheRetention).toBe('long');
    expect(passed?.foo).toBe('bar');
  });

  it('uses pi-ai streamSimple directly when no cacheRetention override is set (issue #297)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const piAi = await import('@earendil-works/pi-ai');
    defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const cfg = vi.mocked(Agent).mock.calls[0]?.[0] as { streamFn?: unknown };
    // When no retention override is set, the canonical streamSimple is passed through
    // (no wrapper allocation) so the agent-loop sees the same function reference.
    expect(cfg.streamFn).toBe(piAi.streamSimple);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Issue #310 — Full PiAgentRuntime extraction: event + message translation
// ────────────────────────────────────────────────────────────────────────────

describe('PiAgentRuntime — event translation (issue #310)', () => {
  let capturedListener: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedListener = undefined;
    // Capture the listener pi-agent-runtime registers so we can drive pi-mono
    // events through it and observe the translated kova RuntimeEvents.
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      capturedListener = cb;
      return vi.fn();
    });
  });

  afterEach(() => {
    mockAgentState.messages = [];
    mockAgentState.errorMessage = undefined;
  });

  it('translates pi-mono stopReason "stop" → kova "end_turn"', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    // Pi-mono uses `stopReason: 'stop'`; kova-runtime exposes `'end_turn'`.
    capturedListener?.({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'stop',
      },
      toolResults: [],
    });
    expect(received).toHaveLength(1);
    const ev = received[0] as { type: string; message: { stopReason: string } };
    expect(ev.type).toBe('turn_end');
    expect(ev.message.stopReason).toBe('end_turn');
  });

  it('translates pi-mono stopReason "length" → kova "max_turns"', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    capturedListener?.({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'length',
      },
      toolResults: [],
    });
    const ev = received[0] as { message: { stopReason: string } };
    expect(ev.message.stopReason).toBe('max_turns');
  });

  it('translates pi-mono stopReason "toolUse" → kova "tool_use"', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    capturedListener?.({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'toolUse',
      },
      toolResults: [],
    });
    const ev = received[0] as { message: { stopReason: string } };
    expect(ev.message.stopReason).toBe('tool_use');
  });

  it('preserves pi-mono stopReason "error" verbatim (kova-shared literal)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    capturedListener?.({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'error',
        errorMessage: 'boom',
      },
      toolResults: [],
    });
    const ev = received[0] as { message: { stopReason: string; errorMessage: string } };
    expect(ev.message.stopReason).toBe('error');
    expect(ev.message.errorMessage).toBe('boom');
  });

  it('passes through turn_end events when message is absent (back-compat for non-assistant turns)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    // Some pi-mono turn_end events fire without an assistant message (e.g. tool-only turns).
    // Wave-executor reads `event.message` defensively, so passing through is the safe behavior.
    capturedListener?.({ type: 'turn_end', toolResults: [] });
    expect(received).toHaveLength(1);
    const ev = received[0] as { type: string; message?: unknown };
    expect(ev.type).toBe('turn_end');
    expect(ev.message).toBeUndefined();
  });

  it('translates pi-mono content "toolCall" blocks → kova "tool_use" blocks', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    capturedListener?.({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'toolCall', id: 'tc_1', name: 'Read', arguments: { path: '/x' } },
        ],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'toolUse',
      },
      toolResults: [],
    });
    const ev = received[0] as {
      message: { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
    };
    expect(ev.message.content).toHaveLength(2);
    expect(ev.message.content[0]?.type).toBe('text');
    expect(ev.message.content[1]?.type).toBe('tool_use');
    expect(ev.message.content[1]?.id).toBe('tc_1');
    expect(ev.message.content[1]?.name).toBe('Read');
    expect(ev.message.content[1]?.input).toEqual({ path: '/x' });
  });

  it('forwards tool_execution_start events with toolName', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    // Pi-mono `tool_execution_start` carries toolCallId, toolName, args; kova
    // RuntimeEvent only declares toolName.
    capturedListener?.({
      type: 'tool_execution_start',
      toolCallId: 'tc_99',
      toolName: 'Bash',
      args: { command: 'ls' },
    });
    expect(received).toHaveLength(1);
    const ev = received[0] as { type: string; toolName: string };
    expect(ev.type).toBe('tool_execution_start');
    expect(ev.toolName).toBe('Bash');
  });

  it('drops pi-mono events not in the kova RuntimeEvent union (agent_start, message_update, etc.)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    rt.subscribe((ev) => received.push(ev));
    // None of these are part of the kova RuntimeEvent surface — the adapter
    // must not surface them (they are debug-only and would just noise the
    // wave-executor's subscriber).
    capturedListener?.({ type: 'agent_start' });
    capturedListener?.({ type: 'agent_end', messages: [] });
    capturedListener?.({ type: 'turn_start' });
    capturedListener?.({ type: 'message_update', message: {}, assistantMessageEvent: {} });
    capturedListener?.({ type: 'message_end', message: {} });
    capturedListener?.({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'Read', result: {}, isError: false });
    expect(received).toHaveLength(0);
  });

  it('subscribe() returns an unsubscribe function that detaches the wrapped listener', async () => {
    const piMonoUnsubscribe = vi.fn();
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      capturedListener = cb;
      return piMonoUnsubscribe;
    });
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: unknown[] = [];
    const off = rt.subscribe((ev) => received.push(ev));
    off();
    expect(piMonoUnsubscribe).toHaveBeenCalledOnce();
    // After unsubscribe, the wrapped listener should not propagate events.
    // (Strictly speaking pi-mono won't deliver them after unsubscribe, but if
    // a stale call somehow arrived, the wrapper should noop.)
  });
});

describe('PiAgentRuntime — state.messages translation (issue #310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockAgentState.messages = [];
    mockAgentState.errorMessage = undefined;
  });

  it('translates assistant messages in state.messages — stopReason normalized', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    mockAgentState.messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input: 5, output: 3, cost: { total: 0.001 } },
        stopReason: 'stop',
      },
    ];
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const msgs = rt.state.messages;
    expect(msgs).toHaveLength(2);
    const assistant = msgs[1] as { role: string; stopReason: string };
    expect(assistant.role).toBe('assistant');
    expect(assistant.stopReason).toBe('end_turn');
  });

  it('translates "toolCall" content blocks in state.messages → "tool_use"', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    mockAgentState.messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'Read', arguments: { path: '/y' } }],
        usage: { input: 1, output: 1, cost: { total: 0 } },
        stopReason: 'toolUse',
      },
    ];
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const msgs = rt.state.messages;
    const content = (
      msgs[0] as unknown as { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> }
    ).content;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('tool_use');
    expect(content[0]?.id).toBe('t1');
    expect(content[0]?.name).toBe('Read');
    expect(content[0]?.input).toEqual({ path: '/y' });
  });

  it('passes through tool-result messages (role: "toolResult" is accepted by the kova union)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    mockAgentState.messages = [
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'Read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      },
    ];
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const msgs = rt.state.messages;
    expect(msgs).toHaveLength(1);
    const tr = msgs[0] as { role: string; toolCallId: string; toolName: string };
    expect(tr.role).toBe('toolResult');
    expect(tr.toolCallId).toBe('t1');
    expect(tr.toolName).toBe('Read');
  });

  it('proxies state.errorMessage from the underlying Agent', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    mockAgentState.errorMessage = 'rate-limit';
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    expect(rt.state.errorMessage).toBe('rate-limit');
  });

  it('state.messages is a live view (re-reads the underlying Agent on every access)', async () => {
    const { defaultAgentRuntimeFactory } = await import('./index.js');
    const rt = defaultAgentRuntimeFactory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    expect(rt.state.messages).toHaveLength(0);
    mockAgentState.messages = [{ role: 'user', content: 'late' }];
    expect(rt.state.messages).toHaveLength(1);
  });
});
