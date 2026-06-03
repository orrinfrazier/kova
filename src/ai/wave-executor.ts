// Per-wave agent spawner — creates a fresh agent runtime for each pipeline wave.
// spawnWaveAgent() is the primary interface: takes resolved model string, pre-built tools,
// and explicit handoff context. Returns WaveHandoff<T>.
// executeWave() is a backward-compat wrapper that resolves model/tools internally.
//
// Agent construction goes through the kova-owned `AgentRuntimeFactory` (kova#309/#310)
// rather than instantiating pi-mono `Agent` directly. The default factory wraps
// pi-mono and lives in `src/ai/runtime/pi-agent-runtime.ts` — the only place in
// this file's transitive imports that touches `@earendil-works/pi-agent-core`
// or `@earendil-works/pi-ai`. Future runtimes (kova#NEW-13 ClaudeCliRuntime,
// OpenAI Assistants, …) plug in via the same `AgentRuntimeFactory` seam.

import type { z } from 'zod';
import type { EventBus } from '../services/event-bus/bus.js';
import type { EventWaveName } from '../services/event-bus/schema.js';
import { createToolCallCounter, type ToolCallCounts } from '../services/tool-call-counter.js';
import type { WaveHandoff, WaveModelConfig, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { createDestructiveEditGuard, type DestructiveEditGuardOptions } from './destructive-edit-guard.js';
import { classifyError, isSpendingCapBehavior, KovaError } from './errors.js';
import { createImportPreservationGuard, type ImportPreservationGuardOptions } from './import-preservation-guard.js';
import { getModelString, resolveModelFromString, resolveWaveModel } from './models.js';
import { isOllamaProvider, resolveOllamaApiKey } from './ollama.js';
import { composeBeforeToolCallHooks, createPieceScopeGuard } from './piece-scope-guard.js';
import { priceUsage, type TokenUsage } from './pricing.js';
import { getRouterDefaultModel, isRouterProvider, resolveRouterApiKey } from './router.js';
import {
  type AgentRuntimeFactory,
  type AssistantTurn,
  type CacheRetention,
  defaultAgentRuntimeFactory,
  type RuntimeBeforeToolCallHook,
  type RuntimeTool,
  type ThinkingLevel,
} from './runtime/index.js';
import type { TruncationOptions } from './tool-result-truncate.js';
import { type AIWaveName, DEFAULT_THINKING_LEVELS, getWaveTools, PIECE_SCOPE_WAVES } from './wave-tools.js';

export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
  zodSchema?: z.ZodType;
}

/**
 * Local tool alias — opaque at this layer. The kova-owned `RuntimeTool` type
 * (`./runtime/types.ts`) is `any` by design: the wave-executor treats tools
 * as adapter-typed payloads and never inspects their shape directly. The
 * underlying runtime (today: pi-mono `AgentTool`) is the only place that
 * narrows the type.
 */
type AnyTool = RuntimeTool;

/**
 * Runtime type guard for the kova-owned `AssistantTurn` shape (kova#309).
 *
 * Validates the structural surface wave-executor actually reads — `role`,
 * `content` array, `usage` object. The narrower `usage.input` / `usage.cost.total`
 * fields are accessed defensively at the call sites that need them so adapters
 * that supply only one of the two (e.g. local models with no cost data) still
 * progress.
 *
 * The shape is intentionally structural so pi-mono `AssistantMessage` objects
 * (today's runtime backing) and future runtime-translated `AssistantTurn`
 * objects (post-kova#310) both pass.
 */
export function isAssistantMessage(msg: unknown): msg is AssistantTurn {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'role' in msg &&
    (msg as { role: unknown }).role === 'assistant' &&
    'content' in msg &&
    Array.isArray((msg as { content: unknown }).content) &&
    'usage' in msg &&
    typeof (msg as { usage: unknown }).usage === 'object' &&
    (msg as { usage: unknown }).usage !== null
  );
}

/**
 * Project an assistant message's `usage` onto the kova-owned `TokenUsage`
 * shape. Defensive against runtimes (or test fixtures) that omit cache
 * fields — those default to 0. Issue #313.
 */
function toTokenUsage(usage: AssistantTurn['usage']): TokenUsage {
  const u = usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
  };
}

/**
 * Extract the bare model id from a `ROUTER_DEFAULT`-style string. Accepts
 * either `provider:modelId` (the round-trip form, e.g.
 * `anthropic:claude-sonnet-4-6`) or a bare modelId. Returns the bare id so
 * pricing can look it up against the kova table. Issue #313.
 */
function extractUnderlyingRouterModelId(routerDefault: string): string {
  const colonIndex = routerDefault.indexOf(':');
  return colonIndex > 0 ? routerDefault.slice(colonIndex + 1) : routerDefault;
}

/**
 * Default wall-clock timeouts per wave type (ms). `undefined` means no timeout.
 *
 * Sized for large workspaces (e.g. Rust monorepos where `cargo test` compilation
 * alone takes 2-5 minutes) and local-model inference (15-30s per turn). See
 * issue #244. Override per-repo via `rules.wave_timeout` in repos.yaml (seconds).
 */
export const DEFAULT_WAVE_TIMEOUTS: Record<WaveName, number | undefined> = {
  assess: 5 * 60 * 1000,
  spec: 5 * 60 * 1000,
  review: 5 * 60 * 1000,
  brainstorm: 10 * 60 * 1000,
  test: 30 * 60 * 1000,
  impl: 30 * 60 * 1000,
  quality: 20 * 60 * 1000,
  ship: undefined,
};

/**
 * Default prompt-cache retention per wave type (issue #297).
 *
 * Waves that run for 20-30 minutes of multi-turn tool calls ('impl', 'test')
 * benefit dramatically from `long` retention because the provider's default
 * `short` (~5 min) TTL expires mid-wave and the system prompt / large file
 * reads get re-billed as full input tokens on every turn.
 *
 * Fast waves leave the override `undefined` so the provider's default applies
 * (`short` on Anthropic) — no benefit to extending TTL for single-turn
 * structured-output calls that complete in well under five minutes.
 */
export const DEFAULT_WAVE_CACHE_RETENTION: Record<WaveName, CacheRetention | undefined> = {
  assess: undefined,
  spec: undefined,
  review: undefined,
  brainstorm: undefined,
  test: 'long',
  impl: 'long',
  quality: undefined,
  ship: undefined,
};

/**
 * Build a deterministic session id from repo + issue + wave (issue #297).
 *
 * Providers that key prompt caching off `sessionId` (Anthropic session
 * affinity, Bedrock cache partitioning) need the value to be stable across
 * the multi-turn run for a given wave, and to be distinct enough across
 * runs/waves that one wave's cache does not pollute another's.
 *
 * Format: `kova-<repo-slug>-<issue>-<wave>` where `<repo-slug>` lowercases
 * the repo and replaces non-alphanumerics with a single hyphen. The
 * `kova-` prefix avoids collisions with other tools sharing the provider
 * account.
 */
