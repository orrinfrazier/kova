import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WaveHandoff } from '../types/index.js';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

function fakeTool(name: string): AnyTool {
  return { name, label: name, description: name, parameters: {}, execute: vi.fn() } as unknown as AnyTool;
}

// Mock pi-mono modules
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockSteer = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(vi.fn());

let mockAgentState = {
  messages: [] as unknown[],
  errorMessage: undefined as string | undefined,
};

vi.mock('@earendil-works/pi-agent-core', () => {
  // Must return a class (constructor function), not a plain function
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
  getModel: vi.fn().mockReturnValue({
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxTokens: 8_192,
  }),
  getProviders: vi.fn().mockReturnValue(['anthropic', 'openai', 'google']),
  registerBuiltInApiProviders: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  convertToLlm: vi.fn(),
  createReadTool: vi.fn().mockReturnValue({ name: 'read' }),
  createBashTool: vi.fn().mockReturnValue({ name: 'bash' }),
  createEditTool: vi.fn().mockReturnValue({ name: 'edit' }),
  createWriteTool: vi.fn().mockReturnValue({ name: 'write' }),
  createGrepTool: vi.fn().mockReturnValue({ name: 'grep' }),
  createFindTool: vi.fn().mockReturnValue({ name: 'find' }),
}));

vi.mock('./router.js', () => ({
  isRouterProvider: (p: string) => p === 'router',
  isRouterEnabled: () => false,
  createRouterModel: (modelId?: string) => ({
    id: modelId ?? 'claude-sonnet-4-6',
    name: modelId ?? 'claude-sonnet-4-6',
    api: 'anthropic-messages',
    provider: 'router',
    baseUrl: 'http://localhost:4141',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  }),
  resolveRouterApiKey: () => 'mock-router-key',
}));

const { Agent } = await import('@earendil-works/pi-agent-core');

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

  it('returns confidence "high" when zodSchema is provided and validation passes', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    const TestSchema = z.object({ grade: z.string(), should_proceed: z.boolean() });
    setAgentResponse('{"grade": "A", "should_proceed": true}', 0.01);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: TestSchema,
      },
    });

    expect(result.confidence).toBe('high');
    expect(result.artifact).toEqual({ grade: 'A', should_proceed: true });
  });

  it('returns confidence "low" when JSON is valid but zodSchema validation fails', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    const StrictSchema = z.object({
      grade: z.enum(['A', 'B', 'C', 'D', 'F']),
      surface_area: z.object({ files: z.array(z.string()) }),
    });
    // Valid JSON but doesn't match StrictSchema
    setAgentResponse('{"random": "garbage"}', 0.01);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: StrictSchema,
      },
    });

    expect(result.confidence).toBe('low');
    // artifact should still be the raw parsed JSON (not undefined)
    expect(result.artifact).toEqual({ random: 'garbage' });
  });

  it('logs warning when zodSchema validation fails', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const warnSpy = vi.spyOn(log, 'warn');

    const StrictSchema = z.object({ required_field: z.string() });
    setAgentResponse('{"wrong_field": "value"}', 0.01);

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: StrictSchema,
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Zod validation failed'));
    warnSpy.mockRestore();
  });

  it('returns confidence "high" when outputFormat has no zodSchema (backward compat)', async () => {
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

    // No zodSchema → backward compat: any parsed JSON = high confidence
    expect(result.confidence).toBe('high');
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

  it('sets parsed=true when structured output parses successfully', async () => {
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

    expect(result.parsed).toBe(true);
    // When parsed is true, the artifact is the structured object, not the raw string
    expect(typeof result.artifact).toBe('object');
  });

  it('sets parsed=false when no outputFormat is requested (raw text artifact)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setAgentResponse('plain text wave output, no structured output', 0.01);

    const result = await spawnWaveAgent({
      wave: 'test',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.parsed).toBe(false);
    // String fallback — artifact is the raw resultText
    expect(typeof result.artifact).toBe('string');
  });

  it('sets parsed=false when outputFormat is set but JSON parsing fails (string-fallback path)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Model emits non-JSON despite outputFormat being requested
    setAgentResponse('this is not JSON at all', 0.01);

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

    expect(result.parsed).toBe(false);
    expect(typeof result.artifact).toBe('string');
    expect(result.artifact).toBe('this is not JSON at all');
  });

  it('parsed field discriminates string fallback from typed artifact (acceptance criterion)', async () => {
    // This is the contract the issue requires: callers can use !handoff.parsed
    // instead of typeof handoff.artifact === 'string'.
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setAgentResponse('{"x": 1}', 0.01);
    const ok = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    setAgentResponse('garbage', 0.01);
    const bad = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    // The discriminator is reliable: parsed ↔ artifact-is-not-a-string
    expect(ok.parsed).toBe(true);
    expect(typeof ok.artifact).toBe('object');
    expect(bad.parsed).toBe(false);
    expect(typeof bad.artifact).toBe('string');
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

    // Defaults are sized for large workspaces (e.g. Rust monorepos where
    // `cargo test` compilation alone can take 2-5 minutes, plus 15-30s
    // per turn for local model inference). See issue #244.
    expect(DEFAULT_WAVE_TIMEOUTS.assess).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.spec).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.review).toBe(5 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.test).toBe(30 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.impl).toBe(30 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.quality).toBe(20 * 60 * 1000);
    expect(DEFAULT_WAVE_TIMEOUTS.ship).toBeUndefined();
  });

  it('does not timeout a 20-minute wave with new defaults (issue #244)', async () => {
    const { DEFAULT_WAVE_TIMEOUTS } = await import('./wave-executor.js');

    // A wave running for 20 minutes must NOT timeout with the new defaults
    // for test/impl waves (which require room for cargo compilation + local
    // model inference on large workspaces).
    const twentyMinutesMs = 20 * 60 * 1000;
    const testDefault = DEFAULT_WAVE_TIMEOUTS.test;
    const implDefault = DEFAULT_WAVE_TIMEOUTS.impl;
    expect(testDefault).toBeDefined();
    expect(implDefault).toBeDefined();
    if (testDefault == null || implDefault == null) {
      throw new Error('test/impl defaults must be defined');
    }
    expect(testDefault).toBeGreaterThan(twentyMinutesMs);
    expect(implDefault).toBeGreaterThan(twentyMinutesMs);
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

  it('uses default thinking level per wave type', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    // Reasoning wave should get 'medium'
    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { thinkingLevel: string };
    };
    expect(agentConfig.initialState.thinkingLevel).toBe('medium');
  });

  it('coding waves default to thinking off', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { thinkingLevel: string };
    };
    expect(agentConfig.initialState.thinkingLevel).toBe('off');
  });

  it('allows thinkingLevel override via config', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      thinkingLevel: 'high',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      initialState: { thinkingLevel: string };
    };
    expect(agentConfig.initialState.thinkingLevel).toBe('high');
  });
});

