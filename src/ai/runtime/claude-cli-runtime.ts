/**
 * ClaudeCliRuntime — alternate `AgentRuntime` backed by the `claude -p` CLI
 * subprocess. Issue kova#318.
 *
 * For users on Anthropic's Max plan, running waves through the `claude` CLI
 * subprocess consumes their paid subscription rather than stacking per-token
 * API spend on top. It also unlocks `--resume <sessionId>` for cross-wave
 * cache reuse (relates to kova#297).
 *
 * Wire shape:
 *   claude -p --output-format stream-json --verbose
 *     --append-system-prompt '<systemPrompt>'
 *     [--allowed-tools <comma list>]
 *     [--mcp-config <temp path>]
 *     [--resume <sessionId>]
 *
 * The user message is piped to the child's stdin (avoids argv length limits
 * and shell-escaping concerns). NDJSON stream-json events come back on
 * stdout; this runtime parses them, validates with Zod (unknown event types
 * are logged + dropped), and surfaces:
 *
 *   - `RuntimeEvent { type: 'turn_end', message: AssistantTurn }` per
 *     assistant event
 *   - `RuntimeEvent { type: 'tool_execution_start', toolName }` per
 *     `tool_use` content block inside an assistant event
 *   - `state.messages` — kova-owned `AgentMessage[]` rebuilt from assistant +
 *     user events
 *   - `state.errorMessage` — set on non-zero exit or `result.is_error: true`
 *   - `state.sessionId` — captured from the `system` init event (kova
 *     extension; not part of the AgentRuntime interface)
 *
 * Cost is computed via `priceUsage` from `../pricing.ts` (kova-owned table)
 * rather than trusting any provider-reported `cost.total` — the same call
 * PiAgentRuntime makes after kova#NEW-07. The `result` event's
 * `total_cost_usd` is reconciled against the cumulative per-turn estimate;
 * a `console.warn` fires when drift exceeds 5%.
 *
 * The claude CLI does NOT accept caller-provided tool implementations, so
 * the `tools: AgentTool[]` field is read only for its `.name`s, which become
 * the `--allowed-tools` allowlist. In-process tool implementations remain
 * pi-mono-only.
 *
 * NOTE: this file is the only runtime adapter that talks to the claude CLI.
 * Wiring from the kova CLI flag (`--runtime <pi|claude-cli>`) and
 * `repos.yaml runtime:` field through `fix`/`auto`/`loop`/`brainstorm`/
 * `supervised` into `spawnWaveAgentConfig.runtimeFactory` lands as a
 * follow-up (mechanical glue once this primitive exists).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from '../../utils/logger.js';
import { cacheRetentionToPricingTtl, priceUsage, type TokenUsage } from '../pricing.js';
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeFactory,
  AssistantTurn,
  RuntimeContent,
  RuntimeEvent,
  ToolResultMessage,
  UserMessage,
} from './types.js';

// ─── Stream-json event schemas ──────────────────────────────────────────────
// The shape comes from the public Claude Code documentation for
// `--output-format stream-json`. We validate only the fields the runtime
// actually reads — extra fields pass through (.passthrough()) so a server-
// side schema bump doesn't reject otherwise-valid events.

const StreamJsonUsage = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const StreamJsonTextBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();

const StreamJsonToolUseBlock = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const StreamJsonThinkingBlock = z
  .object({ type: z.literal('thinking'), thinking: z.string().optional(), text: z.string().optional() })
  .passthrough();

const StreamJsonToolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const StreamJsonAssistantContent = z.discriminatedUnion('type', [
  StreamJsonTextBlock,
  StreamJsonToolUseBlock,
  StreamJsonThinkingBlock,
]);

const StreamJsonSystemEvent = z
  .object({
    type: z.literal('system'),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

const StreamJsonAssistantEvent = z
  .object({
    type: z.literal('assistant'),
    session_id: z.string().optional(),
    message: z
      .object({
        role: z.literal('assistant'),
        content: z.array(StreamJsonAssistantContent),
        stop_reason: z.string().nullable().optional(),
        model: z.string().optional(),
        usage: StreamJsonUsage.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const StreamJsonUserEvent = z
  .object({
    type: z.literal('user'),
    session_id: z.string().optional(),
    message: z
      .object({
        role: z.literal('user'),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
      .passthrough(),
  })
  .passthrough();

const StreamJsonResultEvent = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    total_cost_usd: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

/** Discriminated union of recognized stream-json events. Anything that
 *  doesn't match falls through to the "unknown event" debug-log path. */
