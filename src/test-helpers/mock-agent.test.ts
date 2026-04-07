import { describe, expect, it, vi } from 'vitest';
import { CANNED, createMockAgent, happyPathResponses, setupResponseSequence } from './mock-agent.js';

describe('createMockAgent', () => {
  it('returns agent with subscribe, prompt, state, abort', () => {
    const agent = createMockAgent({ result: 'done' });
    expect(agent.subscribe).toBeTypeOf('function');
    expect(agent.prompt).toBeTypeOf('function');
    expect(agent.state).toBeDefined();
    expect(agent.abort).toBeTypeOf('function');
  });

  it('resolves prompt and fires subscriber with text result', async () => {
    const agent = createMockAgent({ result: 'hello world', cost: 0.05 });
    const events: unknown[] = [];
    agent.subscribe((event: unknown) => events.push(event));

    await agent.prompt('do something');

    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; message: { content: Array<{ text: string }> } };
    expect(event.type).toBe('turn_end');
    expect(event.message.content[0]?.text).toBe('hello world');
  });

  it('serializes structuredOutput as JSON in message text', async () => {
    const agent = createMockAgent({ structuredOutput: CANNED.ASSESS_PASS });
    const events: unknown[] = [];
    agent.subscribe((event: unknown) => events.push(event));

    await agent.prompt('assess');

    const event = events[0] as { message: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(event.message.content[0]?.text ?? '') as typeof CANNED.ASSESS_PASS;
    expect(parsed.grade).toBe('A');
    expect(parsed.should_proceed).toBe(true);
  });

  it('throws on prompt when error is set', async () => {
    const agent = createMockAgent({ error: 'auth failed' });
    await expect(agent.prompt('go')).rejects.toThrow('auth failed');
  });

  it('includes errorMessage in state for piMonoError', () => {
    const agent = createMockAgent({ piMonoError: 'rate limited' });
    expect(agent.state.errorMessage).toBe('rate limited');
  });

  it('includes cost in assistant message usage', async () => {
    const agent = createMockAgent({ result: 'ok', cost: 0.42 });
    const events: unknown[] = [];
    agent.subscribe((event: unknown) => events.push(event));

    await agent.prompt('go');

    const event = events[0] as { message: { usage: { cost: { total: number } } } };
    expect(event.message.usage.cost.total).toBe(0.42);
  });
});

describe('setupResponseSequence', () => {
  it('creates successive agents from response list', () => {
    const mockConstructor = vi.fn();
    const state = setupResponseSequence(mockConstructor, [
      { result: 'first', cost: 0.1 },
      { result: 'second', cost: 0.2 },
    ]);

    const agent1 = mockConstructor({}) as ReturnType<typeof createMockAgent>;
    const agent2 = mockConstructor({}) as ReturnType<typeof createMockAgent>;

    expect(agent1).toBeDefined();
    expect(agent2).toBeDefined();
    expect(state.callIndex).toBe(2);
  });

  it('throws when more agents requested than responses configured', () => {
    const mockConstructor = vi.fn();
    setupResponseSequence(mockConstructor, [{ result: 'only-one' }]);

    mockConstructor({}); // First call OK
    expect(() => mockConstructor({})).toThrow('only 1 responses configured');
  });

  it('records prompts in allPrompts array', async () => {
    const mockConstructor = vi.fn();
    const state = setupResponseSequence(mockConstructor, [{ result: 'done' }]);

    const agent = mockConstructor({}) as ReturnType<typeof createMockAgent>;
    agent.subscribe(() => {});
    await agent.prompt('hello from wave');

    expect(state.allPrompts).toContain('hello from wave');
  });
});

describe('happyPathResponses', () => {
  it('returns 6 responses (assess, spec, test, impl, quality, review)', () => {
    const responses = happyPathResponses();
    expect(responses).toHaveLength(6);
  });

  it('has structuredOutput for assess, spec, impl, review', () => {
    const responses = happyPathResponses();
    expect(responses[0]?.structuredOutput).toBeDefined(); // assess
    expect(responses[1]?.structuredOutput).toBeDefined(); // spec
    expect(responses[2]?.result).toBeDefined(); // test (text)
    expect(responses[3]?.structuredOutput).toBeDefined(); // impl
    expect(responses[4]?.result).toBeDefined(); // quality (text)
    expect(responses[5]?.structuredOutput).toBeDefined(); // review
  });
});

describe('CANNED', () => {
  it('ASSESS_PASS has required fields', () => {
    expect(CANNED.ASSESS_PASS.grade).toBe('A');
    expect(CANNED.ASSESS_PASS.should_proceed).toBe(true);
    expect(CANNED.ASSESS_PASS.surface_area.files).toBeInstanceOf(Array);
  });

  it('ASSESS_FAIL blocks pipeline', () => {
    expect(CANNED.ASSESS_FAIL.grade).toBe('F');
    expect(CANNED.ASSESS_FAIL.should_proceed).toBe(false);
  });

  it('SPEC_RESULT has pieces and dependency_order', () => {
    expect(CANNED.SPEC_RESULT.pieces).toHaveLength(1);
    expect(CANNED.SPEC_RESULT.dependency_order).toEqual([[0]]);
  });

  it('REVIEW_PASS has verdict pass', () => {
    expect(CANNED.REVIEW_PASS.verdict).toBe('pass');
    expect(CANNED.REVIEW_PASS.findings).toHaveLength(0);
  });

  it('REVIEW_NEEDS_FIXES has findings', () => {
    expect(CANNED.REVIEW_NEEDS_FIXES.verdict).toBe('needs_fixes');
    expect(CANNED.REVIEW_NEEDS_FIXES.findings).toHaveLength(1);
  });

  it('QUALITY_PASS has all_passing true', () => {
    expect(CANNED.QUALITY_PASS.all_passing).toBe(true);
  });
});