describe('spawnWaveAgent pieceFiles (issue #250 — impl-wave scope guard)', () => {
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

  it('installs a beforeToolCall hook on impl wave when pieceFiles is provided', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Implement.',
      cwd: '/tmp/test',
      pieceFiles: ['src/foo.ts', 'src/bar.ts'],
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall?: unknown;
    };
    expect(agentConfig.beforeToolCall).toBeDefined();
    expect(typeof agentConfig.beforeToolCall).toBe('function');
  });

  it('impl-wave hook blocks out-of-scope edits and allows in-scope edits', async () => {
    // End-to-end acceptance criteria from issue #250:
    //   - impl edits in-scope file → allowed
    //   - impl edits out-of-scope file → rejected with message
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Implement.',
      cwd: '/tmp/test',
      pieceFiles: ['src/foo.ts'],
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall: (ctx: unknown) => Promise<{ block: boolean; reason?: string } | undefined>;
    };
    const hook = agentConfig.beforeToolCall;

    // In-scope edit allowed
    const allowed = await hook({
      toolCall: { name: 'write' },
      args: { path: 'src/foo.ts', content: 'x' },
    });
    expect(allowed?.block).not.toBe(true);

    // Out-of-scope edit blocked with descriptive message
    const blocked = await hook({
      toolCall: { name: 'write' },
      args: { path: 'src/unrelated.ts', content: 'x' },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain('Cannot modify');
    expect(blocked?.reason).toContain('src/unrelated.ts');
  });

  it('test wave does NOT enforce pieceFiles even when provided (must create new test files)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'test',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Write tests.',
      cwd: '/tmp/test',
      pieceFiles: ['src/foo.ts'],
      destructiveEditGuard: false,
      importPreservationGuard: false,
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall?: unknown;
    };
    // No scope hook on test wave; destructive guard is disabled → no hook at all
    expect(agentConfig.beforeToolCall).toBeUndefined();
  });

  it('quality wave does NOT enforce pieceFiles (must fix lint/type errors anywhere)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'quality',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Run quality.',
      cwd: '/tmp/test',
      pieceFiles: ['src/foo.ts'],
      destructiveEditGuard: false,
      importPreservationGuard: false,
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall?: unknown;
    };
    expect(agentConfig.beforeToolCall).toBeUndefined();
  });

  it('empty pieceFiles ⇒ no scope hook installed (backward compat)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Implement.',
      cwd: '/tmp/test',
      pieceFiles: [],
      destructiveEditGuard: false,
      importPreservationGuard: false,
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall?: unknown;
    };
    // With destructive guard disabled AND empty pieceFiles, no hook should be installed.
    expect(agentConfig.beforeToolCall).toBeUndefined();
  });

  it('undefined pieceFiles ⇒ no scope hook (backward compat)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Implement.',
      cwd: '/tmp/test',
      destructiveEditGuard: false,
      importPreservationGuard: false,
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall?: unknown;
    };
    expect(agentConfig.beforeToolCall).toBeUndefined();
  });

  it('composes scope guard with destructive-edit guard on impl wave', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Implement.',
      cwd: '/tmp/test',
      pieceFiles: ['src/foo.ts'],
      // destructive guard not disabled → both hooks composed
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      beforeToolCall: (ctx: unknown) => Promise<{ block: boolean; reason?: string } | undefined>;
    };
    const hook = agentConfig.beforeToolCall;
    expect(hook).toBeDefined();

    // Out-of-scope edit: blocked by scope guard (runs first)
    const blocked = await hook({
      toolCall: { name: 'write' },
      args: { path: 'src/unrelated.ts', content: 'x' },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain('Cannot modify');
  });
});

describe('per-wave cost cap (maxCostUsd)', () => {
  let subscribeCb: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    subscribeCb = undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });
    mockAgentState = { messages: [], errorMessage: undefined };
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  function simulateTurnsWithCost(costs: number[]): void {
    mockPrompt.mockImplementation(async () => {
      for (const turnCost of costs) {
        mockAgentState.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: 'working...' }],
          usage: { cost: { total: turnCost } },
        });
        subscribeCb?.({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 100, cost: { total: turnCost } },
          },
        });
      }
    });
  }

  it('aborts wave when accumulated cost exceeds maxCostUsd', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    simulateTurnsWithCost([0.5, 0.5, 0.5]);
    await expect(
      spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        maxCostUsd: 1.0,
      }),
    ).rejects.toThrow(/cost cap/i);
  });

  it('throws billing-type KovaError with retryable=false', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { KovaError } = await import('./errors.js');
    simulateTurnsWithCost([0.5, 0.6]);
    try {
      await spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        maxCostUsd: 1.0,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KovaError);
      const kovaErr = err as InstanceType<typeof KovaError>;
      expect(kovaErr.type).toBe('billing');
      expect(kovaErr.retryable).toBe(false);
    }
  });

  it('calls agent.abort() when cost cap is hit', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    simulateTurnsWithCost([0.8, 0.3]);
    try {
      await spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        maxCostUsd: 1.0,
      });
    } catch {
      /* expected */
    }
    expect(mockAbort).toHaveBeenCalled();
  });

  it('does not abort when cost stays under cap', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    simulateTurnsWithCost([0.2, 0.3]);
    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      maxCostUsd: 1.0,
    });
    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('no cap enforced when maxCostUsd not set (backward compatible)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    simulateTurnsWithCost([5.0, 5.0, 5.0]);
    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });
    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
  });
});

