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
});
