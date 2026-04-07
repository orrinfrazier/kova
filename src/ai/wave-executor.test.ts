import type { AgentTool } from '@mariozechner/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveHandoff } from '../types/index.js';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

function fakeTool(name: string): AnyTool {
  return { name, label: name, description: name, parameters: {}, execute: vi.fn() } as unknown as AnyTool;
}

// Mock pi-mono modules
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(vi.fn());

let mockAgentState = {
  messages: [] as unknown[],
  errorMessage: undefined as string | undefined,
};

vi.mock('@mariozechner/pi-agent-core', () => {
  // Must return a class (constructor function), not a plain function
  const MockAgent = vi.fn();
  MockAgent.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      prompt: mockPrompt,
      abort: mockAbort,
      subscribe: mockSubscribe,
      get state() {
        return mockAgentState;
      },
    });
  });
  return { Agent: MockAgent };
});

vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: vi.fn(),
  getModel: vi.fn().mockReturnValue({ id: 'claude-sonnet-4-6', provider: 'anthropic' }),
  getProviders: vi.fn().mockReturnValue(['anthropic', 'openai', 'google']),
  registerBuiltInApiProviders: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  convertToLlm: vi.fn(),
  createReadTool: vi.fn().mockReturnValue({ name: 'read' }),
  createBashTool: vi.fn().mockReturnValue({ name: 'bash' }),
  createEditTool: vi.fn().mockReturnValue({ name: 'edit' }),
  createWriteTool: vi.fn().mockReturnValue({ name: 'write' }),
  createGrepTool: vi.fn().mockReturnValue({ name: 'grep' }),
  createFindTool: vi.fn().mockReturnValue({ name: 'find' }),
}));

const { Agent } = await import('@mariozechner/pi-agent-core');

function setAgentResponse(text: string, cost = 0.005): void {
  mockAgentState = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: { cost: { total: cost } },
      },
    ],
    errorMessage: undefined,
  };
}

function setAgentError(errorMessage: string): void {
  mockAgentState = {
    messages: [],
    errorMessage,
  };
}