describe('context monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockPrompt.mockResolvedValue(undefined);
    setAgentResponse('done');
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('aborts and throws context KovaError when usage exceeds abort threshold (90%)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { KovaError } = await import('./errors.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      // 95% of 200000 = 190000 — above 90% abort threshold
      if (subscribeCb) {
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 190000, output: 1000, totalTokens: 191000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    await expect(
      spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        contextThreshold: 0.9,
      }),
    ).rejects.toThrow(KovaError);

    expect(mockAbort).toHaveBeenCalled();
  });

  it('does not abort when usage is below threshold', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 50000, output: 1000, totalTokens: 51000, cost: { total: 0.01 } },
            stopReason: 'stop',
          },
          toolResults: [],
        });
      }
    });

    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      contextThreshold: 0.8,
    });

    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('uses default threshold of 0.9 when not specified', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { KovaError } = await import('./errors.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 92% of 200000 = 184000 — above default 0.9 threshold (180000)
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 184000, output: 1000, totalTokens: 185000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    await expect(
      spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
        // no contextThreshold — should default to 0.9
      }),
    ).rejects.toThrow(KovaError);
  });

  it('accepts custom contextThreshold', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 55% of 200000 = 110000 — below 0.9 but above 0.5
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 110000, output: 1000, totalTokens: 111000, cost: { total: 0.01 } },
            stopReason: 'stop',
          },
          toolResults: [],
        });
      }
    });

    // At 0.9 threshold (180000), 110000 is fine
    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      contextThreshold: 0.9,
    });

    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('steers agent with warning at 70% context usage', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 75% of 200000 = 150000 — above 70% steer threshold, below 80% trim
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 150000, output: 1000, totalTokens: 151000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('impl');
    expect(mockSteer).toHaveBeenCalledOnce();
    expect(mockSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Focus on completing the current task'),
      }),
    );
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('sets transformContext at 80% context usage without aborting', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    let agentInstance: Record<string, unknown> | undefined;

    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    // Capture the agent instance to check transformContext assignment
    const { Agent: MockAgent } = await import('@earendil-works/pi-agent-core');
    (MockAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (this: Record<string, unknown>) {
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
      agentInstance = this;
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 82% of 200000 = 164000 — above 80% trim threshold, below 90% abort
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 164000, output: 1000, totalTokens: 165000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
    // transformContext should have been set on the agent
    expect(agentInstance?.transformContext).toBeTypeOf('function');
    // steer should also have been called (70% < 82%)
    expect(mockSteer).toHaveBeenCalled();
  });

  it('does not steer or trim below 70% usage', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    let agentInstance: Record<string, unknown> | undefined;

    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    const { Agent: MockAgent } = await import('@earendil-works/pi-agent-core');
    (MockAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (this: Record<string, unknown>) {
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
      agentInstance = this;
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 60% of 200000 = 120000 — below all thresholds
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 120000, output: 1000, totalTokens: 121000, cost: { total: 0.01 } },
            stopReason: 'stop',
          },
          toolResults: [],
        });
      }
    });

    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('impl');
    expect(mockSteer).not.toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
    expect(agentInstance?.transformContext).toBeUndefined();
  });

  it('does not abort at 80% — only trims', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let subscribeCb: ((event: unknown) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });

    mockPrompt.mockImplementation(async () => {
      if (subscribeCb) {
        // 85% of 200000 = 170000 — above 80% trim, below 90% abort
        subscribeCb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 170000, output: 1000, totalTokens: 171000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    // Should NOT throw — 85% is in the trim zone, not the abort zone
    const result = await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('impl');
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('classifies context exhaustion API errors correctly', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { KovaError } = await import('./errors.js');

    mockSubscribe.mockImplementation(() => vi.fn());
    mockPrompt.mockRejectedValue(new Error('context length exceeded: 210000 tokens'));

    try {
      await spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(KovaError);
      const kovaErr = error as InstanceType<typeof KovaError>;
      expect(kovaErr.type).toBe('context');
      expect(kovaErr.retryable).toBe(true);
    }
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

describe('router API key dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    mockPrompt.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(() => vi.fn());
    mockAgentState = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { cost: { total: 0.005 } },
        },
      ],
      errorMessage: undefined,
    };
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('getApiKey("router") returns the router API key when model uses a router provider', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'router:claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      getApiKey: (provider: string) => string | undefined;
    };
    expect(agentConfig.getApiKey('router')).toBe('mock-router-key');
  });

  it('getApiKey("ollama") still returns "ollama" (existing behavior preserved)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'router:claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      getApiKey: (provider: string) => string | undefined;
    };
    expect(agentConfig.getApiKey('ollama')).toBe('ollama');
  });

  it('getApiKey("anthropic") still returns ANTHROPIC_API_KEY (existing behavior preserved)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'router:claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      getApiKey: (provider: string) => string | undefined;
    };
    expect(agentConfig.getApiKey('anthropic')).toBe('test-anthropic-key');
  });
});

