/**
 * `PiAgentRuntime` — kova adapter that wraps the pi-mono `Agent`.
 *
 * This is the single seam between kova's `wave-executor` and the pi-mono
 * package. The wave-executor consumes only the kova-owned `AgentRuntime`
 * interface (`./types.ts`); this file is the only place in kova outside the
 * model-registration helpers (`./models.ts`, `./router.ts`, `./ollama.ts`)
 * that imports pi-mono symbols directly.
 *
 * The adapter performs three pieces of translation:
 *
 *   1. `subscribe()` wraps pi-mono `AgentEvent` → kova `RuntimeEvent`. Only
 *      `turn_end` and `tool_execution_start` cross the boundary; every other
 *      pi-mono event (`agent_start`, `message_update`, …) is dropped because
 *      kova's `RuntimeEvent` union does not declare it.
 *
 *   2. Assistant `stopReason` is normalized:
 *        pi-mono  → kova
 *        ───────────────
 *        'stop'    → 'end_turn'
 *        'length'  → 'max_turns'
 *        'toolUse' → 'tool_use'
 *        'error'   → 'error'    (shared literal)
 *        'aborted' → 'aborted'  (shared literal)
 *
 *   3. Content blocks of type `toolCall` (pi-mono) are reshaped into
 *      `tool_use` (kova): `arguments` → `input`. Text and thinking blocks
 *      pass through unchanged.
 *
 * The same translation runs on `state.messages` (live view — re-reads the
 * underlying Agent on every access). Translation is structural; if a value
 * already looks like the kova shape (e.g. `stopReason: 'end_turn'`) it
 * passes through unchanged so test fixtures and future runtimes that adopt
 * the kova literals out of the box keep working.
 *
 * Cost note (issue #313): pi-mono pre-computes `usage.cost.total` from its
 * internal pricing table. Wave-executor re-prices through `priceUsage()` from
 * the kova-owned `pricing.ts`, so the adapter does NOT touch usage.cost —
 * pricing is owned by the consumer, not the adapter.
 *
 * Issues: kova#309 (interface), kova#310 (this file — full extraction).
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeFactory,
  AssistantTurn,
  CacheRetention,
  RuntimeContent,
  RuntimeEvent,
} from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// Translation helpers (pi-mono → kova)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Translate pi-mono `StopReason` to kova `AssistantTurn.stopReason`.
 *
 * Pi-mono and kova share `'error'` and `'aborted'` literals verbatim. The
 * other three rename to the kova vocabulary. Unknown values pass through
 * (cast through `as`) so an adapter receiving an unexpected literal does
 * not silently default to `'error'`; the downstream `isAssistantMessage`
 * + `stopReason === 'error' | 'aborted'` checks remain authoritative.
 */
function translateStopReason(value: unknown): AssistantTurn['stopReason'] {
  switch (value) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_turns';
    case 'toolUse':
      return 'tool_use';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    // Kova-native literals — passed through if the upstream already speaks kova.
    case 'end_turn':
    case 'tool_use':
    case 'max_turns':
      return value;
    default:
      // Conservative fallback: unknown stopReason becomes 'end_turn' so the
      // wave-executor treats the turn as a normal completion rather than an
      // error. The kova-owned `isAssistantMessage` guard handles missing
      // `stopReason` defensively elsewhere.
      return 'end_turn';
  }
}

/**
 * Translate a single content block from pi-mono shape to kova shape.
 *
 * - `text` and `thinking` blocks pass through unchanged (identical shapes).
 * - Pi-mono `toolCall` → kova `tool_use`: rename `arguments` → `input`.
 * - Kova-native `tool_use` blocks pass through (idempotent — translating an
 *   already-translated message must not corrupt it).
 * - Anything else is preserved verbatim so adapter-internal block kinds
 *   (image, citation, etc.) flow through.
 */
function translateContentBlock(block: unknown): RuntimeContent {
  if (block == null || typeof block !== 'object') {
    return block as RuntimeContent;
  }
  const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown; input?: unknown };
  if (b.type === 'toolCall') {
    return {
      type: 'tool_use',
      id: String(b.id ?? ''),
      name: String(b.name ?? ''),
      input: b.arguments ?? {},
    };
  }
  // Already kova-shaped or unknown — pass through structurally.
  return block as RuntimeContent;
}

/**
 * Translate a content array (assistant `content[]`). Defensive against
 * non-array values — returns an empty array so downstream `.filter()` /
 * `.map()` calls in wave-executor never throw.
 */
function translateContentArray(content: unknown): RuntimeContent[] {
  if (!Array.isArray(content)) return [];
  return content.map(translateContentBlock);
}

/**
 * Translate a single message from pi-mono shape to kova `AgentMessage`.
 *
 * Strategy: only rebuild the fields we own (role, content, stopReason). All
 * other fields (timestamp, usage, errorMessage, api, provider, …) are
 * preserved via spread so adapter-internal metadata flows through unchanged.
 */
