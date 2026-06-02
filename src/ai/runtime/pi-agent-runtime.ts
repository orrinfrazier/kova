/**
 * Default `AgentRuntime` factory — wraps pi-mono `Agent`.
 *
 * Scope (kova#309 — interface introduction only):
 *
 * This is a minimal pass-through adapter that constructs `new Agent({...})`
 * with the exact same arguments wave-executor used to pass inline at L116.
 * No event / message translation is performed yet; pi-mono's `AgentEvent` and
 * `AgentMessage` shapes happen to be structurally compatible with the kova
 * surface the wave-executor reads (`usage.input`, `usage.cost.total`,
 * `stopReason ∈ {'error','aborted'}`, `content[]`).
 *
 * Follow-up (kova#310 — PiAgentRuntime full extraction):
 *
 * - Translate pi-mono `AgentEvent` → kova `RuntimeEvent` in subscribe()
 * - Translate pi-mono `AgentMessage` → kova `AgentMessage` in state.messages
 * - Translate pi-mono stopReason `'stop'|'length'|'toolUse'` → kova
 *   `'end_turn'|'max_turns'|'tool_use'`
 * - Map kova `RuntimeTool` → pi-mono `AgentTool` (today: pass-through)
 * - After kova#NEW-07 lands, compute usage.cost.total from the kova-owned
 *   pricing table instead of trusting pi-mono's pre-computed value
 *
 * Until #310 lands, this file is the single seam between the wave-executor
 * and pi-mono. Everything else in wave-executor.ts should go through the
 * `AgentRuntime` interface, not pi-mono symbols directly.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeFactory,
  CacheRetention,
  RuntimeEvent,
} from './types.js';

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

/**
 * Construct a fresh pi-mono `Agent` wrapped as an `AgentRuntime`.
 *
 * The returned object satisfies the interface structurally — today it IS a
 * pi-mono Agent under the hood; the type system constrains wave-executor to
 * only touch the interface surface.
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

  // Pi-mono's `Agent.createLoopConfig` does not include `cacheRetention` in
  // the loop config it passes to `streamFn`, so the only seam where we can
  // inject the per-request hint is the `streamFn` itself. When the caller
  // sets `cacheRetention`, wrap `streamSimple` with a closure that merges the
  // retention preference into the options object before delegating.
  //
  // When `cacheRetention` is unset, pass the canonical `streamSimple`
  // reference through unchanged so callers that rely on identity (tests, the
  // agent-loop's `streamFn || streamSimple` guard, future memoization) keep
  // working as before.
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

  // The pi-mono Agent already implements the kova interface structurally:
  //   prompt(string)            — Agent.prompt(string)
  //   abort()                   — Agent.abort()
  //   subscribe(listener) → off — Agent.subscribe(listener) returns unsubscribe
  //   state.messages            — Agent.state.messages
  //   state.errorMessage        — Agent.state.errorMessage
  //   steer(msg)                — Agent.steer(msg)  (Tier-1 mid-turn)
  //   transformContext = fn     — Agent.transformContext = fn  (Tier-2 trim)
  //
  // Pi-mono's `AgentEvent` is a superset of `RuntimeEvent`; subscribe-callers
  // ignore unknown event types so passing through is safe.
  return agent as unknown as AgentRuntime & { subscribe(l: (e: RuntimeEvent) => void): () => void };
}

/**
 * Default factory wired into wave-executor when no runtime is injected.
 *
 * Kova#310 will replace this with a proper `PiAgentRuntime` class that does
 * full event/message translation. Until then, `factory.create(...)` returning
 * an Agent is sufficient to satisfy AC#2: wave-executor constructs via
 * `factory.create(...)` instead of `new Agent(...)`.
 */
export const defaultAgentRuntimeFactory: AgentRuntimeFactory = {
  create: createPiAgentRuntime,
};

// Re-export AgentMessage at the adapter boundary so consumers reading the
// adapter file do not have to chase types.ts for it.
export type { AgentMessage };
// Internal export for tests + future #310 extraction.
export { createPiAgentRuntime };