describe('parseStructuredOutput', () => {
  it('extracts JSON from <json> tags (primary method)', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = 'Here is my result:\n<json>{"grade": "A", "files": ["foo.ts"]}</json>\nDone!';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A', files: ['foo.ts'] });
  });

  it('extracts JSON from markdown fence when no <json> tags (secondary method)', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = 'Here is the output:\n```json\n{"grade": "B"}\n```';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'B' });
  });

  it('extracts JSON from bare markdown fence (no language tag)', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '```\n{"grade": "C"}\n```';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'C' });
  });

  it('parses direct JSON as tertiary fallback', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '{"grade": "A", "should_proceed": true}';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A', should_proceed: true });
  });

  it('returns undefined when no valid JSON found (greedy regex removed)', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = 'Some text with { braces } and more { stuff } here';
    expect(parseStructuredOutput(input)).toBeUndefined();
  });

  it('prefers <json> tags over markdown fence when both present', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '<json>{"source": "tag"}</json>\n```json\n{"source": "fence"}\n```';
    expect(parseStructuredOutput(input)).toEqual({ source: 'tag' });
  });

  it('handles <json> tags with whitespace/newlines inside', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '<json>\n  {\n    "grade": "A"\n  }\n</json>';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A' });
  });

  it('returns undefined for invalid JSON in <json> tags and does not fall through', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '<json>not valid json</json>\n```json\n{"fallback": true}\n```';
    // If tags are present but contain invalid JSON, try next method (fence)
    expect(parseStructuredOutput(input)).toEqual({ fallback: true });
  });

  it('does NOT match greedy brace pattern across unrelated content', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    // This would previously match the greedy regex {[\s\S]*}
    const input = 'I modified the function { return x } and also updated { config } at line 42';
    expect(parseStructuredOutput(input)).toBeUndefined();
  });

  it('handles empty string', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    expect(parseStructuredOutput('')).toBeUndefined();
  });

  it('logs extraction method on success', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const debugSpy = vi.spyOn(log, 'debug');

    parseStructuredOutput('<json>{"ok": true}</json>');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('json-tag'));

    debugSpy.mockClear();
    parseStructuredOutput('```json\n{"ok": true}\n```');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('markdown-fence'));

    debugSpy.mockClear();
    parseStructuredOutput('{"ok": true}');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('direct-parse'));

    debugSpy.mockRestore();
  });

  it('repairs trailing commas inside <json> tags', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '<json>{"grade": "A", "files": ["foo.ts",],}</json>';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A', files: ['foo.ts'] });
  });

  it('repairs single-quoted strings inside markdown fence', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = "```json\n{'grade': 'B', 'files': ['a.ts']}\n```";
    expect(parseStructuredOutput(input)).toEqual({ grade: 'B', files: ['a.ts'] });
  });

  it('repairs unquoted object keys via direct parse fallback', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '{grade: "C", should_proceed: true}';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'C', should_proceed: true });
  });

  it('repairs JS-style line comments inside <json> tags', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '<json>{\n  "grade": "A", // this is a grade\n  "files": ["foo.ts"]\n}</json>';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A', files: ['foo.ts'] });
  });

  it('repairs JS-style block comments inside markdown fence', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '```json\n{\n  /* leading note */\n  "grade": "B"\n}\n```';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'B' });
  });

  it('balances unclosed brackets in direct parse', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const input = '{"grade": "A", "files": ["foo.ts", "bar.ts"';
    expect(parseStructuredOutput(input)).toEqual({ grade: 'A', files: ['foo.ts', 'bar.ts'] });
  });

  it('repairs raw control characters inside string literals', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    // Raw newline inside a string is invalid JSON; repair must escape it.
    const input = '<json>{"summary": "line1\nline2"}</json>';
    expect(parseStructuredOutput(input)).toEqual({ summary: 'line1\nline2' });
  });

  it('logs repaired extraction with -repaired suffix', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const debugSpy = vi.spyOn(log, 'debug');

    parseStructuredOutput('<json>{"ok": true,}</json>');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('repaired'));

    debugSpy.mockRestore();
  });
});

describe('repairJson', () => {
  it('leaves already-valid JSON unchanged (idempotent)', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"grade":"A","files":["foo.ts"],"count":3,"flag":true,"none":null}';
    expect(repairJson(input)).toBe(input);
  });

  it('removes trailing commas before } and ]', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"a": 1, "b": [1, 2, 3,],}';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('strips JS-style line comments', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{\n  "a": 1, // inline comment\n  "b": 2\n}';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 });
  });

  it('strips JS-style block comments', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{\n  /* block */\n  "a": 1,\n  "b": /* inline */ 2\n}';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 });
  });

  it('does not strip // or /* sequences inside string values', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"url": "https://example.com/api", "pattern": "/* keep */"}';
    expect(JSON.parse(repairJson(input))).toEqual({
      url: 'https://example.com/api',
      pattern: '/* keep */',
    });
  });

  it('converts single-quoted strings to double-quoted', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = "{'grade': 'A', 'files': ['foo.ts', 'bar.ts']}";
    expect(JSON.parse(repairJson(input))).toEqual({ grade: 'A', files: ['foo.ts', 'bar.ts'] });
  });

  it('preserves apostrophes inside double-quoted strings', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = `{"msg": "it's working"}`;
    expect(JSON.parse(repairJson(input))).toEqual({ msg: "it's working" });
  });

  it('quotes unquoted object keys', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{grade: "A", should_proceed: true, count: 3}';
    expect(JSON.parse(repairJson(input))).toEqual({
      grade: 'A',
      should_proceed: true,
      count: 3,
    });
  });

  it('does not quote already-quoted keys', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"a": 1, "b": 2}';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 });
  });

  it('balances a single missing }', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"a": 1, "b": 2';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 });
  });

  it('balances missing ] inside an object', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"files": ["a.ts", "b.ts"';
    expect(JSON.parse(repairJson(input))).toEqual({ files: ['a.ts', 'b.ts'] });
  });

  it('balances mixed nested closers in correct order', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"a": [1, {"b": 2';
    // Expected: close obj, then arr, then outer obj
    expect(JSON.parse(repairJson(input))).toEqual({ a: [1, { b: 2 }] });
  });

  it('escapes raw newlines inside string literals', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"msg": "line1\nline2"}';
    expect(JSON.parse(repairJson(input))).toEqual({ msg: 'line1\nline2' });
  });

  it('escapes raw tabs and carriage returns inside string literals', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = '{"msg": "col1\tcol2\r\nrow2"}';
    expect(JSON.parse(repairJson(input))).toEqual({ msg: 'col1\tcol2\r\nrow2' });
  });

  it('combines multiple repair classes in one input', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = "{grade: 'A', /* note */ files: ['a.ts',], count: 1,";
    expect(JSON.parse(repairJson(input))).toEqual({
      grade: 'A',
      files: ['a.ts'],
      count: 1,
    });
  });

  it('strips a markdown fence wrapper with leading/trailing text', async () => {
    const { repairJson } = await import('./wave-executor.js');
    const input = 'Here you go:\n```json\n{"a": 1}\n```\nDone!';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1 });
  });

  it('returns input as-is when no repairable issues found and parse still fails', async () => {
    const { repairJson } = await import('./wave-executor.js');
    // Pure garbage with no { or [ — nothing to repair toward.
    const input = 'this is not json at all';
    // We just verify it does not throw; downstream JSON.parse will reject.
    expect(() => repairJson(input)).not.toThrow();
  });
});