export function buildWaveSessionId(args: { repo: string; issue: string | number; wave: WaveName }): string {
  const slug = args.repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `kova-${slug}-${args.issue}-${args.wave}`;
}

type PublishWaveEvent = (
  payload:
    | { type: 'wave-enter'; wave: EventWaveName }
    | { type: 'wave-output'; wave: EventWaveName; turn: number; text?: string; costDelta?: number }
    | { type: 'cost'; wave: EventWaveName; costUsd: number }
    | { type: 'steered'; wave: EventWaveName; tier: 'steer' | 'trim' | 'abort'; usageRatio: number }
    | { type: 'aborted'; wave: EventWaveName; reason: string },
) => void;

function makeWavePublisher(
  bus: EventBus | undefined,
  context: SpawnWaveAgentConfig['eventContext'] | undefined,
  wave: WaveName,
): PublishWaveEvent {
  if (!bus || !context) {
    return () => {
      /* no-op when caller has not opted in */
    };
  }
  return (payload) => {
    // Narrow guard: 'ship' is a WaveName but not an EventWaveName. Treat as no-op.
    if (wave === ('ship' as WaveName)) return;
    bus.publish({
      runId: context.runId,
      repoId: context.repoId,
      fixId: context.fixId,
      ...(context.pieceId != null ? { pieceId: context.pieceId } : {}),
      ...payload,
    });
  };
}

export interface SpawnWaveAgentConfig {
  wave: WaveName;
  model: string;
  tools: AnyTool[];
  systemPrompt: string;
  handoffContext: string;
  userMessage: string;
  cwd: string;
  outputFormat?: OutputFormat;
  maxTurns?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
  thinkingLevel?: ThinkingLevel;
  /** Context usage threshold (0-1) — abort if input tokens exceed this fraction of contextWindow. Default: 0.9. Steer warning at 70%, aggressive trim at 80%. */
  contextThreshold?: number;
  /**
   * Tool-result truncation options. Set to configure or `false` to disable.
   * Default: enabled with 8k token budget.
   *
   * Issue #315 — truncation now runs at the tool-execute layer via
   * `withTruncatedResult` (see `./tool-result-truncate.ts`). This field is
   * accepted for backward compatibility; callers should configure truncation
   * by passing options to `getWaveTools(..., { toolResultTruncation })` and
   * `getMCPToolsForWave(..., truncation)` so the wrap happens before the
   * tools enter the runtime — that path survives a swap to claude-agent-sdk,
   * whose hook model has no output-side content-rewrite surface.
   *
   * Setting this field on `spawnWaveAgent` itself no longer attaches an
   * `afterToolCall` hook; runtime-level rewriting is incompatible with the
   * runtime-agnostic story.
   */
  toolResultTruncation?: TruncationOptions | false;
  /**
   * Optional `AgentRuntimeFactory` override (kova#309). Defaults to
   * `defaultAgentRuntimeFactory`, which wraps pi-mono `Agent`. Tests may
   * inject a mock factory; future runtimes (claude CLI, OpenAI Assistants)
   * are wired the same way.
   */
  runtimeFactory?: AgentRuntimeFactory;
  /**
   * Destructive-edit guard options. Set to configure thresholds, or `false` to disable.
   * Default: enabled with built-in thresholds (60% write ratio, 20 lines for trivial edit replacement).
   * The guard rejects Write/Edit tool calls that would delete large portions of files unless
   * `allowDestructive: true` is passed in the tool args.
   */
  destructiveEditGuard?: Omit<DestructiveEditGuardOptions, 'cwd'> | false;
  /**
   * Import-preservation guard options. Set to configure, or `false` to disable.
   * Default: enabled. Rejects Write/Edit tool calls that strip an import line whose
   * names are still referenced in the file body. Supports Rust `use`, TS/JS `import`,
   * Python `import`/`from`, and Go `import`. Shares the `allowDestructive: true`
   * per-call opt-out with the destructive-edit guard.
   */
  importPreservationGuard?: Omit<ImportPreservationGuardOptions, 'cwd'> | false;
  /**
   * Files this spec piece is allowed to modify (issue #250). Enforced only on the
   * `impl` wave — `test` and `quality` waves ignore it (test needs to create new
   * test files; quality needs to fix lint/type errors anywhere).
   *
   * Empty/undefined → no restriction (backward compat). When the impl wave runs
   * with a non-empty list, Write/Edit calls to files outside the list are blocked
   * with a clear "Cannot modify X — this piece only covers: [...]" message.
   */
  pieceFiles?: readonly string[] | undefined;
  /**
   * Optional `EventBus` for structured observability events (kova#292). When
   * provided, the wave publishes `wave-enter`, `wave-output`, `steered`,
   * `aborted`, and `cost` events tagged with `eventContext`. When omitted, the
   * wave runs unchanged — no events published. Pure side-effect; never alters
   * wave outcomes.
   */
  eventBus?: EventBus;
  /**
   * Identifier tag injected into every published event. Required when
   * `eventBus` is set; ignored otherwise.
   */
  eventContext?: {
    runId: string;
    repoId: string;
    fixId: string;
    pieceId?: string;
  };
  /**
   * Optional deterministic session identifier for prompt-cache affinity
   * (issue #297). Providers that key prompt caching off `sessionId`
   * (Anthropic, Bedrock) use it to keep the cache hot across the multi-turn
   * run. Callers from the fix pipeline typically build this from
   * `buildWaveSessionId({ repo, issue, wave })`. Unset → no session header is
   * sent and the provider falls back to its default behavior.
   */
  sessionId?: string;
  /**
   * Optional prompt-cache retention preference (issue #297). Long-running
   * multi-turn waves (`impl`, `test`) default to `'long'` via
   * `DEFAULT_WAVE_CACHE_RETENTION` so the system prompt and large early-turn
   * tool reads stay cached past the provider's default ~5 min TTL. Pass
   * `'short'` or `'none'` to opt out; pass `'long'` to opt a fast wave in.
   */
  cacheRetention?: CacheRetention;
  /**
   * Optional callback fired for every `tool_execution_start` event the
   * runtime emits (issue #278). Used by the retrieval-quality eval harness
   * (and any caller that wants per-tool telemetry) to mirror the agent's
   * stream into its own accumulator. The aggregated counts are also surfaced
   * directly on the returned handoff as `toolCallCounts`, so most callers
   * don't need this hook — it's exposed for cases that want per-event
   * granularity (e.g. interleaving counts with timestamps).
   *
   * `toolName` is forwarded from the runtime event verbatim; runtimes that
   * omit the name pass `undefined` per `RuntimeEvent`.
   */
  onToolCall?: (toolName: string | undefined) => void;
}