function translateMessage(msg: unknown): AgentMessage {
  if (msg == null || typeof msg !== 'object') {
    return msg as AgentMessage;
  }
  const m = msg as { role?: unknown; content?: unknown; stopReason?: unknown };
  if (m.role === 'assistant') {
    const translated = {
      ...(msg as object),
      role: 'assistant' as const,
      content: translateContentArray(m.content),
      stopReason: translateStopReason(m.stopReason),
    };
    // Cast through `unknown` — pi-mono `AssistantMessage` carries extra
    // adapter-internal fields (`api`, `provider`, `model`, `responseId`, …)
    // that aren't part of the kova `AssistantTurn` surface. Spreading them
    // through is intentional (consumers that need them can still read them),
    // but the structural mismatch with `usage`'s shape requires the wider
    // cast.
    return translated as unknown as AssistantTurn;
  }
  // User and toolResult messages pass through. Kova's `ToolResultMessage`
  // accepts both `'tool_result'` and `'toolResult'` role literals, and the
  // content shape is structurally compatible.
  return msg as AgentMessage;
}

/**
 * Translate a pi-mono `AgentEvent` into a kova `RuntimeEvent`, or return
 * `undefined` to drop the event. The kova event surface is intentionally
 * minimal — only `turn_end` and `tool_execution_start` are load-bearing.
 */
function translateEvent(event: unknown): RuntimeEvent | undefined {
  if (event == null || typeof event !== 'object') return undefined;
  const e = event as { type?: unknown };
  if (e.type === 'turn_end') {
    const t = event as { message?: unknown };
    if (t.message === undefined) {
      // Tool-only turn end (no assistant message) — propagate the event so
      // the wave-executor's turn counter still increments, but with no
      // message payload.
      return { type: 'turn_end' };
    }
    const translated = translateMessage(t.message);
    // The kova `turn_end.message` slot is typed `AssistantTurn | undefined`;
    // non-assistant messages get folded to `undefined` so the wave-executor's
    // `isAssistantMessage` check still gates the read paths correctly.
    return {
      type: 'turn_end',
      ...(isAssistantTurnShape(translated) ? { message: translated as AssistantTurn } : {}),
    };
  }
  if (e.type === 'tool_execution_start') {
    const t = event as { toolName?: unknown };
    return {
      type: 'tool_execution_start',
      ...(typeof t.toolName === 'string' ? { toolName: t.toolName } : {}),
    };
  }
  // Everything else (`agent_start`, `agent_end`, `turn_start`, `message_*`,
  // `tool_execution_update`, `tool_execution_end`) is not part of the kova
  // RuntimeEvent union — drop it.
  return undefined;
}

/** Structural guard mirroring `wave-executor.isAssistantMessage` for the adapter side. */
function isAssistantTurnShape(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'role' in msg && (msg as { role: unknown }).role === 'assistant';
}