describe('buildStructuredOutputInstructions', () => {
  it('includes <json> tag protocol in instructions', async () => {
    const { buildStructuredOutputInstructions } = await import('./wave-executor.js');
    const instructions = buildStructuredOutputInstructions({ type: 'object' });
    expect(instructions).toContain('<json>');
    expect(instructions).toContain('</json>');
  });

  it('includes the schema in the instructions', async () => {
    const { buildStructuredOutputInstructions } = await import('./wave-executor.js');
    const schema = { type: 'object', properties: { grade: { type: 'string' } } };
    const instructions = buildStructuredOutputInstructions(schema);
    expect(instructions).toContain('"grade"');
  });
});

describe('spawnWaveAgentWithFallback', () => {
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

  const baseConfig = {
    wave: 'assess' as const,
    model: 'ollama:llama3',
    tools: [] as AnyTool[],
    systemPrompt: 'You are an assessor.',
    handoffContext: '',
    userMessage: 'Assess this issue.',
    cwd: '/tmp/test',
  };

  it('returns primary result when local model succeeds', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    setAgentResponse('<json>{"grade": "A", "should_proceed": true}</json>', 0.0);

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(result.fallback_used).toBe(false);
    expect(Agent).toHaveBeenCalledOnce();
  });

  it('falls back to API model when local model Zod validation fails', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    const TestSchema = z.object({ grade: z.string(), should_proceed: z.boolean() });
    let callCount = 0;
    mockPrompt.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        mockAgentState = {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '{"bad": "data"}' }],
              usage: { cost: { total: 0.0 } },
            },
          ],
          errorMessage: undefined,
        };
      } else {
        mockAgentState = {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '<json>{"grade": "A", "should_proceed": true}</json>' }],
              usage: { cost: { total: 0.01 } },
            },
          ],
          errorMessage: undefined,
        };
      }
    });

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: TestSchema,
      },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(result.fallback_used).toBe(true);
    expect(Agent).toHaveBeenCalledTimes(2);
  });

  it('falls back to API model when local model returns empty result', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    let callCount = 0;
    mockPrompt.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        mockAgentState = {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '' }],
              usage: { cost: { total: 0.0 } },
            },
          ],
          errorMessage: undefined,
        };
      } else {
        mockAgentState = {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '<json>{"grade": "A", "should_proceed": true}</json>' }],
              usage: { cost: { total: 0.01 } },
            },
          ],
          errorMessage: undefined,
        };
      }
    });

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(result.fallback_used).toBe(true);
  });

  it('falls back to API model when local model throws error', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    let callCount = 0;
    mockPrompt.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('connection refused');
      }
      mockAgentState = {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { cost: { total: 0.01 } },
          },
        ],
        errorMessage: undefined,
      };
    });

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(result.fallback_used).toBe(true);
  });

  it('falls back when API model fails and fallbackModel differs', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    const TestSchema = z.object({ grade: z.string(), should_proceed: z.boolean() });
    setAgentResponse('{"bad": "data"}', 0.01);

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      model: 'claude-sonnet-4-6',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: TestSchema,
      },
      fallbackModel: 'claude-opus-4-6',
    });

    // With issue #40, fallback works for any model when fallbackModel differs
    expect(result.fallback_used).toBe(true);
    expect(Agent).toHaveBeenCalledTimes(2);
  });

  it('does NOT fall back when no fallbackModel is specified', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    const TestSchema = z.object({ grade: z.string(), should_proceed: z.boolean() });
    setAgentResponse('{"bad": "data"}', 0.0);

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: TestSchema,
      },
    });

    expect(result.fallback_used).toBe(false);
    expect(Agent).toHaveBeenCalledOnce();
  });

  it('logs fallback message when falling back', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const warnSpy = vi.spyOn(log, 'warn');

    let callCount = 0;
    mockPrompt.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('connection refused');
      }
      mockAgentState = {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { cost: { total: 0.01 } },
          },
        ],
        errorMessage: undefined,
      };
    });

    await spawnWaveAgentWithFallback({
      ...baseConfig,
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Local model failed, falling back to API'));
    warnSpy.mockRestore();
  });

  it('tracks local attempt cost in handoff', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    let callCount = 0;
    mockPrompt.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('connection refused');
      }
      mockAgentState = {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { cost: { total: 0.05 } },
          },
        ],
        errorMessage: undefined,
      };
    });

    const result = await spawnWaveAgentWithFallback({
      ...baseConfig,
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(result.fallback_used).toBe(true);
    expect(result.local_attempt_cost).toBe(0);
  });

  it('max 1 fallback — does not retry API model if it also fails', async () => {
    const { spawnWaveAgentWithFallback } = await import('./wave-executor.js');

    mockPrompt.mockRejectedValue(new Error('everything is broken'));

    await expect(
      spawnWaveAgentWithFallback({
        ...baseConfig,
        fallbackModel: 'claude-sonnet-4-6',
      }),
    ).rejects.toThrow();

    expect(Agent).toHaveBeenCalledTimes(2);
  });
});

