import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrompt = vi.fn();
const mockAbort = vi.fn();
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
      subscribe: mockSubscribe,
      get state() {
        return mockAgentState;
      },
    });
  });
  return { Agent: MockAgent };
});

vi.mock('@earendil-works/pi-ai', () => ({
  streamSimple: vi.fn(),
  getModel: vi.fn().mockReturnValue({ id: 'claude-sonnet-4-6', provider: 'anthropic' }),
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
      // expected
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
