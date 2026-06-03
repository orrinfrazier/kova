// Issue #296: lossy context trimming removed.
//
// The prior 80% Tier-2 branch reassigned `agent.transformContext` to
// `aggressiveTrimContext` (which dropped middle messages). That path is gone.
// The 70% Tier-1 steer still fires and the contextThreshold Tier-3 abort (default
// 90%) still fires; the 80% trim slot is now a no-op and collapses onto Tier-3.
//
// These tests pin the new behavior so a future regression cannot silently
// reintroduce a lossy transformContext.

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockSteer = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(vi.fn());

let mockAgentState = {
  messages: [] as unknown[],
  errorMessage: undefined as string | undefined,
};

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
  getRouterDefaultModel: () => process.env.ROUTER_DEFAULT ?? 'anthropic:claude-sonnet-4-6',
}));

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

describe('wave-executor — context trimming removed (#296)', () => {
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

  it('does NOT install a transformContext on the runtime (no lossy hook)', async () => {
    const { spawnWaveAgent } = await import('./wave-executor.js');

    let agentInstance: Record<string, unknown> | undefined;
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

    // Capture what the runtime factory received via pi-mono's Agent constructor.
    await spawnWaveAgent({
      wave: 'impl',
      model: 'claude-sonnet-4-6',
      tools: [] as AnyTool[],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    // The agent constructor receives an options object. After spawnWaveAgent
    // returns, transformContext should never have been assigned. The mock starts
    // with `undefined` and we assert it stays `undefined`.
    expect(agentInstance?.transformContext).toBeUndefined();

    // The Agent constructor itself must not be passed a transformContext field.
    const ctorArgs = (MockAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(ctorArgs).toBeDefined();
    expect(ctorArgs).not.toHaveProperty('transformContext');
  });

  it('at 82% context usage, does not abort, does not assign transformContext, and steers (Tier-1 only)', async () => {
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
        // 82% of 200000 = 164000 — old Tier-2 trim threshold, below 90% abort
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
      tools: [] as AnyTool[],
      systemPrompt: 'Prompt.',
      handoffContext: '',
      userMessage: 'Message.',
      cwd: '/tmp/test',
    });

    expect(result.wave).toBe('impl');
    // Tier-3 abort must NOT fire at 82% (default contextThreshold is 90%)
    expect(mockAbort).not.toHaveBeenCalled();
    // No lossy transformContext gets installed
    expect(agentInstance?.transformContext).toBeUndefined();
    // Tier-1 steer DOES fire at 82% (still above 70% steer threshold)
    expect(mockSteer).toHaveBeenCalled();
  });

  it('at 91% context usage, aborts via Tier-3 (Tier-2 collapse onto Tier-3 is the intended behavior)', async () => {
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
            content: [{ type: 'text', text: 'working...' }],
            usage: { input: 182000, output: 1000, totalTokens: 183000, cost: { total: 0.01 } },
            stopReason: 'toolUse',
          },
          toolResults: [],
        });
      }
    });

    // Tier-3 throws KovaError on abort — we only care that abort fired.
    await expect(
      spawnWaveAgent({
        wave: 'impl',
        model: 'claude-sonnet-4-6',
        tools: [] as AnyTool[],
        systemPrompt: 'Prompt.',
        handoffContext: '',
        userMessage: 'Message.',
        cwd: '/tmp/test',
      }),
    ).rejects.toThrow(/Context window exhausted/);

    expect(mockAbort).toHaveBeenCalled();
  });
});

describe('ai barrel — context-transform exports removed (#296)', () => {
  it('does not re-export createTransformContext or COMPACTABLE_TOOLS', async () => {
    const aiBarrel = await import('./index.js');
    // biome-ignore lint/suspicious/noExplicitAny: structural exports introspection
    const keys = Object.keys(aiBarrel as any);
    expect(keys).not.toContain('createTransformContext');
    expect(keys).not.toContain('COMPACTABLE_TOOLS');
  });
});