// ────────────────────────────────────────────────────────────────────────────
// streamFn wrapper for cacheRetention (issue #297)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wrap pi-ai `streamSimple` with a closure that injects `cacheRetention`
 * (issue #297). Pi-mono's loop config does NOT carry `cacheRetention`, so the
 * `streamFn` slot is the only place where the per-request hint reaches the
 * provider stream call. The closure preserves any caller-supplied options
 * (temperature, headers, …) and merges retention on top — explicit
 * per-call `cacheRetention` in `options` still wins because spread order is
 * `{ ...options, cacheRetention }`.
 *
 * Exported for tests so wave-executor tests can drive the wrapper directly.
 */
function wrapStreamFnWithCacheRetention(retention: CacheRetention): typeof streamSimple {
  // biome-ignore lint/suspicious/noExplicitAny: pi-ai streamSimple is parameterized over Api/options
  const wrapped = (model: any, context: any, options: any): any =>
    streamSimple(model, context, {
      ...((options ?? {}) as Record<string, unknown>),
      cacheRetention: retention,
    });
  // biome-ignore lint/suspicious/noExplicitAny: cast back to the typeof signature
  return wrapped as any;
}

// ────────────────────────────────────────────────────────────────────────────
// PiAgentRuntime — the adapter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Construct a fresh pi-mono `Agent` and return a kova `AgentRuntime` wrapper
 * around it.
 *
 * The returned object is NOT the pi-mono `Agent` — it is a thin proxy that
 * (a) translates events emitted by `Agent.subscribe`, (b) re-reads
 * `Agent.state.messages` through `translateMessage` on every access, and
 * (c) forwards `prompt`, `abort`, and `steer` through unchanged.
 */
function createPiAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
  const {
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    transformContext,
    afterToolCall,
    beforeToolCall,
    getApiKey,
    sessionId,
    cacheRetention,
  } = config;

  // `exactOptionalPropertyTypes` rejects undefined-valued optional fields, so
  // build the pi-mono `initialState` conditionally instead of inlining `?:`.
  // biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool array — adapter-passthrough
  const initialState: Record<string, any> = { systemPrompt, model, tools };
  if (thinkingLevel !== undefined) initialState.thinkingLevel = thinkingLevel;

  // When `cacheRetention` is set, wrap `streamSimple` with a closure that
  // merges retention into the options object. When unset, pass the canonical
  // `streamSimple` reference through unchanged so callers that rely on
  // identity (tests, the agent-loop's `streamFn || streamSimple` guard,
  // future memoization) keep working as before.
  const streamFn = cacheRetention != null ? wrapStreamFnWithCacheRetention(cacheRetention) : streamSimple;

  const agent = new Agent({
    // biome-ignore lint/suspicious/noExplicitAny: built defensively above
    initialState: initialState as any,
    streamFn,
    convertToLlm,
    getApiKey,
    // Pi-mono Agent natively threads `sessionId` to providers for cache-aware
    // backends (Anthropic session-id header, Bedrock cache partitioning, etc).
    ...(sessionId != null ? { sessionId } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: pi-mono transformContext is structurally compatible
    ...(transformContext ? { transformContext: transformContext as any } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: pi-mono afterToolCall is structurally compatible
    ...(afterToolCall ? { afterToolCall: afterToolCall as any } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: pi-mono beforeToolCall is structurally compatible
    ...(beforeToolCall ? { beforeToolCall: beforeToolCall as any } : {}),
  });

  const runtime: AgentRuntime = {
    prompt: (userMessage: string) => agent.prompt(userMessage),
    abort: () => agent.abort(),
    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      // Wrap the caller's listener so pi-mono events get translated before
      // they reach kova-side consumers. Events that have no kova-side
      // counterpart (`agent_start`, `message_update`, …) are dropped.
      // biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentEvent — translated below
      const wrapped = (event: any): void => {
        const translated = translateEvent(event);
        if (translated !== undefined) listener(translated);
      };
      return agent.subscribe(wrapped);
    },
    // `state` is exposed as a getter-bearing object so `state.messages` is
    // re-read from the underlying Agent on every access. This preserves the
    // "live view" semantic the wave-executor depends on when it walks the
    // transcript at the end of a run.
    //
    // Built fresh per-read so `exactOptionalPropertyTypes` is honored:
    // `errorMessage` is only present on the returned object when the
    // underlying Agent has set one. Otherwise the field is omitted entirely
    // (not set to `undefined`).
    get state(): { messages: ReadonlyArray<AgentMessage>; errorMessage?: string } {
      const messages = agent.state.messages.map(translateMessage);
      const errorMessage = agent.state.errorMessage;
      return errorMessage != null ? { messages, errorMessage } : { messages };
    },
    // Optional Tier-1 mid-turn steer (70% context). Pi-mono's `Agent.steer`
    // accepts a `UserMessage` whose `timestamp` is required; the kova
    // interface declares it optional. Forward a default timestamp when the
    // caller omits one so the pi-mono call site is well-typed.
    steer: (msg) => {
      agent.steer({ ...msg, timestamp: msg.timestamp ?? Date.now() });
    },
  };

  // Pi-mono lets callers reassign `agent.transformContext` after construction
  // for the Tier-2 trim slot. Today kova does not exercise this (issue #296
  // removed the Tier-2 path), but the field is part of the kova interface
  // for adapter parity. Expose it as a setter-bearing pass-through.
  Object.defineProperty(runtime, 'transformContext', {
    enumerable: true,
    configurable: true,
    get: () => (agent as unknown as { transformContext?: unknown }).transformContext,
    set: (v: unknown) => {
      (agent as unknown as { transformContext?: unknown }).transformContext = v;
    },
  });

  return runtime;
}

/**
 * Default factory wired into wave-executor when no runtime is injected.
 *
 * Wave-executor accepts an optional `runtimeFactory` config field and falls
 * back to this default. Tests inject `MockAgentRuntimeFactory` (issue #310,
 * `src/test-helpers/mock-agent-runtime.ts`); future runtimes
 * (ClaudeCliRuntime — kova#NEW-13) wire the same way.
 */
export const defaultAgentRuntimeFactory: AgentRuntimeFactory = {
  create: createPiAgentRuntime,
};

// Re-export AgentMessage at the adapter boundary so consumers reading the
// adapter file do not have to chase types.ts for it.
export type { AgentMessage };
// Internal exports for tests + ClaudeCliRuntime (kova#NEW-13).
export { createPiAgentRuntime, translateContentBlock, translateEvent, translateMessage, translateStopReason };
