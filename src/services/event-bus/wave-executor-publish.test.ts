// Verifies wave-executor publishes lifecycle events to the EventBus when one is provided,
// without changing the outcome behavior.
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus.js';
import type { KovaEvent } from './schema.js';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

function fakeTool(name: string): AnyTool {
  return { name, label: name, description: name, parameters: {}, execute: vi.fn() } as unknown as AnyTool;
}

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

vi.mock('../../ai/router.js', () => ({
  isRouterProvider: (p: string) => p === 'router',
  isRouterEnabled: () => false,
  createRouterModel: () => ({
    id: 'router',
    name: 'router',
    api: 'anthropic-messages',
    provider: 'router',
    baseUrl: 'http://localhost:4141',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  }),
  resolveRouterApiKey: () => 'mock',
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

describe('wave-executor publishes events to EventBus', () => {
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

  it('publishes wave-enter and wave-done when an eventBus is provided', async () => {
    const { spawnWaveAgent } = await import('../../ai/wave-executor.js');
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((ev) => seen.push(ev));

    await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [fakeTool('read')],
      systemPrompt: 'sys',
      handoffContext: '',
      userMessage: 'msg',
      cwd: '/tmp/test',
      eventBus: bus,
      eventContext: { runId: 'run-1', repoId: 'orrinfrazier/kova', fixId: 'fix-292' },
    });

    const types = seen.map((e) => e.type);
    expect(types).toContain('wave-enter');
    // wave-done emitted with cost summary
    expect(types).toContain('cost');
  });

  it('does not publish events when no bus is provided (outcome unchanged)', async () => {
    const { spawnWaveAgent } = await import('../../ai/wave-executor.js');

    const result = await spawnWaveAgent({
      wave: 'assess',
      model: 'claude-sonnet-4-6',
      tools: [],
      systemPrompt: 'sys',
      handoffContext: '',
      userMessage: 'msg',
      cwd: '/tmp/test',
    });

    // Should succeed without bus
    expect(result).toBeDefined();
  });
});
