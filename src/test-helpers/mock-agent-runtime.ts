/**
 * `MockAgentRuntime` — kova-shape mock that implements `AgentRuntimeFactory`
 * directly, without spinning up a pi-mono `Agent`.
 *
 * This is the issue #310 successor to `./mock-agent.ts`. The older helper
 * mocked pi-mono's `Agent` constructor via `vi.mock('@earendil-works/pi-agent-core', ...)`,
 * which leaks the pi-mono shape into every test — pi-mono's `AgentEvent.turn_end`
 * carries `usage.cost.total`, `stopReason: 'stop' | 'length' | 'toolUse'`, and
 * content blocks of `type: 'toolCall'`. The new helper produces kova-shape
 * `RuntimeEvent`s straight away, so tests assert against the runtime contract
 * the wave-executor actually consumes.
 *
 * Usage:
 *
 *   import { createMockAgentRuntimeFactory } from '../test-helpers/mock-agent-runtime.js';
 *   const factory = createMockAgentRuntimeFactory([
 *     { structuredOutput: CANNED.ASSESS_PASS, cost: 0.1 },
 *     { structuredOutput: CANNED.SPEC_RESULT,  cost: 0.08 },
 *   ]);
 *   await spawnWaveAgent({ ..., runtimeFactory: factory });
 *
 * For tests that need to assert on prompt strings or construction configs,
 * use the `.withPrompts(...)` / `.withConfigs(...)` variants which return
 * `{ factory, prompts }` / `{ factory, configs }` and capture the metadata.
 *
 * The existing `./mock-agent.ts` helper (which mocks pi-mono `Agent` via
 * `vi.mock`) remains in place for backward-compat with the ~7 test files that
 * already wire through it. New tests should prefer the runtime-shape helper
 * because it survives an adapter swap (kova#NEW-13 ClaudeCliRuntime, …).
 */

import { vi } from 'vitest';
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeFactory,
  AssistantTurn,
  RuntimeEvent,
} from '../ai/runtime/types.js';
import type { WaveResponse } from './mock-agent.js';

// ────────────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-response default fill-ins applied when a {@link WaveResponse} omits a
 * field. Exposed so tests that want to override one without re-specifying
 * everything can build atop these.
 */
export const MOCK_AGENT_DEFAULTS = Object.freeze({
  /** Default per-turn cost — matches the legacy `createMockAgent` default. */
  cost: 0.05,
  /** Default assistant text when neither `result` nor `structuredOutput` is set. */
  result: 'completed',
});

// ────────────────────────────────────────────────────────────────────────────
// Internal: one mock runtime instance
// ────────────────────────────────────────────────────────────────────────────

interface MockRuntimeInstance extends AgentRuntime {
  /** Test-side flag for asserting `abort()` was called. */
  aborted: boolean;
}

/**
 * Build a single mock `AgentRuntime` that replays exactly one canned
 * `WaveResponse`. Each call to `factory.create(...)` produces a fresh one.
 */
