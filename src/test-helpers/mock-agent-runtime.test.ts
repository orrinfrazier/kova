/**
 * Tests for `MockAgentRuntime` — verifies the kova-shape adapter satisfies
 * the `AgentRuntimeFactory` interface and replays canned responses correctly.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AssistantTurn, RuntimeEvent } from '../ai/runtime/types.js';
import { CANNED } from './mock-agent.js';
import { createMockAgentRuntimeFactory, MOCK_AGENT_DEFAULTS } from './mock-agent-runtime.js';

describe('createMockAgentRuntimeFactory', () => {
  it('returns an AgentRuntimeFactory whose create() yields an AgentRuntime', () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'shape-check' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    expect(typeof rt.prompt).toBe('function');
    expect(typeof rt.abort).toBe('function');
    expect(typeof rt.subscribe).toBe('function');
    expect(rt.state).toBeDefined();
    expect(Array.isArray(rt.state.messages)).toBe(true);
  });

  it('delivers the canned response as a turn_end event with a kova-shape AssistantTurn', async () => {
    const factory = createMockAgentRuntimeFactory([{ structuredOutput: CANNED.REVIEW_PASS, cost: 0.05 }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: RuntimeEvent[] = [];
    rt.subscribe((ev) => received.push(ev));
    await rt.prompt('hello');
    const turnEnd = received.find((e) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    const msg = (turnEnd as { type: 'turn_end'; message: AssistantTurn }).message;
    expect(msg.role).toBe('assistant');
    expect(msg.stopReason).toBe('end_turn');
    // Cost lives in `usage.cost.total` — pi-mono and kova share this shape.
    expect(msg.usage.cost.total).toBeCloseTo(0.05, 6);
    // Content array has at least one text block with the canned JSON.
    expect(msg.content.length).toBeGreaterThan(0);
  });

  it('exposes the response transcript on state.messages after prompt()', async () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'hello world' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt.prompt('hi');
    const msgs = rt.state.messages;
    // user prompt + assistant reply
    expect(msgs.length).toBe(2);
    expect((msgs[0] as { role: string }).role).toBe('user');
    expect((msgs[1] as { role: string }).role).toBe('assistant');
  });

  it('threads multiple sequential responses across multiple create() calls', async () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'first' }, { result: 'second' }]);
    const rt1 = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt1.prompt('a');
    const rt2 = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt2.prompt('b');
    expect((rt1.state.messages[1] as unknown as { content: Array<{ text?: string }> }).content[0]?.text).toBe('first');
    expect((rt2.state.messages[1] as unknown as { content: Array<{ text?: string }> }).content[0]?.text).toBe('second');
  });

  it('throws if create() is called more times than configured responses', () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'only-one' }]);
    factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    expect(() =>
      factory.create({
        systemPrompt: 's',
        model: { id: 'm' } as never,
        tools: [],
        getApiKey: () => undefined,
      }),
    ).toThrow(/Unexpected.*call/i);
  });

  it('records prompt strings across the factory for assertion', async () => {
    const { factory, prompts } = createMockAgentRuntimeFactory.withPrompts([{ result: 'A' }, { result: 'B' }]);
    const rt1 = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt1.prompt('prompt-one');
    const rt2 = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await rt2.prompt('prompt-two');
    expect(prompts).toEqual(['prompt-one', 'prompt-two']);
  });

  it('captures the construction config so tests can assert on systemPrompt / model / tools', () => {
    const { factory, configs } = createMockAgentRuntimeFactory.withConfigs([{ result: 'only' }]);
    const model = { id: 'gpt-4o', provider: 'openai', contextWindow: 128_000 } as never;
    const tools = [{ name: 't1' }] as never[];
    factory.create({
      systemPrompt: 'sys',
      model,
      tools,
      getApiKey: () => undefined,
      cacheRetention: 'long',
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]?.systemPrompt).toBe('sys');
    expect(configs[0]?.model).toBe(model);
    expect(configs[0]?.tools).toBe(tools);
    expect(configs[0]?.cacheRetention).toBe('long');
  });

  it('surfaces a piMonoError as state.errorMessage and emits a turn_end with stopReason=error', async () => {
    const factory = createMockAgentRuntimeFactory([{ piMonoError: 'rate limit exceeded' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: RuntimeEvent[] = [];
    rt.subscribe((ev) => received.push(ev));
    await rt.prompt('hi');
    expect(rt.state.errorMessage).toBe('rate limit exceeded');
    const turnEnd = received.find(
      (e): e is { type: 'turn_end'; message: AssistantTurn } => e.type === 'turn_end' && e.message != null,
    );
    expect(turnEnd?.message.stopReason).toBe('error');
    expect(turnEnd?.message.errorMessage).toBe('rate limit exceeded');
  });

  it('rethrows when response.error is set, so tests can assert on rejection paths', async () => {
    const factory = createMockAgentRuntimeFactory([{ error: 'network down' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    await expect(rt.prompt('hi')).rejects.toThrow(/network down/);
  });

  it('abort() flips an internal flag observable by tests', () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'ok' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const aborted = vi.fn();
    rt.subscribe(() => {
      /* no-op */
    });
    rt.abort();
    aborted();
    expect(aborted).toHaveBeenCalledOnce();
  });

  it('subscribe() returns an unsubscribe that detaches the listener', async () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'one' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: RuntimeEvent[] = [];
    const off = rt.subscribe((ev) => received.push(ev));
    off();
    await rt.prompt('hi');
    expect(received).toHaveLength(0);
  });

  it('uses MOCK_AGENT_DEFAULTS when fields are omitted from the response', async () => {
    const factory = createMockAgentRuntimeFactory([{ result: 'default cost' }]);
    const rt = factory.create({
      systemPrompt: 's',
      model: { id: 'm' } as never,
      tools: [],
      getApiKey: () => undefined,
    });
    const received: RuntimeEvent[] = [];
    rt.subscribe((ev) => received.push(ev));
    await rt.prompt('hi');
    const turnEnd = received.find(
      (e): e is { type: 'turn_end'; message: AssistantTurn } => e.type === 'turn_end' && e.message != null,
    );
    expect(turnEnd?.message.usage.cost.total).toBeCloseTo(MOCK_AGENT_DEFAULTS.cost, 6);
  });
});
