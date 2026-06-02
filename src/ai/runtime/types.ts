/**
 * Kova-owned `AgentRuntime` interface — abstracts the construction of an LLM
 * agent so wave-executor can plug alternative backends (pi-mono today, claude
 * CLI / OpenAI Assistants / etc. tomorrow) without forking.
 *
 * This file is the source of truth for the runtime contract. It MUST NOT
 * import any pi-mono symbol — types are kova-owned (not pi-mono re-exports).
 *
 * Issue: kova#309
 * First concrete implementation: kova#310 (PiAgentRuntime adapter)
 */

// ────────────────────────────────────────────────────────────────────────────
// Message + content shapes (kova-owned, structural)
// ────────────────────────────────────────────────────────────────────────────

/** Inline text content emitted by an assistant turn. */
export interface RuntimeTextContent {
  type: 'text';
  text: string;
}

/** Tool-call request emitted by an assistant turn. */
export interface RuntimeToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: tool args are tool-defined and adapter-passthrough
  input: any;
}

/** Optional thinking / reasoning block surfaced by some providers. */
export interface RuntimeThinkingContent {
  type: 'thinking';
  text: string;
}

/** Discriminated union of content blocks an assistant turn can carry. */
export type RuntimeContent = RuntimeTextContent | RuntimeToolUseContent | RuntimeThinkingContent;

/** User message — kova-owned shape. */
export interface UserMessage {
  role: 'user';
  content: string | ReadonlyArray<RuntimeContent>;
  timestamp?: number;
}

/** Tool-result message — kova-owned shape. */
export interface ToolResultMessage {
  role: 'tool_result' | 'toolResult';
  toolCallId: string;
  toolName?: string;
  content: string | ReadonlyArray<RuntimeContent>;
  isError?: boolean;
  timestamp?: number;
}

/**
 * Kova-owned assistant turn.
 *
 * `usage.cost.total` is the USD cost for this turn. Today the pi-mono adapter
 * passes through pi-mono's pre-computed cost; after kova#NEW-07 lands the
 * adapter calls `priceUsage(model.id, msg.usage)` from kova-owned pricing.
 */
export interface AssistantTurn {
  role: 'assistant';
  content: ReadonlyArray<RuntimeContent>;
  usage: {
    /** Input tokens consumed this turn. */
    input: number;
    /** Output tokens produced this turn. */
    output: number;
    /** Cost in USD, computed by the adapter. */
    cost: { total: number };
  };
  /**
   * Why this turn ended.
   *
   * - `end_turn` — model emitted a normal final message
   * - `tool_use` — model requested one or more tools (agent loop will continue)
   * - `max_turns` — agent loop hit its turn cap
   * - `aborted`  — `abort()` was called or upstream cancellation
   * - `error`    — provider/network/parsing error (see `errorMessage`)
   */
  stopReason: 'end_turn' | 'tool_use' | 'max_turns' | 'aborted' | 'error';
  /** Populated when `stopReason === 'error'` or `'aborted'`. */
  errorMessage?: string;
  /** Optional timestamp (ms since epoch). */
  timestamp?: number;
}

/** Union of all message shapes the runtime can surface. */
export type AgentMessage = UserMessage | AssistantTurn | ToolResultMessage;

// ────────────────────────────────────────────────────────────────────────────
// Events emitted by `AgentRuntime.subscribe(listener)`
// ────────────────────────────────────────────────────────────────────────────

/**
 * Event surface kept intentionally minimal (load-bearing only).
 *
 * Other pi-mono events (`agent_start`, `turn_start`, `message_update`,
 * `tool_execution_end`, `agent_end`, …) are NOT in scope here — they are
 * either debug-only or adapter-internal. Runtimes that cannot emit
 * `tool_execution_start` may simply omit it.
 */
export type RuntimeEvent =
  | {
      type: 'turn_end';
      /** The assistant turn that just ended (or undefined for non-assistant turns). */
      message?: AssistantTurn;
    }
  | {
      type: 'tool_execution_start';
      /** Optional — debug log only; runtimes without this event can no-op. */
      toolName?: string;
    };

// ────────────────────────────────────────────────────────────────────────────
// Tool + hook shapes (kova-owned, structural — adapter-passthrough)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A tool registered with the runtime.
 *
 * Today these are pi-mono `AgentTool` objects passed through; the runtime
 * treats them as opaque. The interface stays generic so non-pi-mono runtimes
 * can accept their own tool definitions.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque tool object — adapter-typed at construction
export type RuntimeTool = any;

/** Context passed to the optional `afterToolCall` hook. */
// biome-ignore lint/suspicious/noExplicitAny: opaque adapter-passthrough
export type RuntimeAfterToolCallContext = any;