describe('conversation repair turn on structured output failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockSubscribe.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  /** Helper: queue successive assistant responses across multiple prompt() invocations. */
  function setSequentialResponses(responses: Array<{ text: string; cost?: number }>): void {
    let callIndex = 0;
    mockPrompt.mockImplementation(async () => {
      const next = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (!next) return;
      mockAgentState.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: next.text }],
        usage: { cost: { total: next.cost ?? 0.005 } },
      });
    });
    // Reset transcript at start of each test
    mockAgentState = { messages: [], errorMessage: undefined };
  }

  it('repairs Zod validation failure on first repair turn (1 attempt)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string(), should_proceed: z.boolean() });

    setSequentialResponses([
      { text: '<json>{"bad": "data"}</json>' }, // initial: parses but fails Zod
      { text: '<json>{"grade": "A", "should_proceed": true}</json>' }, // repair: passes Zod
    ]);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    expect(result.confidence).toBe('high');
    expect(result.artifact).toEqual({ grade: 'A', should_proceed: true });
    expect(result.repair_attempts).toBe(1);
    // prompt should have been called twice: initial + 1 repair turn
    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('repairs Zod validation failure on second repair turn (2 attempts)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string(), should_proceed: z.boolean() });

    setSequentialResponses([
      { text: '<json>{"bad": "data"}</json>' }, // initial: fails
      { text: '<json>{"still": "wrong"}</json>' }, // repair 1: still fails
      { text: '<json>{"grade": "B", "should_proceed": false}</json>' }, // repair 2: succeeds
    ]);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    expect(result.confidence).toBe('high');
    expect(result.artifact).toEqual({ grade: 'B', should_proceed: false });
    expect(result.repair_attempts).toBe(2);
    expect(mockPrompt).toHaveBeenCalledTimes(3); // initial + 2 repair
  });

  it('gives up after max 2 repair turns and degrades to low confidence', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string(), should_proceed: z.boolean() });

    setSequentialResponses([
      { text: '<json>{"bad": "data"}</json>' }, // initial: fails
      { text: '<json>{"still": "wrong"}</json>' }, // repair 1: fails
      { text: '<json>{"nope": true}</json>' }, // repair 2: fails
    ]);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    expect(result.confidence).toBe('low');
    expect(result.repair_attempts).toBe(2);
    expect(mockPrompt).toHaveBeenCalledTimes(3); // initial + 2 repair (max)
    // Should not exceed 2 repair turns
  });

  it('repair turn message includes Zod error details and asks for corrected JSON only', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string() });

    setSequentialResponses([{ text: '<json>{"bad": "data"}</json>' }, { text: '<json>{"grade": "A"}</json>' }]);

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    // Inspect the second prompt() call — the repair turn
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    const repairMsg = mockPrompt.mock.calls[1]?.[0] as string;
    expect(repairMsg).toContain("didn't match");
    expect(repairMsg.toLowerCase()).toContain('json');
    // Should mention "only" / "no other text" instruction
    expect(repairMsg.toLowerCase()).toMatch(/only.*corrected json|corrected json.*no other text|only.*json/);
  });

  it('does not trigger repair when outputFormat is absent', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setSequentialResponses([{ text: 'just some text, no json' }]);

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
    expect(mockPrompt).toHaveBeenCalledTimes(1); // no repair turn
    expect(result.repair_attempts ?? 0).toBe(0);
  });

  it('does not trigger repair when outputFormat has no zodSchema and JSON parses successfully', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    setSequentialResponses([{ text: '<json>{"any": "json"}</json>' }]);

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
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(result.repair_attempts ?? 0).toBe(0);
  });

  it('triggers repair when JSON cannot be parsed at all and zodSchema is provided', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string() });

    setSequentialResponses([
      { text: 'I think the answer is just text, no JSON here at all.' },
      { text: '<json>{"grade": "A"}</json>' },
    ]);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    expect(result.confidence).toBe('high');
    expect(result.artifact).toEqual({ grade: 'A' });
    expect(result.repair_attempts).toBe(1);
    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('does not trigger repair when initial response already passes Zod', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const Schema = z.object({ grade: z.string() });

    setSequentialResponses([{ text: '<json>{"grade": "A"}</json>' }]);

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object' },
        zodSchema: Schema,
      },
    });

    expect(result.confidence).toBe('high');
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(result.repair_attempts ?? 0).toBe(0);
  });
});

