// Context transform hook for pi-agent-core Agent — trims old tool results
// when context pressure builds, preventing context window exhaustion.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { estimateTokens } from '../pipeline/context.js';

/** Tool names whose results can be cleared under context pressure. */
export const COMPACTABLE_TOOLS: ReadonlyArray<string> = ['Read', 'Bash', 'Grep', 'Glob'] as const;

/** Regex matching common error patterns in tool output. */
const ERROR_PATTERN =
  /\bError\b|^error:|TypeError|ReferenceError|SyntaxError|ENOENT|EPERM|EACCES|panic|stack trace|at\s+\S+\s+\(/im;

const CLEARED_TEXT = '[tool result cleared — context pressure]';

/** 60% threshold — keep last 5 compactable tool results. */
const MODERATE_THRESHOLD = 0.6;
/** 75% threshold — keep only last 3 compactable tool results. */
const HIGH_THRESHOLD = 0.75;

function isToolResult(msg: AgentMessage): msg is ToolResultMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'toolResult';
}

function hasErrorContent(msg: ToolResultMessage): boolean {
  if (msg.isError) return true;
  for (const block of msg.content) {
    if (block.type === 'text' && ERROR_PATTERN.test(block.text)) {
      return true;
    }
  }
  return false;
}

function isCompactable(msg: ToolResultMessage): boolean {
  return COMPACTABLE_TOOLS.includes(msg.toolName);
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (isToolResult(msg)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += estimateTokens(block.text);
        }
      }
    } else if ('content' in msg) {
      if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block && typeof block.text === 'string') {
            total += estimateTokens(block.text);
          }
        }
      }
    }
  }
  return total;
}

function clearToolResult(msg: ToolResultMessage): ToolResultMessage {
  return {
    ...msg,
    content: [{ type: 'text', text: CLEARED_TEXT }],
  };
}

/**
 * Create a `transformContext` hook for the pi-agent-core Agent.
 *
 * Trims old tool results when context pressure builds:
 * - >60% of contextWindow: clear compactable tool results older than last 5
 * - >75% of contextWindow: clear compactable tool results older than last 3
 * - Error-containing tool results are always preserved
 * - Only Read, Bash, Grep, Glob results are cleared (not Edit/Write)
 */
export function createTransformContext(
  contextWindow: number,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const totalTokens = estimateMessagesTokens(messages);
    const usageRatio = totalTokens / contextWindow;

    if (usageRatio < MODERATE_THRESHOLD) {
      return messages;
    }

    const keepCount = usageRatio >= HIGH_THRESHOLD ? 3 : 5;

    // Find indices of compactable, non-error tool results (in order)
    const compactableIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as AgentMessage;
      if (isToolResult(msg) && isCompactable(msg) && !hasErrorContent(msg)) {
        compactableIndices.push(i);
      }
    }

    // Keep the last `keepCount` compactable results intact, clear the rest
    const indicesToClear = new Set(compactableIndices.slice(0, Math.max(0, compactableIndices.length - keepCount)));

    if (indicesToClear.size === 0) {
      return messages;
    }

    return messages.map((msg, i) => {
      if (indicesToClear.has(i)) {
        return clearToolResult(msg as ToolResultMessage);
      }
      return msg;
    });
  };
}