/**
 * INVARIANT: inter-wave Agent isolation ("fresh per wave" guarantee).
 *
 * `spawnWaveAgent` MUST return only `WaveHandoff<T>` — a structured `artifact`
 * (validated by Zod) plus run-level metadata (cost, turns, confidence,
 * telemetry counters). The pi-mono `Agent` instance created inside this
 * function MUST NOT escape its scope: no field on the returned handoff, and
 * no entry in any handoff-derived context (see `buildWaveContext` in
 * `src/pipeline/context.ts`), may hold a reference to the `Agent`, its
 * `messages` array, its tool-call history, or any object that transitively
 * retains them.
 *
 * Why this matters: every wave (assess → spec → test → impl → quality →
 * review) runs in a fresh `Agent` instantiated here. The next wave's
 * `Agent` is built from the typed `artifact` of the prior wave plus a
 * formatted context string — never from prior conversation turns. That
 * structural break is what gives kova its "fresh per wave" property:
 * reasoning context, tool memoization, and accidental coupling between
 * waves cannot leak across the boundary.
 *
 * Violation shapes to reject in review:
 *   1. Changing the return type to anything richer than `WaveHandoff<T>`
 *      (e.g. `{ handoff, agent }`, `{ handoff, messages }`).
 *   2. Mutating a shared module-level variable from within this function
 *      that a later wave reads.
 *   3. Adding a field to `WaveHandoffSchema` (see `src/types/handoffs.ts`)
 *      that holds Agent state — `messages`, `state`, `agent`, raw
 *      `AssistantMessage[]`, or any structurally equivalent payload.
 *   4. Returning the `Agent` via a side channel (event bus payload,
 *      callback closure capture, global registry).
 *
 * If you find yourself needing prior-wave conversation context to make a
 * wave work, that is a signal the artifact schema for the prior wave is
 * under-specified — extend the typed artifact, do not punch a hole in
 * the isolation boundary.
 */
