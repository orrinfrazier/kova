import { describe, expect, it, vi } from 'vitest';

describe('runtime resolver (issue #407)', () => {
  it('exports RUNTIME_KINDS as a 2-element readonly tuple of pi + claude-cli', async () => {
    const mod = await import('./resolver.js');
    expect(mod.RUNTIME_KINDS).toBeDefined();
    expect([...mod.RUNTIME_KINDS].sort()).toEqual(['claude-cli', 'pi']);
  });

  it('resolveRuntimeFactory("pi") returns defaultAgentRuntimeFactory', async () => {
    const mod = await import('./resolver.js');
    const { defaultAgentRuntimeFactory } = await import('./pi-agent-runtime.js');
    const factory = mod.resolveRuntimeFactory('pi');
    expect(factory).toBe(defaultAgentRuntimeFactory);
  });

  it('resolveRuntimeFactory("claude-cli") returns claudeCliRuntimeFactory', async () => {
    const mod = await import('./resolver.js');
    const { claudeCliRuntimeFactory } = await import('./claude-cli-runtime.js');
    const factory = mod.resolveRuntimeFactory('claude-cli');
    expect(factory).toBe(claudeCliRuntimeFactory);
  });

  it('resolveRuntimeFactory rejects unknown kinds at runtime', async () => {
    const mod = await import('./resolver.js');
    // @ts-expect-error — feeding an invalid string to verify the runtime guard.
    expect(() => mod.resolveRuntimeFactory('bogus')).toThrow(/unknown runtime kind/i);
  });

  it('wrapClaudeCliFactoryWithMcp delegates create() to the inner factory and merges mcpServers', async () => {
    const mod = await import('./resolver.js');
    const innerCreate = vi.fn().mockReturnValue({ run: async () => ({}) });
    const innerFactory = { create: innerCreate };
    const mcpServers = { foo: { command: 'foo-bin', args: ['--port', '1'] } };

    const wrapped = mod.wrapClaudeCliFactoryWithMcp(
      innerFactory as unknown as Parameters<typeof mod.wrapClaudeCliFactoryWithMcp>[0],
      mcpServers,
    );
    expect(typeof wrapped.create).toBe('function');

    const baseConfig = {
      systemPrompt: 'hi',
      model: {
        provider: 'anthropic',
        id: 'claude-opus-4-5',
        cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      },
      tools: [],
      getApiKey: async () => 'k',
    } as unknown as Parameters<typeof wrapped.create>[0];

    wrapped.create(baseConfig);
    expect(innerCreate).toHaveBeenCalledTimes(1);
    const passed = innerCreate.mock.calls[0]?.[0] as { mcpServers?: typeof mcpServers; systemPrompt: string };
    expect(passed.systemPrompt).toBe('hi');
    expect(passed.mcpServers).toEqual(mcpServers);
  });

  it('wrapClaudeCliFactoryWithMcp preserves caller-supplied mcpServers (caller wins)', async () => {
    const mod = await import('./resolver.js');
    const innerCreate = vi.fn().mockReturnValue({ run: async () => ({}) });
    const innerFactory = { create: innerCreate };
    const resolved = { foo: { command: 'foo-bin' } };
    const explicit = { bar: { command: 'bar-bin' } };

    const wrapped = mod.wrapClaudeCliFactoryWithMcp(
      innerFactory as unknown as Parameters<typeof mod.wrapClaudeCliFactoryWithMcp>[0],
      resolved,
    );
    wrapped.create({
      systemPrompt: '',
      model: { provider: 'anthropic', id: 'x', cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } },
      tools: [],
      getApiKey: async () => 'k',
      mcpServers: explicit,
    } as unknown as Parameters<typeof wrapped.create>[0]);

    const passed = innerCreate.mock.calls[0]?.[0] as { mcpServers?: typeof explicit };
    expect(passed.mcpServers).toEqual(explicit);
  });
});