function buildMockRuntime(response: WaveResponse, onPrompt: (userMessage: string) => void): MockRuntimeInstance {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const transcript: AgentMessage[] = [];
  let abortedFlag = false;
  let errorMessage: string | undefined;

  const textResult = response.structuredOutput
    ? JSON.stringify(response.structuredOutput)
    : (response.result ?? MOCK_AGENT_DEFAULTS.result);

  const turnCost = response.cost ?? MOCK_AGENT_DEFAULTS.cost;

  /**
   * Build the kova-shape `AssistantTurn` for this response. Pi-mono error
   * responses get `stopReason: 'error'` + the message; normal responses
   * get `stopReason: 'end_turn'`. Usage tokens are stubbed at 0 — tests that
   * care about token accounting (e.g. wave-cost-cap) inject their own values
   * via the pricing layer or simulate explicit turn-end events.
   */
  const buildAssistantTurn = (): AssistantTurn =>
    response.piMonoError
      ? {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          usage: { input: 0, output: 0, cost: { total: 0 } },
          stopReason: 'error',
          errorMessage: response.piMonoError,
        }
      : {
          role: 'assistant',
          content: [{ type: 'text', text: textResult }],
          usage: { input: 0, output: 0, cost: { total: turnCost } },
          stopReason: 'end_turn',
        };

  const runtime: MockRuntimeInstance = {
    get aborted() {
      return abortedFlag;
    },
    async prompt(userMessage: string): Promise<void> {
      onPrompt(userMessage);
      // Record the user turn first so test asserts on transcript order pass.
      transcript.push({ role: 'user', content: userMessage });
      if (response.error) {
        // Surface the rejection without emitting a turn_end — matches what
        // pi-mono does when the underlying stream throws.
        throw new Error(response.error);
      }
      const assistantTurn = buildAssistantTurn();
      transcript.push(assistantTurn);
      if (response.piMonoError) {
        errorMessage = response.piMonoError;
      }
      // Fire turn_end synchronously so subscribers observe it before the
      // promise resolves. Matches the pi-mono adapter's ordering.
      for (const listener of listeners) {
        listener({ type: 'turn_end', message: assistantTurn });
      }
    },
    abort(): void {
      abortedFlag = true;
    },
    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get state(): { messages: ReadonlyArray<AgentMessage>; errorMessage?: string } {
      return errorMessage != null ? { messages: transcript, errorMessage } : { messages: transcript };
    },
    steer: vi.fn(),
  };

  return runtime;
}

// ────────────────────────────────────────────────────────────────────────────
// Public: factory builders
// ────────────────────────────────────────────────────────────────────────────

interface MockAgentRuntimeFactory extends AgentRuntimeFactory {
  /** Index of the next response to deliver. Exposed for advanced tests. */
  callIndex(): number;
}

/**
 * Build an `AgentRuntimeFactory` that replays the given canned responses in
 * order. Each call to `factory.create(...)` consumes one response.
 *
 * Throws if `create()` is invoked more times than there are responses.
 */
export const createMockAgentRuntimeFactory: ((responses: WaveResponse[]) => MockAgentRuntimeFactory) & {
  withPrompts(responses: WaveResponse[]): { factory: MockAgentRuntimeFactory; prompts: string[] };
  withConfigs(responses: WaveResponse[]): { factory: MockAgentRuntimeFactory; configs: AgentRuntimeConfig[] };
} = Object.assign((responses: WaveResponse[]): MockAgentRuntimeFactory => buildFactory(responses).factory, {
  withPrompts(responses: WaveResponse[]): { factory: MockAgentRuntimeFactory; prompts: string[] } {
    const built = buildFactory(responses);
    return { factory: built.factory, prompts: built.prompts };
  },
  withConfigs(responses: WaveResponse[]): { factory: MockAgentRuntimeFactory; configs: AgentRuntimeConfig[] } {
    const built = buildFactory(responses);
    return { factory: built.factory, configs: built.configs };
  },
});

/**
 * Internal factory builder — returns the factory plus the metadata buffers
 * (`prompts`, `configs`) shared across every runtime instance the factory
 * produces. The public surfaces above pick which buffers to expose.
 */
function buildFactory(responses: WaveResponse[]): {
  factory: MockAgentRuntimeFactory;
  prompts: string[];
  configs: AgentRuntimeConfig[];
} {
  let index = 0;
  const prompts: string[] = [];
  const configs: AgentRuntimeConfig[] = [];

  const factory: MockAgentRuntimeFactory = {
    create(config: AgentRuntimeConfig): AgentRuntime {
      const response = responses[index++];
      if (!response) {
        throw new Error(
          `MockAgentRuntimeFactory: Unexpected create() call #${index} — only ${responses.length} responses configured`,
        );
      }
      configs.push(config);
      return buildMockRuntime(response, (userMessage) => {
        prompts.push(userMessage);
      });
    },
    callIndex(): number {
      return index;
    },
  };

  return { factory, prompts, configs };
}