/** Return value of the optional `afterToolCall` hook. */
// biome-ignore lint/suspicious/noExplicitAny: opaque adapter-passthrough
export type RuntimeAfterToolCallResult = any;

/** Context passed to the optional `beforeToolCall` hook. */
// biome-ignore lint/suspicious/noExplicitAny: opaque adapter-passthrough
export type RuntimeBeforeToolCallContext = any;

/** Return value of the optional `beforeToolCall` hook — `{ block: true, reason }` rejects the call. */
// biome-ignore lint/suspicious/noExplicitAny: opaque adapter-passthrough
export type RuntimeBeforeToolCallResult = any;

/** Provider name → API key resolver. */
export type RuntimeGetApiKey = (provider: string) => string | undefined | Promise<string | undefined>;

/**
 * Optional context-transform hook (e.g. aggressive compaction).
 *
 * The second `signal` argument is optional — runtimes that support cooperative
 * cancellation (pi-mono today) forward an `AbortSignal`; runtimes that don't,
 * omit it. Implementations should be defensive and treat it as optional.
 *
 * Typed against `AgentMessage[]` (the kova-owned shape) so the wave-executor
 * sees a stable surface; adapter-level transforms that operate on
 * provider-specific message shapes use `any`-equivalent passthrough.
 */
export type RuntimeTransformContext = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

/** Optional after-tool-call hook. */
export type RuntimeAfterToolCallHook = (
  ctx: RuntimeAfterToolCallContext,
) => Promise<RuntimeAfterToolCallResult | undefined>;

/** Optional before-tool-call hook — return `{ block: true, reason }` to reject the call. */
export type RuntimeBeforeToolCallHook = (
  ctx: RuntimeBeforeToolCallContext,
) => Promise<RuntimeBeforeToolCallResult | undefined>;

// ────────────────────────────────────────────────────────────────────────────
// Model + thinking-level (kova-owned aliases — opaque at the interface level)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A resolved model spec — passed through to the adapter unchanged.
 *
 * Today this is pi-ai `Model`. Other runtimes can use their own model handle.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque adapter-passthrough
export type ModelSpec = any;

/**
 * Optional thinking / reasoning effort level.
 *
 * The value set is intentionally aligned with pi-mono's `ThinkingLevel`
 * (`off | minimal | low | medium | high | xhigh`) so today's pi-mono adapter
 * passes through unchanged. Alternate runtimes may map these to whatever
 * provider-native knob exists (or ignore them entirely).
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// ────────────────────────────────────────────────────────────────────────────
// AgentRuntime + Factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * Live runtime handle for a single wave execution.
 *
 * The wave-executor uses ONLY these members. Everything else (e.g. `steer`,
 * `agent.transformContext = …` reassignment, `tool_execution_start` events)
 * is optimization-only and runtimes that cannot expose it may no-op it.
 */
export interface AgentRuntime {
  /** Send the initial user message and run the agent loop to completion. */
  prompt(userMessage: string): Promise<void>;

  /** Cancel the current run (cooperative — may not fire instantly). */
  abort(): void;

  /** Subscribe to runtime events. Returns an unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;

  /** Current transcript + last error. */
  readonly state: {
    messages: ReadonlyArray<AgentMessage>;
    errorMessage?: string;
  };

  // ── Optional members (Tier-1/Tier-2 graceful degradation knobs) ─────────
  //
  // These are present for the pi-mono adapter today; alternate runtimes may
  // expose them or leave them undefined. The wave-executor's 3-tier context
  // policy collapses safely to Tier-3 abort when these are missing.

  /** Optional Tier-1 mid-turn steer (70% context). */
  steer?: (msg: { role: 'user'; content: string; timestamp?: number }) => void;

  /** Optional Tier-2 aggressive context trim (80% context). */
  transformContext?: RuntimeTransformContext;
}

/**
 * Construction-time configuration for a runtime.
 *
 * Adapter-specific extras (e.g. pi-mono `streamFn`, `convertToLlm`,
 * `sessionId`, `thinkingBudgets`) live on the adapter, not here — keep the
 * interface to the load-bearing surface.
 */
export interface AgentRuntimeConfig {
  systemPrompt: string;
  model: ModelSpec;
  thinkingLevel?: ThinkingLevel;
  tools: ReadonlyArray<RuntimeTool>;
  transformContext?: RuntimeTransformContext;
  afterToolCall?: RuntimeAfterToolCallHook;
  beforeToolCall?: RuntimeBeforeToolCallHook;
  getApiKey: RuntimeGetApiKey;
}

/** Factory that constructs a fresh `AgentRuntime` per wave. */
export interface AgentRuntimeFactory {
  create(config: AgentRuntimeConfig): AgentRuntime;
}