const StreamJsonEvent = z.discriminatedUnion('type', [
  StreamJsonSystemEvent,
  StreamJsonAssistantEvent,
  StreamJsonUserEvent,
  StreamJsonResultEvent,
]);

type StreamJsonEvent = z.infer<typeof StreamJsonEvent>;

// ─── Stop-reason translation ────────────────────────────────────────────────
// Claude API emits `end_turn` | `max_tokens` | `stop_sequence` | `tool_use`.
// Kova's AssistantTurn surface is `end_turn` | `max_turns` | `tool_use` |
// `aborted` | `error`. Map the API values onto kova's, defaulting to
// `end_turn` for anything we don't recognize so callers don't have to
// special-case nulls.

function translateStopReason(api: string | null | undefined): AssistantTurn['stopReason'] {
  switch (api) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_turns';
    case 'end_turn':
    case 'stop_sequence':
    case null:
    case undefined:
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

// ─── NDJSON parser ───────────────────────────────────────────────────────────
// `claude` streams events one-per-line on stdout. The parser maintains a
// rolling buffer; once a `\n` arrives it splits, validates each line with
// Zod, and routes the result. Lines that fail Zod or aren't valid JSON
// are logged via `log.debug` and skipped — never thrown.

interface NdjsonParser {
  push(chunk: string): StreamJsonEvent[];
  flush(): StreamJsonEvent[];
}

function createNdjsonParser(onUnknown: (raw: string, reason: string) => void): NdjsonParser {
  let buffer = '';
  function parseLine(line: string): StreamJsonEvent | undefined {
    const trimmed = line.trim();
    if (trimmed === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      onUnknown(trimmed, `json parse error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const validated = StreamJsonEvent.safeParse(parsed);
    if (!validated.success) {
      onUnknown(trimmed, `zod validation failed: ${validated.error.message}`);
      return undefined;
    }
    return validated.data;
  }
  return {
    push(chunk: string): StreamJsonEvent[] {
      buffer += chunk;
      const events: StreamJsonEvent[] = [];
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const ev = parseLine(line);
        if (ev) events.push(ev);
      }
      return events;
    },
    flush(): StreamJsonEvent[] {
      if (buffer.length === 0) return [];
      const line = buffer;
      buffer = '';
      const ev = parseLine(line);
      return ev ? [ev] : [];
    },
  };
}

// ─── Argv builder ────────────────────────────────────────────────────────────

interface BuildArgvInput {
  systemPrompt: string;
  toolNames: readonly string[];
  mcpConfigPath: string | undefined;
  sessionId: string | undefined;
}

function buildArgv(input: BuildArgvInput): string[] {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--append-system-prompt', input.systemPrompt);
  if (input.toolNames.length > 0) {
    args.push('--allowed-tools', input.toolNames.join(','));
  }
  if (input.mcpConfigPath != null) {
    args.push('--mcp-config', input.mcpConfigPath);
  }
  if (input.sessionId != null) {
    args.push('--resume', input.sessionId);
  }
  return args;
}

// ─── MCP config bridge ───────────────────────────────────────────────────────
// kova owns the MCP server config (loaded from ~/.claude/settings.json + per-
// repo overrides in `src/ai/mcp.ts`). The claude CLI accepts the same shape
// via `--mcp-config <path>` to a JSON file with a top-level `mcpServers`
// object. We write a temp file per-invocation and clean it up on session end.

interface McpServersMap {
  [name: string]: { command: string; args?: string[]; env?: Record<string, string> };
}

function writeMcpConfigFile(mcpServers: McpServersMap): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kova-claude-cli-mcp-'));
  const path = join(dir, 'mcp-config.json');
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.debug(`[claude-cli] mcp temp cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Cost reconciliation ─────────────────────────────────────────────────────
// per-turn estimate vs `result.total_cost_usd`. Warn once on >5% drift.

const DRIFT_THRESHOLD = 0.05;

function reconcileCost(cumulativeEstimate: number, providerTotal: number | undefined): void {
  if (providerTotal == null) return;
  // `total_cost_usd === 0` is the documented signal that the run was billed
  // against the user's subscription (Max plan) rather than the per-token API
  // tier — there is nothing to reconcile against in that case. Skip silently
  // so the kova-owned estimate remains the source of truth without surfacing
  // a spurious 100% drift warning every wave.
  if (providerTotal === 0) return;
  const drift = Math.abs(providerTotal - cumulativeEstimate) / providerTotal;
  if (drift > DRIFT_THRESHOLD) {
    console.warn(
      `[claude-cli] cost drift: cumulative per-turn estimate $${cumulativeEstimate.toFixed(4)} vs provider total $${providerTotal.toFixed(4)} (drift ${(drift * 100).toFixed(1)}% > ${DRIFT_THRESHOLD * 100}%); reconciliation may be off`,
    );
  }
}

// ─── Content translation: stream-json → kova RuntimeContent ─────────────────

function translateAssistantContent(blocks: z.infer<typeof StreamJsonAssistantContent>[]): RuntimeContent[] {
  return blocks.map((block): RuntimeContent => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'thinking': {
        const text = block.thinking ?? block.text ?? '';
        return { type: 'thinking', text };
      }
      default:
        // Discriminated union ensures this is unreachable, but kept for safety.
        return { type: 'text', text: '' };
    }
  });
}

// ─── Extended config + state ─────────────────────────────────────────────────
// The kova interface (`AgentRuntimeConfig`) doesn't carry `cwd` or
// `mcpServers` today — those are claude-cli-specific. We accept them as
// additional fields on top of `AgentRuntimeConfig`; PiAgentRuntime ignores
// them. Plumbing them through the kova interface itself is out-of-scope for
// this issue.

export interface ClaudeCliRuntimeConfig extends AgentRuntimeConfig {
  /** Working directory for the spawned child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** MCP server map; written to a temp file and passed via --mcp-config. */
  mcpServers?: McpServersMap;
  /** Path to the `claude` binary. Defaults to `'claude'` (relies on PATH). */
  claudeBinary?: string;
  /** Grace period (ms) between SIGTERM and SIGKILL on abort. Default 5_000. */
  abortGraceMs?: number;
}

/** Extended runtime state — `sessionId` is kova-owned, not part of the
 *  AgentRuntime interface. Callers wanting to thread it into a follow-up
 *  wave (`--resume`) can read it off this field. */
interface ClaudeCliRuntimeState {
  messages: AgentMessage[];
  errorMessage?: string;
  sessionId?: string;
}

// ─── Runtime implementation ──────────────────────────────────────────────────

function createClaudeCliRuntime(config: ClaudeCliRuntimeConfig): AgentRuntime {
  const cwd = config.cwd ?? process.cwd();
  const claudeBinary = config.claudeBinary ?? 'claude';
  const abortGraceMs = config.abortGraceMs ?? 5_000;

  // Extract tool allowlist names. The claude CLI ignores caller-provided
  // tool implementations; we only forward the `.name`s.
  const toolNames: string[] = [];
  for (const t of config.tools as Array<{ name?: unknown }>) {
    if (t != null && typeof t === 'object' && typeof t.name === 'string') {
      toolNames.push(t.name);
    }
  }

  const state: ClaudeCliRuntimeState = { messages: [] };
  const listeners: Array<(event: RuntimeEvent) => void> = [];

  function emit(event: RuntimeEvent): void {
    // Snapshot the listener list so unsubscribe-during-emit is safe.
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch (err) {
        log.debug(`[claude-cli] listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  let child: ChildProcess | undefined;
  let abortRequested = false;
  let mcpCleanup: (() => void) | undefined;
  let cumulativeEstimate = 0;
  // Cache the resolved model id for pricing — passed through from config so
  // the same call PiAgentRuntime makes post-NEW-07 lives on the kova-owned
  // side.
  const modelForPricing = (() => {
    const m = config.model as { id?: unknown; provider?: unknown };
    if (m && typeof m.id === 'string') return m.id;
    return 'claude-sonnet-4-6';
  })();

  // Issue #416: also forward `cacheRetention` to `priceUsage` so cacheWrite
  // tokens on long-retention waves (impl/test) bill at the 1h rate instead
  // of silently defaulting to 5m. Mirrors the wave-executor projector path
  // closed by #390. `wave-executor.ts` already threads the resolved retention
  // through `runtimeFactory.create({ ...cacheRetention })`, so we just read
  // it off `config` and map onto the pricing axis via the shared helper from
  // pricing.ts (the helper lives there to avoid a wave-executor → runtime →
  // wave-executor import cycle).
  const pricingCacheRetention = cacheRetentionToPricingTtl(config.cacheRetention);

  function priceTurn(usage: z.infer<typeof StreamJsonUsage> | undefined): {
    cost: number;
    input: number;
    output: number;
  } {
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
    const tokenUsage: TokenUsage = {
      input: inputTokens,
      output: outputTokens,
      cacheRead,
      cacheWrite,
      ...(pricingCacheRetention != null ? { cacheRetention: pricingCacheRetention } : {}),
    };
    const cost = priceUsage(modelForPricing, tokenUsage);
    return { cost, input: inputTokens, output: outputTokens };
  }

  function handleEvent(ev: StreamJsonEvent): void {
    switch (ev.type) {
      case 'system': {
        if (ev.session_id != null) {
          state.sessionId = ev.session_id;
        }
        return;
      }
      case 'assistant': {
        const content = translateAssistantContent(ev.message.content);
        const { cost, input, output } = priceTurn(ev.message.usage);
        cumulativeEstimate += cost;
        const turn: AssistantTurn = {
          role: 'assistant',
          content,
          usage: { input, output, cost: { total: cost } },
          stopReason: translateStopReason(ev.message.stop_reason),
          timestamp: Date.now(),
        };
        state.messages.push(turn);
        // Emit `tool_execution_start` per tool_use block — keeps parity with
        // pi-mono's event surface so wave-executor's counters tick.
        for (const block of content) {
          if (block.type === 'tool_use') {
            emit({ type: 'tool_execution_start', toolName: block.name });
          }
        }
        emit({ type: 'turn_end', message: turn });
        return;
      }
      case 'user': {
        // The claude CLI emits `user` events for tool results during a tool-use
        // loop. The kova-owned shape for this is `ToolResultMessage`. If the
        // payload contains a tool_result block, translate to one entry per
        // tool_result; otherwise record a generic UserMessage.
        const msgContent = ev.message.content;
        if (typeof msgContent === 'string') {
          const m: UserMessage = { role: 'user', content: msgContent, timestamp: Date.now() };
          state.messages.push(m);
          return;
        }
        let extracted = 0;
        for (const block of msgContent) {
          const parsedBlock = StreamJsonToolResultBlock.safeParse(block);
          if (parsedBlock.success) {
            const b = parsedBlock.data;
            const textContent =
              typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .filter((c): c is { type: 'text'; text: string } => {
                        if (c == null || typeof c !== 'object') return false;
                        const obj = c as { type?: unknown; text?: unknown };
                        return obj.type === 'text' && typeof obj.text === 'string';
                      })
                      .map((c) => c.text)
                      .join('')
                  : '';
            const tr: ToolResultMessage = {
              role: 'tool_result',
              toolCallId: b.tool_use_id,
              content: textContent,
              ...(b.is_error === true ? { isError: true } : {}),
              timestamp: Date.now(),
            };
            state.messages.push(tr);
            extracted++;
          }
        }
        if (extracted === 0) {
          // Fall back to a generic user message for the non-tool-result path.
          state.messages.push({
            role: 'user',
            content: 'user message (non-tool-result content omitted)',
            timestamp: Date.now(),
          });
        }
        return;
      }
      case 'result': {
        if (ev.is_error === true) {
          state.errorMessage = ev.result ?? 'claude-cli reported is_error=true';
        }
        reconcileCost(cumulativeEstimate, ev.total_cost_usd);
        return;
      }
    }
  }

  // The single in-flight prompt promise — only one prompt runs at a time.
  let activePrompt: { resolve: () => void; reject: (err: Error) => void } | undefined;

  function settleSuccess(): void {
    if (activePrompt) {
      const p = activePrompt;
      activePrompt = undefined;
      p.resolve();
    }
  }

  function settleFailure(err: Error): void {
    if (activePrompt) {
      const p = activePrompt;
      activePrompt = undefined;
      p.reject(err);
    }
  }

  async function promptImpl(userMessage: string): Promise<void> {
    if (child != null) {
      throw new Error('claude-cli runtime: prompt() already in flight');
    }
    abortRequested = false;
    cumulativeEstimate = 0;
    delete state.errorMessage;

    // Build MCP config temp file if servers were provided.
    let mcpConfigPath: string | undefined;
    if (config.mcpServers != null && Object.keys(config.mcpServers).length > 0) {
      const written = writeMcpConfigFile(config.mcpServers);
      mcpConfigPath = written.path;
      mcpCleanup = written.cleanup;
    }

    const argv = buildArgv({
      systemPrompt: config.systemPrompt,
      toolNames,
      mcpConfigPath,
      sessionId: config.sessionId,
    });

    log.debug(`[claude-cli] spawn ${claudeBinary} ${argv.join(' ')} (cwd=${cwd})`);

    return new Promise<void>((resolve, reject) => {
      activePrompt = { resolve, reject };
      let spawnedChild: ChildProcess;
      try {
        spawnedChild = spawn(claudeBinary, argv, {
          cwd,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        cleanupMcp();
        const msg = err instanceof Error ? err.message : String(err);
        const wrapped = /enoent/i.test(msg)
          ? `claude CLI not found on PATH — install Claude Code (https://claude.com/claude-code) or set claudeBinary in config (original: ${msg})`
          : `claude CLI spawn failed: ${msg}`;
        settleFailure(new Error(wrapped));
        return;
      }
      child = spawnedChild;

      const parser = createNdjsonParser((raw, reason) => {
        log.debug(`[claude-cli] ignoring unknown stream-json line (${reason}): ${raw.slice(0, 200)}`);
      });

      const stderrChunks: string[] = [];
      let errored: Error | undefined;
      let sawResult = false;

      spawnedChild.stdout?.on('data', (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
        const events = parser.push(text);
        for (const ev of events) {
          if (ev.type === 'result') sawResult = true;
          handleEvent(ev);
        }
      });

      spawnedChild.stderr?.on('data', (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
        stderrChunks.push(text);
      });

      spawnedChild.on('error', (err: NodeJS.ErrnoException) => {
        const msg = err.message ?? String(err);
        if (err.code === 'ENOENT' || /enoent/i.test(msg)) {
          errored = new Error(
            `claude CLI not found on PATH — install Claude Code (https://claude.com/claude-code) or set claudeBinary in config (original: ${msg})`,
          );
        } else {
          errored = new Error(`claude CLI subprocess error: ${msg}`);
        }
      });

      spawnedChild.on('close', (code: number | null) => {
        // Flush any trailing partial line — the CLI usually ends with \n,
        // but be defensive against the edge case.
        for (const ev of parser.flush()) {
          if (ev.type === 'result') sawResult = true;
          handleEvent(ev);
        }
        cleanupMcp();
        child = undefined;

        if (errored != null) {
          state.errorMessage = errored.message;
          settleFailure(errored);
          return;
        }

        if (abortRequested) {
          state.errorMessage = state.errorMessage ?? 'aborted';
          settleFailure(new Error(state.errorMessage));
          return;
        }

        if (code != null && code !== 0 && !sawResult) {
          // Non-zero exit without a result event → surface stderr.
          const stderr = stderrChunks.join('').trim();
          state.errorMessage = `claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`;
          // The runtime contract is that promise resolution surfaces a usable
          // state to the caller. wave-executor reads state.errorMessage and
          // throws a KovaError of the appropriate class — so we RESOLVE here
          // rather than reject. (This matches PiAgentRuntime's contract.)
          settleSuccess();
          return;
        }

        if (state.errorMessage != null) {
          // result.is_error=true case: state.errorMessage is set in
          // handleEvent; resolve so wave-executor can classify it.
          settleSuccess();
          return;
        }

        settleSuccess();
      });

      // Write the user message to stdin and close.
      try {
        spawnedChild.stdin?.write(userMessage);
        spawnedChild.stdin?.end();
      } catch (err) {
        log.debug(`[claude-cli] stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  function cleanupMcp(): void {
    if (mcpCleanup) {
      mcpCleanup();
      mcpCleanup = undefined;
    }
  }

  function abortImpl(): void {
    if (child == null) return;
    abortRequested = true;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      log.debug(`[claude-cli] SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Escalate to SIGKILL if the child hasn't exited within the grace period.
    const sigkillTimer = setTimeout(() => {
      if (child == null) return;
      if (child.killed) return;
      try {
        child.kill('SIGKILL');
      } catch (err) {
        log.debug(`[claude-cli] SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, abortGraceMs);
    // node:timers#unref so the timer doesn't keep the event loop alive.
    if (typeof sigkillTimer === 'object' && sigkillTimer != null && 'unref' in sigkillTimer) {
      (sigkillTimer as { unref(): void }).unref();
    }
  }

  function subscribeImpl(listener: (event: RuntimeEvent) => void): () => void {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  // The runtime object exposes the AgentRuntime interface plus the extended
  // `state.sessionId` field (cast at the boundary — it's a kova extension,
  // not part of the canonical interface).
  const rt: AgentRuntime & { state: ClaudeCliRuntimeState } = {
    prompt: promptImpl,
    abort: abortImpl,
    subscribe: subscribeImpl,
    state,
  };
  return rt as AgentRuntime;
}

/** Public factory. Drop-in `AgentRuntimeFactory` for wave-executor. */
export const claudeCliRuntimeFactory: AgentRuntimeFactory = {
  create: createClaudeCliRuntime,
};

// Internal exports for unit testing / future #297 session-resume wiring.
export { buildArgv, createClaudeCliRuntime, createNdjsonParser, translateStopReason };