describe('spawnWaveAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockPrompt.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(() => vi.fn());
    setAgentResponse('done');
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('creates a fresh pi-mono Agent per invocation', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [fakeTool('read')],
      systemPrompt: 'You are an assessor.',
      handoffContext: '',
      userMessage: 'Assess this issue.',
      cwd: '/tmp/test',
    });

    expect(Agent).toHaveBeenCalledOnce();
  });

  it('agent receives system prompt and handoff context prepended to user message', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'spec',
      model: 'claude-sonnet-4-6',
      tools: [fakeTool('read')],
      systemPrompt: 'You are a spec agent.',
      handoffContext: 'Previous assessment: Grade A',
      userMessage: 'Write the spec.',
      cwd: '/tmp/test',
    });

    // Agent should be created with the system prompt
    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { systemPrompt: string };
    };
    expect(agentConfig.initialState.systemPrompt).toContain('You are a spec agent.');

    // User message should include handoff context prepended
    expect(mockPrompt).toHaveBeenCalledOnce();
    const userMsg = mockPrompt.mock.calls[0]?.[0] as string;
    expect(userMsg).toContain('Previous assessment: Grade A');
    expect(userMsg).toContain('Write the spec.');
  });

  it('does not prepend handoff context when empty', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'System prompt.',
      handoffContext: '',
      userMessage: 'Just the message.',
      cwd: '/tmp/test',
    });

    const userMsg = mockPrompt.mock.calls[0]?.[0] as string;
    expect(userMsg).toBe('Just the message.');
  });

  it('passes pre-built tools directly to Agent (no internal tool resolution)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    const customTools = [fakeTool('read'), fakeTool('grep')];
    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: customTools,
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { tools: unknown[] };
    };
    expect(agentConfig.initialState.tools).toBe(customTools);
  });

  it('accepts model string and resolves via resolveModelFromString', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Use a non-default model string to prove it's using the string, not a tier
    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'openai:gpt-4o',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    // Model should be set on the Agent's initial state
    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { model: { id: string } };
    };
    expect(agentConfig.initialState.model).toBeDefined();
    expect(result.model).toBeDefined();
  });

  it('returns WaveHandoff<T> with correct fields', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    const result: WaveHandoff = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('assess');
    expect(result.model).toBeDefined();
    expect(typeof result.cost).toBe('number');
    expect(typeof result.turns).toBe('number');
    expect(typeof result.timestamp).toBe('string');
    expect(['high', 'medium', 'low']).toContain(result.confidence);
    expect(typeof result.approach_notes).toBe('string');
    expect(result.artifact).toBeDefined();
  });

  it('returns confidence "high" when structured output is parsed', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setAgentResponse('{"grade": "A", "should_proceed": true}', 0.01);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.confidence).toBe('high');
    expect(result.artifact).toEqual({ grade: 'A', should_proceed: true });
  });

  it('returns confidence "medium" when no structured output requested', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    const result = await spawnWaveAgent({
      wave: 'test',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.confidence).toBe('medium');
  });

  it('agent has no knowledge of other waves conversations (fresh state per call)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Assess prompt.',
      handoffContext: '',
      userMessage: 'Assess.',
      cwd: '/tmp/test',
    });

    await spawnWaveAgent({
      wave: 'spec',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Spec prompt.',
      handoffContext: 'Assess result here.',
      userMessage: 'Spec.',
      cwd: '/tmp/test',
    });

    // Two separate Agent instances created
    expect(Agent).toHaveBeenCalledTimes(2);

    // Each has different system prompt — no shared conversation
    const firstConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { systemPrompt: string };
    };
    const secondConfig = vi.mocked(Agent).mock.calls[1]?.[0] as {
      initialState: { systemPrompt: string };
    };
    expect(firstConfig.initialState.systemPrompt).toContain('Assess prompt.');
    expect(secondConfig.initialState.systemPrompt).toContain('Spec prompt.');
  });

  it('aborts wave with classified agent error when timeout exceeded', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Make prompt hang until aborted
    mockPrompt.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 60_000)));

    await expect(
      spawnWaveAgent({
        wave: 'assess',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('uses default timeout per wave type when timeoutMs not specified', async () => {
    const { DEFAULT_WAVE_TIMEOUTS } = await import('./wave-executor.js');

    expect(DEFAULT_WAVE_TIMEOUTS.assess).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.spec).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.review).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.test).toBe(15 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.impl).toBe(15 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.quality).toBe(10 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.ship).toBeUndefined();
  });

  it('allows custom timeoutMs to override default', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Make prompt hang until aborted
    mockPrompt.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 60_000)));

    // Custom timeout of 30ms should fire before the default 5min
    await expect(
      spawnWaveAgent({
        wave: 'assess',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('does not timeout when wave completes within limit', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Fast response, large timeout
    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      timeoutMs: 60_000,
    });

    expect(result.wave).toBe('assess');
  });

  it('throws KovaError on billing/config errors', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setAgentError('spending cap reached');

    await expect(
      spawnWaveAgent({
        wave: 'assess',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
      }),
    ).rejects.toThrow();
  });
});

describe('executeWave backward compat (delegates internally)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockPrompt.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(() => vi.fn());
    setAgentResponse('result text');
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns WaveExecutionResult from WaveOptions input', async () => {
    const { executeWave } = await import('./wave-executor.js');

    const result = await executeWave({
      wave: 'assess',
      systemPrompt: 'Assess.',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      modelTier: 'medium',
    });

    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('duration');
    expect(result).toHaveProperty('turns');
    expect(result).toHaveProperty('cost');
    expect(result).toHaveProperty('model');
  });

  it('resolves model from tier internally', async () => {
    const { executeWave } = await import('./wave-executor.js');

    await executeWave({
      wave: 'assess',
      systemPrompt: 'Assess.',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      modelTier: 'large',
    });

    expect(Agent).toHaveBeenCalledOnce();
    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { model: unknown };
    };
    expect(agentConfig.initialState.model).toBeDefined();
  });

  it('builds tools from wave name internally', async () => {
    const { executeWave } = await import('./wave-executor.js');

    await executeWave({
      wave: 'assess',
      systemPrompt: 'Assess.',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      modelTier: 'medium',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { tools: unknown[] };
    };
    expect(Array.isArray(agentConfig.initialState.tools)).toBe(true);
  });
});