describe('isAssistantMessage', () => {
  it('returns true for a valid assistant message', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0.01, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.015 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    expect(isAssistantMessage(msg)).toBe(true);
  });

  it('returns true for a kova-owned AssistantTurn shape (minimal usage = input/output/cost.total only)', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    const turn = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input: 100, output: 20, cost: { total: 0.001 } },
      stopReason: 'end_turn',
    };
    expect(isAssistantMessage(turn)).toBe(true);
  });

  it('accepts kova-owned stopReason values (end_turn, tool_use, max_turns)', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    for (const stopReason of ['end_turn', 'tool_use', 'max_turns', 'aborted', 'error']) {
      expect(
        isAssistantMessage({
          role: 'assistant',
          content: [],
          usage: { input: 0, output: 0, cost: { total: 0 } },
          stopReason,
        }),
      ).toBe(true);
    }
  });

  it('returns false for a user message', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage({ role: 'user', content: 'hi', timestamp: 0 })).toBe(false);
  });

  it('returns false for a tool result message', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage({ role: 'toolResult', toolCallId: '1', content: [] })).toBe(false);
  });

  it('returns false for null', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage(null)).toBe(false);
  });

  it('returns false for undefined', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  it('returns false for non-object values', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage('assistant')).toBe(false);
    expect(isAssistantMessage(42)).toBe(false);
    expect(isAssistantMessage(true)).toBe(false);
  });

  it('returns false for object without role field', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage({ content: [], usage: {} })).toBe(false);
  });

  it('validates content is an array', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage({ role: 'assistant', content: 'not-array' })).toBe(false);
  });

  it('validates usage is an object', async () => {
    const { isAssistantMessage } = await import('./wave-executor.js');
    expect(isAssistantMessage({ role: 'assistant', content: [], usage: 'bad' })).toBe(false);
  });
});

describe('resolveApiKey', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns GEMINI_API_KEY for google provider', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key-123';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('google')).toBe('gemini-key-123');
  });

  it('falls back to GOOGLE_API_KEY when GEMINI_API_KEY is not set', async () => {
    process.env.GOOGLE_API_KEY = 'google-key-456';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('google')).toBe('google-key-456');
  });

  it('prefers GEMINI_API_KEY over GOOGLE_API_KEY', async () => {
    process.env.GEMINI_API_KEY = 'gemini-preferred';
    process.env.GOOGLE_API_KEY = 'google-fallback';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('google')).toBe('gemini-preferred');
  });

  it('returns OPENAI_API_KEY for openai provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-key-789';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('openai')).toBe('openai-key-789');
  });

  it('returns ANTHROPIC_API_KEY for anthropic provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key-abc';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('anthropic')).toBe('anthropic-key-abc');
  });

  it('returns ANTHROPIC_API_KEY for unknown providers (fallback)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-fallback';
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('mistral')).toBe('anthropic-fallback');
  });

  it('returns ollama dummy key for ollama provider', async () => {
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('ollama')).toBe('ollama');
  });

  it('returns undefined when no key is set for the provider', async () => {
    const { resolveApiKey } = await import('./wave-executor.js');
    expect(resolveApiKey('google')).toBeUndefined();
  });
});

describe('spawnWaveAgent API key routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrompt.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(() => vi.fn());
    setAgentResponse('done');
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('passes google API key to Agent when using google provider model', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'google:gemini-2.5-pro',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      getApiKey: (provider: string) => string | undefined;
    };
    expect(agentConfig.getApiKey('google')).toBe('gemini-test-key');
  });

  it('passes openai API key to Agent when using openai provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'openai:gpt-4o',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      getApiKey: (provider: string) => string | undefined;
    };
    expect(agentConfig.getApiKey('openai')).toBe('openai-test-key');
  });
});

describe('spawnWaveAgent prompt-caching plumbing (issue #297)', () => {
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

  it('forwards explicit sessionId to the underlying pi-mono Agent', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      sessionId: 'kova-acme-foo-42-impl',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as { sessionId?: string };
    expect(agentConfig.sessionId).toBe('kova-acme-foo-42-impl');
  });

  it('forwards explicit cacheRetention by wrapping streamFn (pi-mono Agent has no direct field)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const piAi = await import('@earendil-works/pi-ai');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      cacheRetention: 'long',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      streamFn?: (model: unknown, ctx: unknown, opts?: Record<string, unknown>) => unknown;
    };
    expect(typeof agentConfig.streamFn).toBe('function');

    // Invoke the wrapper and confirm cacheRetention is merged into options.
    const model = { id: 'claude-sonnet-4-6', provider: 'anthropic' } as unknown;
    const ctx = { systemPrompt: 's', messages: [], tools: [] } as unknown;
    vi.mocked(piAi.streamSimple).mockReturnValue('STREAM' as unknown as never);
    const out = agentConfig.streamFn?.(model, ctx, { temperature: 0.1 });
    expect(out).toBe('STREAM');
    expect(piAi.streamSimple).toHaveBeenCalledTimes(1);
    const passedOpts = vi.mocked(piAi.streamSimple).mock.calls[0]?.[2] as
      | { cacheRetention?: string; temperature?: number }
      | undefined;
    expect(passedOpts?.cacheRetention).toBe('long');
    expect(passedOpts?.temperature).toBe(0.1);
  });

  it('auto-selects cacheRetention="long" by default for the impl wave', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const piAi = await import('@earendil-works/pi-ai');

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      streamFn?: (model: unknown, ctx: unknown, opts?: Record<string, unknown>) => unknown;
    };
    vi.mocked(piAi.streamSimple).mockReturnValue('STREAM' as unknown as never);
    agentConfig.streamFn?.({ id: 'x', provider: 'anthropic' }, {}, undefined);
    const passedOpts = vi.mocked(piAi.streamSimple).mock.calls[0]?.[2] as { cacheRetention?: string } | undefined;
    expect(passedOpts?.cacheRetention).toBe('long');
  });

  it('auto-selects cacheRetention="long" by default for the test wave', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const piAi = await import('@earendil-works/pi-ai');

    await spawnWaveAgent({
      wave: 'test',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      streamFn?: (model: unknown, ctx: unknown, opts?: Record<string, unknown>) => unknown;
    };
    vi.mocked(piAi.streamSimple).mockReturnValue('STREAM' as unknown as never);
    agentConfig.streamFn?.({ id: 'x', provider: 'anthropic' }, {}, undefined);
    const passedOpts = vi.mocked(piAi.streamSimple).mock.calls[0]?.[2] as { cacheRetention?: string } | undefined;
    expect(passedOpts?.cacheRetention).toBe('long');
  });

  it('does NOT install streamFn wrapper for short-wave defaults (no override)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as { streamFn?: unknown };
    // Default streamFn is pi-mono's streamSimple — adapter does NOT wrap when no retention override.
    // We verify by checking the constructor option is the canonical streamSimple symbol.
    const piAi = await import('@earendil-works/pi-ai');
    expect(agentConfig.streamFn).toBe(piAi.streamSimple);
  });

  it('explicit cacheRetention overrides per-wave default', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const piAi = await import('@earendil-works/pi-ai');

    await spawnWaveAgent({
      wave: 'impl', // default is 'long'
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
      cacheRetention: 'short',
    });

    const agentConfig = vi.mocked(Agent).mock.calls[0]?.[0] as {
      streamFn?: (model: unknown, ctx: unknown, opts?: Record<string, unknown>) => unknown;
    };
    vi.mocked(piAi.streamSimple).mockReturnValue('STREAM' as unknown as never);
    agentConfig.streamFn?.({ id: 'x', provider: 'anthropic' }, {}, undefined);
    const passedOpts = vi.mocked(piAi.streamSimple).mock.calls[0]?.[2] as { cacheRetention?: string } | undefined;
    expect(passedOpts?.cacheRetention).toBe('short');
  });
});