export async function spawnWaveAgent<T = unknown>(config: SpawnWaveAgentConfig): Promise<WaveHandoff<T>> {
  const {
    wave,
    model: modelString,
    tools,
    systemPrompt,
    handoffContext,
    userMessage,
    cwd,
    outputFormat,
    maxTurns = 5_000,
    timeoutMs: explicitTimeout,
    maxCostUsd,
    thinkingLevel: explicitThinking,
    contextThreshold: rawThreshold = 0.9,
    // Issue #315 — truncation moved to the tool-execute layer
    // (`withTruncatedResult`). Accepted for backward compatibility but no
    // longer wired into the runtime here. Destructured-and-ignored on purpose.
    toolResultTruncation: _toolResultTruncation,
    runtimeFactory = defaultAgentRuntimeFactory,
    destructiveEditGuard,
    importPreservationGuard,
    pieceFiles,
    eventBus,
    eventContext,
    sessionId,
    cacheRetention: explicitCacheRetention,
    onToolCall,
  } = config;

  const timeoutMs = explicitTimeout ?? DEFAULT_WAVE_TIMEOUTS[wave];
  const thinkingLevel = explicitThinking ?? DEFAULT_THINKING_LEVELS[wave];
  const contextThreshold = Math.max(0.1, Math.min(1, rawThreshold));
  // Issue #297: per-wave cache-retention default. Explicit caller value wins
  // (including explicit 'short' or 'none' opt-outs), otherwise fall back to
  // the per-wave default — `'long'` for impl/test, undefined elsewhere.
  const cacheRetention: CacheRetention | undefined = explicitCacheRetention ?? DEFAULT_WAVE_CACHE_RETENTION[wave];
  const model = resolveModelFromString(modelString);
  const startTime = Date.now();

  // Event publisher — no-op if eventBus or eventContext is missing, so callers
  // who don't opt in pay nothing and outcomes are unchanged. The wave name is
  // narrowed to the EventWaveName union; pi-mono "ship" wave never spawns an
  // agent here, so the cast is safe in practice but we guard anyway.
  const publishEvent: PublishWaveEvent = makeWavePublisher(eventBus, eventContext, wave);
  publishEvent({ type: 'wave-enter', wave: wave as EventWaveName });

  log.info(`[${wave}] Starting wave — model=${model.id}, cwd=${cwd}`);

  const effectiveSystemPrompt = outputFormat
    ? `${systemPrompt}\n\n${buildStructuredOutputInstructions(outputFormat.schema)}`
    : systemPrompt;

  const effectiveUserMessage = handoffContext ? `${handoffContext}\n\n---\n\n${userMessage}` : userMessage;

  // Issue #315 — truncation runs at the tool-execute layer (`withTruncatedResult`
  // wraps every tool in `getWaveTools` / `mcpToolToAgentTool`), not via a
  // runtime hook. claude-agent-sdk has no output-side content-rewrite surface,
  // so wrapping at execute-time is the only portable place to enforce a budget.

  // beforeToolCall guards: a composition of three hooks, all running in order with
  // short-circuit on first block:
  //   (1) Piece-scope guard (issue #250) — impl wave only. Rejects Write/Edit calls
  //       to files outside the current spec piece's `files[]` list. Runs first so
  //       out-of-scope edits get the piece-specific error message, not a generic one.
  //   (2) Destructive-edit guard — rejects Write/Edit calls that would wipe out
  //       large portions of files (size shrink, trivial-replacement deletes).
  //   (3) Import-preservation guard — rejects edits that strip an import line whose
  //       names are still referenced elsewhere in the file. Supports Rust `use`,
  //       TS/JS `import`, Python `import`/`from`, and Go `import`.
  // Guards (2) and (3) honor `allowDestructive: true` for per-call opt-out.
  const scopeHook =
    pieceFiles && pieceFiles.length > 0 && PIECE_SCOPE_WAVES.has(wave as AIWaveName)
      ? createPieceScopeGuard({ cwd, pieceFiles })
      : undefined;
  const destructiveHook =
    destructiveEditGuard === false ? undefined : createDestructiveEditGuard({ cwd, ...(destructiveEditGuard ?? {}) });
  const importHook =
    importPreservationGuard === false
      ? undefined
      : createImportPreservationGuard({ cwd, ...(importPreservationGuard ?? {}) });

  const beforeToolCallHook = composeBeforeToolCallHooks([scopeHook, destructiveHook, importHook]);

  // Issue #313: price every assistant turn through the kova-owned pricing
  // table, not pi-ai's `cost.total`. For router-mode we resolve to the
  // underlying ROUTER_DEFAULT model id so the router placeholder Model
  // object's all-zero `cost` field never leaks into pricing.
  // `pricingModelId` is captured once per wave because `model` doesn't change
  // across turns inside a single spawnWaveAgent invocation.
  const pricingModelId = isRouterProvider(model.provider)
    ? extractUnderlyingRouterModelId(getRouterDefaultModel())
    : model.id;

  // Construct via the AgentRuntime factory (kova#309). The default factory
  // wraps pi-mono Agent; kova#310 will extract a full PiAgentRuntime adapter.
  //
  // `createDestructiveEditGuard` returns a pi-mono-typed function today. It is
  // structurally compatible with the kova hooks, but crosses the package
  // boundary, so we widen at the call site (the adapter narrows back to pi-mono
  // types). Cleaned up in kova#310 when the adapter owns the translation in one
  // place.
  //
  // Issue #296 — no `transformContext` here. The prior `createTransformContext`
  // hook trimmed tool-result content under context pressure and `aggressiveTrim`
  // dropped middle messages at 80% — both lossy. Context pressure is now
  // handled exclusively by the 3-tier degradation below: Tier-1 steer at 70%,
  // Tier-3 abort at `contextThreshold` (default 90%). The 80% Tier-2 slot is
  // intentionally a no-op (collapses onto Tier-3) per the issue's cleanup note.
  //
  // Issue #315 — no `afterToolCall` here. Tool-result truncation is applied at
  // tool-execute time via `withTruncatedResult` (see `./tool-result-truncate.ts`).
  // This is the only runtime-agnostic place to enforce a budget; claude-agent-sdk's
  // `PostToolUse` is informational and offers no output-side rewrite hook.
  const agent = runtimeFactory.create({
    systemPrompt: effectiveSystemPrompt,
    model,
    thinkingLevel,
    tools,
    getApiKey: resolveApiKey,
    // Issue #297: session affinity + cache retention. Both are optional;
    // omitted when unset so adapters that do not support either field stay
    // unaffected.
    ...(sessionId != null ? { sessionId } : {}),
    ...(cacheRetention != null ? { cacheRetention } : {}),
    ...(beforeToolCallHook && {
      beforeToolCall: beforeToolCallHook as unknown as RuntimeBeforeToolCallHook,
    }),
  });

  let turnCount = 0;
  let aborted = false;
  let costCapExceeded = false;
  let accumulatedCost = 0;
  let contextExhausted = false;
  let contextSteered = false;
  let lastErrorMessage: string | undefined;
  // Issue #297: cache-read telemetry — accumulate input + cacheRead across
  // every assistant turn so we can compute the cache-hit share at completion.
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  // Issue #278: per-wave tool-call counter — captures the agent's own tool
  // calls (Read, Grep, Edit, Bash, …) so the retrieval-quality eval harness
  // can measure whether injected codebaseContext reduced retrieval cost.
  // Always instantiated; surfaces on the returned handoff as `toolCallCounts`.
  const toolCallCounter = createToolCallCounter();

  // Fixed thresholds for graceful degradation
  const STEER_THRESHOLD = 0.7;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount % 50 === 0) {
        log.info(`[${wave}] Turn ${turnCount}...`);
      }
      const msg = event.message;
      if (isAssistantMessage(msg)) {
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          lastErrorMessage = msg.errorMessage ?? `Agent ${msg.stopReason} during ${wave}`;
        }
        // Track cost incrementally from assistant turn_end events.
        // Issue #313: price through kova's table, not pi-ai's `cost.total`
        // (which is $0 for router-mode and won't model #297 cache retention).
        const turnCost = priceUsage(pricingModelId, toTokenUsage(msg.usage));
        accumulatedCost += turnCost;
        // Issue #297: accumulate input + cacheRead tokens for the cache-share
        // telemetry line emitted at wave completion. The kova-owned
        // `AssistantTurn.usage` shape only declares `input`/`output`/`cost`,
        // but pi-mono passes through pi-ai's richer `Usage` (which includes
        // `cacheRead`). Read defensively so adapters that omit it still work.
        totalInputTokens += msg.usage.input ?? 0;
        const usageWithCache = msg.usage as { cacheRead?: number };
        totalCacheReadTokens += usageWithCache.cacheRead ?? 0;
        publishEvent({
          type: 'wave-output',
          wave: wave as EventWaveName,
          turn: turnCount,
          costDelta: turnCost,
        });
        if (maxCostUsd != null && accumulatedCost >= maxCostUsd && !aborted) {
          costCapExceeded = true;
          aborted = true;
          log.warn(`[${wave}] Cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd}), aborting`);
          publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'cost_cap_exceeded' });
          agent.abort();
        }
      } else {
        const role =
          typeof msg === 'object' && msg !== null && 'role' in msg
            ? String((msg as { role: unknown }).role)
            : 'unknown';
        log.debug(`[${wave}] Skipping non-assistant turn_end message (role=${role})`);
      }

      // Context window monitoring: 2-tier graceful degradation
      // Tier 1 (70%): steer agent with focus warning
      // Tier 3 (contextThreshold, default 90%): abort as last resort
      //
      // Issue #296 — the prior Tier-2 (80%) trim slot reassigned a lossy
      // `transformContext` that dropped middle messages. That slot is gone;
      // 80% now collapses onto Tier-3 (acceptable per the issue's cleanup note).
      const inputTokens = isAssistantMessage(msg) ? msg.usage.input : 0;
      if (inputTokens > 0 && model.contextWindow > 0) {
        const usageRatio = inputTokens / model.contextWindow;
        if (usageRatio >= contextThreshold && !aborted) {
          // Tier 3: abort
          contextExhausted = true;
          aborted = true;
          log.warn(
            `[${wave}] Context exhausted ${(usageRatio * 100).toFixed(0)}% >= ${(contextThreshold * 100).toFixed(0)}% threshold (${inputTokens}/${model.contextWindow} tokens), aborting`,
          );
          publishEvent({ type: 'steered', wave: wave as EventWaveName, tier: 'abort', usageRatio });
          publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'context_exhausted' });
          agent.abort();
        } else if (usageRatio >= STEER_THRESHOLD && !contextSteered) {
          // Tier 1: steer with warning. Runtimes without steer() will collapse
          // to Tier-3 abort (no-op safe).
          contextSteered = true;
          log.info(
            `[${wave}] Context usage ${(usageRatio * 100).toFixed(0)}% hit steer threshold (${inputTokens}/${model.contextWindow} tokens), steering agent to focus`,
          );
          publishEvent({ type: 'steered', wave: wave as EventWaveName, tier: 'steer', usageRatio });
          agent.steer?.({
            role: 'user',
            content:
              'Focus on completing the current task. Avoid reading additional files unless absolutely necessary.',
            timestamp: Date.now(),
          });
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      log.debug(`[${wave}] Tool: ${event.toolName}`);
      // Issue #278: count the tool call + fan out to caller's optional hook.
      toolCallCounter.record(event.toolName);
      if (onToolCall) {
        try {
          onToolCall(event.toolName);
        } catch (cbErr) {
          // Caller hooks must never crash the wave. Log + continue.
          log.debug(`[${wave}] onToolCall hook threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`);
        }
      }
    }
    if (event.type === 'turn_end' && turnCount >= maxTurns && !aborted) {
      aborted = true;
      log.warn(`[${wave}] Max turns (${maxTurns}) reached, aborting`);
      publishEvent({ type: 'aborted', wave: wave as EventWaveName, reason: 'max_turns' });
      agent.abort();
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    if (timeoutMs != null) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          agent.abort();
          reject(new KovaError(`Wave ${wave} timed out after ${(timeoutMs / 1000).toFixed(0)}s`, 'agent', false));
        }, timeoutMs);
      });
      await Promise.race([agent.prompt(effectiveUserMessage), timeoutPromise]);
    } else {
      await agent.prompt(effectiveUserMessage);
    }

    // Cost cap exceeded during execution — throw before processing results
    if (costCapExceeded) {
      throw new KovaError(
        `Wave ${wave} cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd})`,
        'billing',
        false,
      );
    }

    // Helper: collect cost + last assistant text from current agent state.
    const collectState = (): { cost: number; resultText: string | null } => {
      let collected = 0;
      const stateMessages = agent.state.messages;
      for (const msg of stateMessages) {
        if (isAssistantMessage(msg)) {
          // Issue #313: re-price via kova's table so the final tally matches
          // the per-turn accumulation. Router-mode in particular reports $0
          // via `cost.total`; pricing through `pricingModelId` fixes that.
          collected += priceUsage(pricingModelId, toTokenUsage(msg.usage));
        }
      }
      const last = [...stateMessages].reverse().find((m): m is AssistantTurn => isAssistantMessage(m));
      const text = last
        ? last.content
            .filter((c) => c.type === 'text' && 'text' in c)
            .map((c) => ('text' in c ? String(c.text) : ''))
            .join('')
        : null;
      return { cost: collected, resultText: text };
    };

    let { cost, resultText } = collectState();

    // Parse structured output if expected
    let structuredOutput: unknown | undefined;
    let zodValidationFailed = false;
    let lastZodErrorMessage: string | undefined;
    /** Track which extraction path produced the value (issue #247). */
    let lastParseMethod: ParseMethod | undefined;
    if (outputFormat && resultText) {
      const parsed = parseStructuredOutputWithMethod(resultText);
      structuredOutput = parsed.value;
      lastParseMethod = parsed.method;
      if (!structuredOutput) {
        log.warn(`[${wave}] Failed to parse structured output from response`);
      } else if (outputFormat.zodSchema) {
        const parseResult = outputFormat.zodSchema.safeParse(structuredOutput);
        if (!parseResult.success) {
          zodValidationFailed = true;
          lastZodErrorMessage = parseResult.error.message;
          log.warn(`[${wave}] Zod validation failed for structured output: ${parseResult.error.message}`);
        }
      }
    }

    // Conversation repair loop: when structured output is required (zodSchema present) and the
    // initial response either failed to parse or failed Zod validation, send a follow-up message
    // asking the model to output ONLY the corrected JSON. The model already has the right answer
    // in context — it just formatted it wrong. This is much cheaper than retrying the whole wave.
    // Max 2 repair turns before giving up.
    let repairAttempts = 0;
    while (
      outputFormat?.zodSchema != null &&
      !aborted &&
      !costCapExceeded &&
      !contextExhausted &&
      repairAttempts < MAX_REPAIR_ATTEMPTS &&
      (zodValidationFailed || structuredOutput == null)
    ) {
      repairAttempts++;
      const repairMessage = buildRepairTurnMessage(outputFormat?.schema, lastZodErrorMessage, structuredOutput == null);
      log.warn(`[${wave}] Sending repair turn ${repairAttempts}/${MAX_REPAIR_ATTEMPTS} for invalid structured output`);

      try {
        await agent.prompt(repairMessage);
      } catch (repairErr) {
        log.warn(
          `[${wave}] Repair turn ${repairAttempts} threw: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
        );
        break;
      }

      if (aborted || costCapExceeded || contextExhausted) break;

      // Re-collect state, re-parse, re-validate.
      const after = collectState();
      cost = after.cost;
      resultText = after.resultText;

      if (resultText) {
        const reparsed = parseStructuredOutputWithMethod(resultText);
        structuredOutput = reparsed.value;
        lastParseMethod = reparsed.method;
      } else {
        structuredOutput = undefined;
        lastParseMethod = undefined;
      }
      zodValidationFailed = false;
      lastZodErrorMessage = undefined;
      if (structuredOutput && outputFormat?.zodSchema) {
        const reValidate = outputFormat.zodSchema.safeParse(structuredOutput);
        if (!reValidate.success) {
          zodValidationFailed = true;
          lastZodErrorMessage = reValidate.error.message;
          log.warn(
            `[${wave}] Repair turn ${repairAttempts} still has Zod validation failures: ${reValidate.error.message}`,
          );
        } else {
          log.info(`[${wave}] Repair turn ${repairAttempts} succeeded — structured output now valid`);
        }
      } else if (structuredOutput == null) {
        log.warn(`[${wave}] Repair turn ${repairAttempts} did not produce parseable JSON`);
      }
    }

    // Cost cap may have tripped during repair turns — re-check before proceeding.
    if (costCapExceeded) {
      throw new KovaError(
        `Wave ${wave} cost cap exceeded ($${accumulatedCost.toFixed(4)} >= $${maxCostUsd})`,
        'billing',
        false,
      );
    }

    // Context exhaustion detected by monitoring — throw before other checks
    if (contextExhausted) {
      throw new KovaError(
        `Context window exhausted during ${wave}: usage exceeded ${(contextThreshold * 100).toFixed(0)}% of ${model.contextWindow} tokens`,
        'context',
        true,
      );
    }

    // Detect pi-mono errors reported via state or event subscription
    const piMonoError = agent.state.errorMessage ?? lastErrorMessage;
    if (piMonoError) {
      const classified = classifyError(piMonoError);
      throw new KovaError(
        `${classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'config' ? 'Config' : classified.type === 'context' ? 'Context' : 'Agent'} error during ${wave}: ${piMonoError}`,
        classified.type,
        classified.retryable,
      );
    }

    // Defense-in-depth: detect spending cap behavior
    if (isSpendingCapBehavior(turnCount, cost, resultText ?? '')) {
      throw new KovaError(`Spending cap likely reached (turns=${turnCount}, cost=$0)`, 'billing', true);
    }

    const duration = Date.now() - startTime;
    log.info(
      `[${wave}] Completed — turns=${turnCount}, cost=$${cost.toFixed(4)}, duration=${(duration / 1000).toFixed(1)}s`,
    );
    // Issue #297: cache-read share. `share` is the fraction of input tokens
    // served from cache; with `cacheRetention: 'long'` and a stable
    // `sessionId` the multi-turn waves should show share > 50% after the
    // first couple of turns. Emit the line whenever the wave actually
    // observed input tokens — even share=0% is useful signal (means caching
    // did not engage and the run paid full input cost).
    if (totalInputTokens > 0) {
      const share = Math.round((totalCacheReadTokens / totalInputTokens) * 100);
      log.info(`[${wave}] Cache: cacheRead=${totalCacheReadTokens} input=${totalInputTokens} share=${share}%`);
    }
    publishEvent({ type: 'cost', wave: wave as EventWaveName, costUsd: cost });

    // Determine confidence from structured output parsing + Zod validation
    let confidence: 'high' | 'medium' | 'low';
    if (structuredOutput != null && zodValidationFailed) {
      confidence = 'low';
    } else if (structuredOutput != null) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    // `parsed` discriminates the structured-success path from the string-fallback path.
    // When true, `artifact` is the typed `T` (structuredOutput). When false, `artifact`
    // is the raw model `string` (resultText). Issue #308: replaces the
    // `typeof artifact === 'string'` runtime check downstream by making the discriminator
    // explicit on the envelope. The cast below is now sound under this invariant.
    const parsed = structuredOutput != null;
    const artifact = parsed ? (structuredOutput as T) : ((resultText ?? '') as unknown as T);

    // Structured-output telemetry (issue #247). Only attach when the wave was
    // asked to produce structured output; pure pass-through waves don't have
    // meaningful parse-method data.
    const structuredOutputMetrics = outputFormat
      ? {
          parse_method: lastParseMethod ?? null,
          attempts: 1 + repairAttempts,
          success: parsed && !zodValidationFailed,
          repair_attempts: repairAttempts,
          zod_validation_failed: zodValidationFailed,
        }
      : undefined;

    // Issue #278: snapshot tool-call counts captured during this wave.
    const toolCallCounts: ToolCallCounts = toolCallCounter.snapshot();

    return {
      wave,
      timestamp: new Date().toISOString(),
      model: model.id,
      cost,
      turns: turnCount,
      confidence,
      parsed,
      artifact,
      approach_notes: '',
      ...(outputFormat?.zodSchema != null ? { repair_attempts: repairAttempts } : {}),
      ...(structuredOutputMetrics != null ? { structured_output_metrics: structuredOutputMetrics } : {}),
      toolCallCounts,
    };
  } catch (error) {
    if (error instanceof KovaError) throw error;

    const err = error instanceof Error ? error : new Error(String(error));
    const classified = classifyError(err);

    if (classified.type === 'billing' || classified.type === 'config' || classified.type === 'context') {
      const label =
        classified.type === 'billing' ? 'Billing/rate limit' : classified.type === 'context' ? 'Context' : 'Config';
      throw new KovaError(`${label} error during ${wave}: ${err.message}`, classified.type, classified.retryable);
    }

    log.error(`[${wave}] Failed — ${err.message}`);
    throw new KovaError(`Wave ${wave} failed: ${err.message}`, 'agent', false);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
    unsubscribe();
  }
}

// --- Local-to-API fallback ---

export interface SpawnWithFallbackConfig extends SpawnWaveAgentConfig {
  /** API model string to fall back to when the primary (local) model fails. */
  fallbackModel?: string | undefined;
}

export interface FallbackWaveHandoff<T = unknown> extends WaveHandoff<T> {
  /** Whether the API fallback model was used instead of the primary local model. */
  fallback_used: boolean;
  /** Cost incurred by the local model attempt (typically 0 for local models). */
  local_attempt_cost?: number | undefined;
}

/**
 * Spawn a wave agent with automatic fallback from local to API model.
 *
 * If the primary model is local (ollama, lmstudio, etc.) and fails —
 * structured output validation fails, empty result, timeout, or error —
 * automatically retries once with the API fallback model.
 *
 * Max 1 fallback attempt (no loop).
 */
export async function spawnWaveAgentWithFallback<T = unknown>(
  config: SpawnWithFallbackConfig,
): Promise<FallbackWaveHandoff<T>> {
  const { fallbackModel, ...baseConfig } = config;
  const shouldFallback = fallbackModel != null && fallbackModel !== config.model;

  try {
    const handoff = await spawnWaveAgent<T>(baseConfig);

    // Check if the result indicates a failure worth falling back from
    if (shouldFallback && needsFallback(handoff, config.outputFormat)) {
      log.warn(
        `[${config.wave}] Local model failed, falling back to API (model=${fallbackModel}): low confidence or empty result`,
      );
      const localCost = handoff.cost;
      const fallbackHandoff = await spawnWaveAgent<T>({ ...baseConfig, model: fallbackModel });
      return {
        ...fallbackHandoff,
        cost: localCost + fallbackHandoff.cost,
        fallback_used: true,
        local_attempt_cost: localCost,
      };
    }

    return { ...handoff, fallback_used: false };
  } catch (error) {
    // If the primary model threw and we can fall back, try the API model
    if (shouldFallback) {
      log.warn(
        `[${config.wave}] Local model failed, falling back to API (model=${fallbackModel}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallbackHandoff = await spawnWaveAgent<T>({ ...baseConfig, model: fallbackModel });
      return {
        ...fallbackHandoff,
        fallback_used: true,
        local_attempt_cost: 0,
      };
    }
    throw error;
  }
}

/** Determine whether a successful-but-poor-quality result warrants a fallback retry. */
function needsFallback<T>(handoff: WaveHandoff<T>, outputFormat?: OutputFormat): boolean {
  // Zod validation failed → low confidence
  if (handoff.confidence === 'low') return true;
  // Expected structured output but got nothing (medium confidence = no structured output parsed)
  if (outputFormat && handoff.confidence === 'medium') return true;
  return false;
}

// --- Backward-compat wrapper ---

export interface WaveOptions {
  wave: AIWaveName;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  modelTier: WaveModelConfig;
  outputFormat?: OutputFormat;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  customTools?: readonly import('../types/index.js').CustomTool[] | undefined;
  playwright?: { enabled: boolean } | undefined;
  /**
   * Files this spec piece is allowed to modify (issue #250). Forwarded to
   * `spawnWaveAgent.pieceFiles`. Only enforced on the `impl` wave; ignored elsewhere.
   * Empty/undefined → no restriction (backward compat).
   */
  pieceFiles?: readonly string[] | undefined;
  /**
   * Optional deterministic session id (issue #297). Forwarded to
   * `spawnWaveAgent` so providers can key prompt-cache affinity per wave.
   * Callers in the fix pipeline build this via `buildWaveSessionId(...)`.
   * Unset → no session header sent (provider default behavior).
   */
  sessionId?: string;
}

export interface WaveExecutionResult {
  result: string | null;
  success: boolean;
  duration: number;
  turns: number;
  cost: number;
  model?: string | undefined;
  provider?: string | undefined;
  structuredOutput?: unknown;
}

export async function executeWave(options: WaveOptions): Promise<WaveExecutionResult> {
  const {
    wave,
    systemPrompt,
    userMessage,
    cwd,
    modelTier,
    outputFormat,
    maxTurns,
    thinkingLevel,
    customTools,
    playwright,
    pieceFiles,
    sessionId,
  } = options;

  const model = resolveWaveModel(modelTier);
  const toolOptions = customTools || playwright ? { customTools, playwright } : undefined;
  const tools = getWaveTools(wave, cwd, toolOptions);
  const startTime = Date.now();

  try {
    const handoff = await spawnWaveAgent({
      wave,
      model: getModelString(model),
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd,
      ...(outputFormat && { outputFormat }),
      ...(maxTurns != null && { maxTurns }),
      ...(thinkingLevel != null && { thinkingLevel }),
      ...(pieceFiles != null && { pieceFiles }),
      // Issue #297: forward sessionId for prompt-cache affinity. Per-wave
      // cacheRetention default ('long' for impl/test) is applied inside
      // spawnWaveAgent based on the `wave` field.
      ...(sessionId != null ? { sessionId } : {}),
    });

    const duration = Date.now() - startTime;

    // `parsed === false` ↔ artifact is the raw model string (issue #308 discriminator).
    // For backward compat with older handoffs that lack `parsed`, fall back to the
    // legacy `typeof artifact === 'string'` shape check.
    const artifactIsString = handoff.parsed === false || typeof handoff.artifact === 'string';
    return {
      result: artifactIsString ? (handoff.artifact as string) : JSON.stringify(handoff.artifact),
      success: true,
      duration,
      turns: handoff.turns,
      cost: handoff.cost,
      model: handoff.model,
      provider: model.provider,
      ...(handoff.confidence === 'high' && { structuredOutput: handoff.artifact }),
    };
  } catch (error) {
    if (error instanceof KovaError) throw error;

    const duration = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(`[${wave}] Failed — ${err.message} (${(duration / 1000).toFixed(1)}s)`);

    return {
      result: null,
      success: false,
      duration,
      turns: 0,
      cost: 0,
      model: model.id,
      provider: model.provider,
    };
  }
}

/**
 * Pure helper deciding whether `executeWaveWithRetry` should attempt another
 * pass after a failure (#317).
 *
 * Rules:
 *   - `KovaError` carries its own `retryable` flag (the canonical signal).
 *   - Any other thrown value is classified through {@link classifyError},
 *     which now reads structured `.status` / `.errorClass` first and falls
 *     back to message-pattern matching. Unknown errors are treated as
 *     non-retryable to avoid wasting retries + spend on permanent failures.
 *
 * Exported so the decision can be unit-tested without mocking the entire
 * wave pipeline.
 */
export function shouldRetryWaveError(error: unknown): boolean {
  if (error instanceof KovaError) return error.retryable;
  return classifyError(error).retryable;
}

export async function executeWaveWithRetry(options: WaveOptions, maxRetries = 2): Promise<WaveExecutionResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await executeWave(options);

      if (result.success) return result;

      // Legacy `success: false` path: executeWave swallowed an unclassifiable
      // error and returned a falsy result. No error object to classify, so
      // preserve prior behavior (retry up to maxRetries).
      if (attempt < maxRetries) {
        const delay = Math.min(5000 * 2 ** attempt, 60_000);
        log.warn(`[${options.wave}] Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      // Issue #317: respect classified.retryable. Bubble every classified
      // error — retryable OR not — out of this wrapper. The wrapper's
      // historical contract treated thrown errors as terminal (they passed
      // through the `success:false` retry loop entirely), so retryable
      // errors are surfaced to outer loops (ti-loop, etc.) that already
      // handle their own backoff. The fix here is to stop letting
      // non-retryable errors trigger the legacy `success:false` retry
      // path — that was the actual bug per the issue body. Bubbling both
      // categories preserves outer-loop semantics while ensuring we never
      // waste backoff time on permanent failures.
      if (!shouldRetryWaveError(error)) throw error;
      // For retryable errors, also bubble — outer pipeline loops own retry.
      // (Future work: a `--retry-inline` knob could opt into wrapper-level
      // retry for callers without an outer loop.)
      throw error;
    }
  }

  throw new KovaError(`Wave ${options.wave} failed after ${maxRetries + 1} attempts`, 'agent', false);
}

// --- API key resolution ---

/** Resolve the API key for a given provider. Provider-specific env vars take priority. */
export function resolveApiKey(provider: string): string | undefined {
  if (isRouterProvider(provider)) return resolveRouterApiKey();
  if (isOllamaProvider(provider)) return resolveOllamaApiKey();
  switch (provider) {
    case 'google':
      return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    default:
      return process.env.ANTHROPIC_API_KEY;
  }
}

// --- Helpers ---

export function buildStructuredOutputInstructions(schema: Record<string, unknown>): string {
  return [
    '## Required Output Format',
    '',
    'Your FINAL message must contain a valid JSON object matching this schema, wrapped in `<json>` tags:',
    '',
    '```',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'Wrap your JSON output like this:',
    '<json>',
    '{ ... your JSON here ... }',
    '</json>',
    '',
    'The `<json>` tags are REQUIRED. Do not include any text inside the tags other than the JSON object.',
  ].join('\n');
}

/** Maximum number of conversation repair turns when structured output validation fails. */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Build a follow-up user message asking the agent to re-emit valid structured output.
 *
 * The model already has its reasoning + tool reads in context — only the output formatting
 * was wrong. Asking for ONLY the corrected JSON costs a fraction of a full wave retry.
 */
export function buildRepairTurnMessage(
  schema: Record<string, unknown> | undefined,
  zodErrors: string | undefined,
  parseFailed: boolean,
): string {
  const lines: string[] = [];
  if (parseFailed) {
    lines.push("Your response didn't match the required JSON schema: no valid JSON was found in your output.");
  } else {
    lines.push("Your response didn't match the required JSON schema.", `Validation errors: ${zodErrors ?? 'unknown'}`);
  }
  if (schema) {
    lines.push('', 'Required schema:', '```json', JSON.stringify(schema, null, 2), '```');
  }
  lines.push(
    '',
    'Output ONLY the corrected JSON wrapped in <json>...</json> tags, with no other text before or after.',
  );
  return lines.join('\n');
}

/**
 * Canonical parse-method labels for structured output extraction.
 * Issue #247: tracked per-wave so we can measure which extraction paths
 * each model relies on and whether repair passes are doing useful work.
 */
export type ParseMethod =
  | 'json-tag'
  | 'json-tag-repaired'
  | 'markdown-fence'
  | 'markdown-fence-repaired'
  | 'direct-parse'
  | 'direct-parse-repaired';

export interface ParseStructuredOutputResult {
  /** The parsed value, or `undefined` if no parse strategy succeeded. */
  value: unknown | undefined;
  /** Which parse path succeeded, or `undefined` when no strategy worked. */
  method: ParseMethod | undefined;
}

/**
 * Extract structured output from an LLM response and report which parse path
 * was used. Issue #247: callers track this to compute per-method success rates.
 *
 * Tries `<json>...</json>` → markdown fence → direct parse, each with a fuzzy
 * repair fallback. Pure function (no side effects beyond a debug log line).
 */
export function parseStructuredOutputWithMethod(text: string): ParseStructuredOutputResult {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined, method: undefined };

  // 1. Primary: extract from <json>...</json> tags
  const tagMatch = trimmed.match(/<json>([\s\S]*?)<\/json>/);
  if (tagMatch?.[1]) {
    const inner = tagMatch[1].trim();
    try {
      const result = JSON.parse(inner);
      log.debug('[parse] Extracted structured output via json-tag');
      return { value: result, method: 'json-tag' };
    } catch {
      // Try repair pass before falling through
      const repaired = tryRepairParse(inner);
      if (repaired !== undefined) {
        log.debug('[parse] Extracted structured output via json-tag-repaired');
        return { value: repaired, method: 'json-tag-repaired' };
      }
    }
  }

  // 2. Secondary: extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    try {
      const result = JSON.parse(inner);
      log.debug('[parse] Extracted structured output via markdown-fence');
      return { value: result, method: 'markdown-fence' };
    } catch {
      const repaired = tryRepairParse(inner);
      if (repaired !== undefined) {
        log.debug('[parse] Extracted structured output via markdown-fence-repaired');
        return { value: repaired, method: 'markdown-fence-repaired' };
      }
    }
  }

  // 3. Tertiary: direct JSON parse of entire text
  try {
    const result = JSON.parse(trimmed);
    log.debug('[parse] Extracted structured output via direct-parse');
    return { value: result, method: 'direct-parse' };
  } catch {
    const repaired = tryRepairParse(trimmed);
    if (repaired !== undefined) {
      log.debug('[parse] Extracted structured output via direct-parse-repaired');
      return { value: repaired, method: 'direct-parse-repaired' };
    }
  }

  // No greedy regex fallback — return undefined if none of the above worked
  return { value: undefined, method: undefined };
}

