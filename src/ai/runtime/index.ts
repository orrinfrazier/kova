/**
 * `src/ai/runtime` — kova-owned agent-runtime abstraction.
 *
 * Wave-executor and other consumers should import from this barrel, not from
 * `types.ts` or `pi-agent-runtime.ts` directly. The default factory is
 * exported so wave-executor can fall back to pi-mono when no runtime is
 * injected.
 *
 * Issue: kova#309 (interface)
 * Successor: kova#310 (full PiAgentRuntime adapter)
 */

export type { ClaudeCliRuntimeConfig } from './claude-cli-runtime.js';
export { claudeCliRuntimeFactory } from './claude-cli-runtime.js';
export { createPiAgentRuntime, defaultAgentRuntimeFactory } from './pi-agent-runtime.js';
export type { RuntimeKind } from './resolver.js';
export { RUNTIME_KINDS, resolveRuntimeFactory, wrapClaudeCliFactoryWithMcp } from './resolver.js';
export type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeFactory,
  AssistantTurn,
  CacheRetention,
  ModelSpec,
  RuntimeAfterToolCallContext,
  RuntimeAfterToolCallHook,
  RuntimeAfterToolCallResult,
  RuntimeBeforeToolCallContext,
  RuntimeBeforeToolCallHook,
  RuntimeBeforeToolCallResult,
  RuntimeContent,
  RuntimeEvent,
  RuntimeGetApiKey,
  RuntimeTextContent,
  RuntimeThinkingContent,
  RuntimeTool,
  RuntimeToolUseContent,
  RuntimeTransformContext,
  ThinkingLevel,
  ToolResultMessage,
  UserMessage,
} from './types.js';