describe('DEFAULT_WAVE_CACHE_RETENTION', () => {
  it('sets long retention for multi-turn impl/test waves', async () => {
    const { DEFAULT_WAVE_CACHE_RETENTION } = await import('./wave-executor.js');
    expect(DEFAULT_WAVE_CACHE_RETENTION.impl).toBe('long');
    expect(DEFAULT_WAVE_CACHE_RETENTION.test).toBe('long');
  });

  it('omits retention override for short-running reasoning waves', async () => {
    const { DEFAULT_WAVE_CACHE_RETENTION } = await import('./wave-executor.js');
    expect(DEFAULT_WAVE_CACHE_RETENTION.assess).toBeUndefined();
    expect(DEFAULT_WAVE_CACHE_RETENTION.spec).toBeUndefined();
    expect(DEFAULT_WAVE_CACHE_RETENTION.review).toBeUndefined();
    expect(DEFAULT_WAVE_CACHE_RETENTION.brainstorm).toBeUndefined();
    expect(DEFAULT_WAVE_CACHE_RETENTION.ship).toBeUndefined();
  });
});

describe('buildWaveSessionId', () => {
  it('produces a deterministic kova-prefixed session id from repo+issue+wave', async () => {
    const { buildWaveSessionId } = await import('./wave-executor.js');
    expect(buildWaveSessionId({ repo: 'orrinfrazier/kova', issue: 297, wave: 'impl' })).toBe(
      'kova-orrinfrazier-kova-297-impl',
    );
  });

  it('sanitizes special chars but preserves issue identity', async () => {
    const { buildWaveSessionId } = await import('./wave-executor.js');
    expect(buildWaveSessionId({ repo: 'My Org/Some.Repo!', issue: '42', wave: 'test' })).toBe(
      'kova-my-org-some-repo-42-test',
    );
  });

  it('is stable for identical inputs', async () => {
    const { buildWaveSessionId } = await import('./wave-executor.js');
    const a = buildWaveSessionId({ repo: 'foo/bar', issue: 1, wave: 'impl' });
    const b = buildWaveSessionId({ repo: 'foo/bar', issue: 1, wave: 'impl' });
    expect(a).toBe(b);
  });
});

describe('spawnWaveAgent cache-read telemetry (issue #297)', () => {
  let subscribeCb: ((event: unknown) => void) | undefined;
  let cacheLogState = { messages: [] as unknown[], errorMessage: undefined as string | undefined };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    subscribeCb = undefined;
    cacheLogState = { messages: [], errorMessage: undefined };
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      subscribeCb = cb;
      return vi.fn();
    });
    // Wire the mock Agent state to our local store so collectState reads turns.
    mockAgentState = cacheLogState as typeof mockAgentState;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  function simulateTurnsWithCache(turns: Array<{ input: number; cacheRead?: number; cost?: number }>): void {
    mockPrompt.mockImplementation(async () => {
      for (const t of turns) {
        const msg = {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { input: t.input, cacheRead: t.cacheRead ?? 0, cost: { total: t.cost ?? 0.001 } },
        };
        cacheLogState.messages.push(msg);
        subscribeCb?.({ type: 'turn_end', message: msg });
      }
    });
  }

  it('logs cache-read share line at wave completion when cacheRead tokens were observed', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const infoSpy = vi.spyOn(log, 'info');

    simulateTurnsWithCache([
      { input: 100, cacheRead: 0 },
      { input: 800, cacheRead: 600 },
      { input: 1000, cacheRead: 900 },
    ]);

    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const calls = infoSpy.mock.calls.map((c) => String(c[0]));
    const cacheLine = calls.find((c) => /\[impl\] Cache:/.test(c));
    expect(cacheLine).toBeDefined();
    // total cacheRead = 1500, total input = 1900 -> share = 79% (rounded)
    expect(cacheLine).toMatch(/cacheRead=1500/);
    expect(cacheLine).toMatch(/input=1900/);
    expect(cacheLine).toMatch(/share=79%/);
    infoSpy.mockRestore();
  });

  it('logs share=0% when no cache reads occurred', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');
    const { log } = await import('../utils/logger.js');
    const infoSpy = vi.spyOn(log, 'info');

    simulateTurnsWithCache([{ input: 500, cacheRead: 0 }]);

    await spawnWaveAgent({
      wave: 'spec',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    const calls = infoSpy.mock.calls.map((c) => String(c[0]));
    const cacheLine = calls.find((c) => /\[spec\] Cache:/.test(c));
    expect(cacheLine).toBeDefined();
    expect(cacheLine).toMatch(/share=0%/);
    infoSpy.mockRestore();
  });
});