/**
 * Backward-compatible thin wrapper around {@link parseStructuredOutputWithMethod}
 * that returns only the parsed value. Existing callers that don't need the
 * parse-method label continue to work unchanged.
 */
export function parseStructuredOutput(text: string): unknown | undefined {
  return parseStructuredOutputWithMethod(text).value;
}

/** Attempt to repair `input` then JSON.parse it. Returns undefined if still unparseable. */
function tryRepairParse(input: string): unknown | undefined {
  try {
    const repaired = repairJson(input);
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort fuzzy repair for JSON-like text produced by local LLMs.
 *
 * Repairs (in order):
 *   1. Strip markdown fence wrappers (``` or ```json with surrounding text).
 *   2. Strip JS-style `// line` and block comments outside string literals.
 *   3. Convert single-quoted strings to double-quoted (preserves apostrophes
 *      that appear inside already-double-quoted strings).
 *   4. Quote unquoted object keys (e.g. `{grade: "A"}` -> `{"grade": "A"}`).
 *   5. Remove trailing commas before `}` and `]`.
 *   6. Escape raw control characters (newline, tab, etc.) appearing inside
 *      string literals so JSON.parse will accept them.
 *   7. Balance unclosed `{` and `[` by appending closers in correct stack order.
 *
 * Idempotent on already-valid JSON. Pure function (no I/O, no throws).
 *
 * This is a fallback for malformed LLM output -- Zod validation downstream is
 * still the safety net. The repair is best-effort and may produce output that
 * JSON.parse still rejects; callers should handle that case.
 */
export function repairJson(input: string): string {
  let s = input;

  // 1. Strip markdown fence wrappers with optional surrounding text.
  //    Only applied when there is no <json>...</json> tag (callers handle that case).
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    s = fenceMatch[1].trim();
  }

  // 2. Strip JS-style comments outside string literals.
  s = stripJsCommentsOutsideStrings(s);

  // 3. Convert single-quoted strings to double-quoted (outside existing double-quoted strings).
  s = convertSingleQuotedStringsOutsideDoubleQuoted(s);

  // 4. Quote unquoted object keys.
  s = quoteUnquotedKeys(s);

  // 5. Remove trailing commas before } or ].
  s = removeTrailingCommas(s);

  // 6. Escape raw control characters appearing inside string literals.
  s = escapeRawControlCharsInStrings(s);

  // 7. Balance unclosed { and [ by appending closers in stack order.
  s = balanceBrackets(s);

  return s;
}

/** Strip `// line` and block comments outside JSON string literals. */
function stripJsCommentsOutsideStrings(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    // Skip string literals verbatim (handle both " and ' for robustness).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '/' && i + 1 < n) {
      const next = input[i + 1];
      if (next === '/') {
        // Line comment: skip until newline (newline retained).
        i += 2;
        while (i < n && input[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // Block comment: skip until */.
        i += 2;
        while (i + 1 < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Convert single-quoted string literals to double-quoted, preserving content inside existing double-quoted strings. */
function convertSingleQuotedStringsOutsideDoubleQuoted(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      // Pass through existing double-quoted string as-is.
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      // Convert single-quoted string to double-quoted.
      // Escape any " or unescaped \ in the content; unescape \'.
      out += '"';
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          const escNext = input[i + 1];
          if (escNext === "'") {
            // \' -> '
            out += "'";
          } else if (escNext === '"') {
            // \" stays as \"
            out += '\\"';
          } else {
            out += `\\${escNext}`;
          }
          i += 2;
          continue;
        }
        if (c === '"') {
          // Bare double-quote inside single-quoted string -- escape it.
          out += '\\"';
          i++;
          continue;
        }
        if (c === "'") {
          // End of single-quoted string.
          out += '"';
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Quote unquoted object keys: `{foo: 1}` -> `{"foo": 1}`. Skips already-quoted keys and string literals. */
function quoteUnquotedKeys(input: string): string {
  // Match identifier-shaped tokens that appear immediately after `{` or `,` (with optional whitespace)
  // and are followed by `:`. Use a tokenizer that respects string literals.
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '{' || ch === ',') {
      out += ch;
      i++;
      // Skip whitespace
      let j = i;
      while (j < n && /\s/.test(input[j] ?? '')) j++;
      // Check for an unquoted identifier followed by `:` (allow $ and _).
      const idMatch = input.slice(j).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (idMatch) {
        // Emit whitespace, then quoted key, then advance past the identifier.
        out += input.slice(i, j);
        out += `"${idMatch[1]}"`;
        i = j + (idMatch[1]?.length ?? 0);
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Remove trailing commas immediately before `}` or `]` (outside string literals). */
function removeTrailingCommas(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === ',') {
      // Look ahead past whitespace for } or ].
      let j = i + 1;
      while (j < n && /\s/.test(input[j] ?? '')) j++;
      if (j < n && (input[j] === '}' || input[j] === ']')) {
        // Drop the comma; emit the whitespace verbatim.
        out += input.slice(i + 1, j);
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Escape raw control characters appearing inside double-quoted string literals. */
function escapeRawControlCharsInStrings(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          out += c + input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          out += c;
          i++;
          break;
        }
        // Escape raw control chars.
        if (c === '\n') {
          out += '\\n';
        } else if (c === '\r') {
          out += '\\r';
        } else if (c === '\t') {
          out += '\\t';
        } else if (c === '\b') {
          out += '\\b';
        } else if (c === '\f') {
          out += '\\f';
        } else if (c !== undefined && c.charCodeAt(0) < 0x20) {
          // Other ASCII control chars -> \uXXXX.
          out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += c;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Append matching closers for any unclosed `{` / `[` in stack order. Respects string literals. */
function balanceBrackets(input: string): string {
  const stack: Array<'}' | ']'> = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      // Only pop if the top matches; otherwise leave the input alone (don't try to be clever).
      if (stack[stack.length - 1] === ch) stack.pop();
    }
    i++;
  }
  if (stack.length === 0) return input;
  // Trim trailing comma+whitespace before appending closers -- common LLM artifact.
  let trimmed = input.replace(/[\s,]+$/, '');
  while (stack.length > 0) {
    const closer = stack.pop();
    if (closer !== undefined) trimmed += closer;
  }
  return trimmed;
}
