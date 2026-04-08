import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { COMPACTABLE_TOOLS, createTransformContext } from './context-transform.js';

// --- Helpers ---

function userMsg(text: string, timestamp = Date.now()): UserMessage {
  return { role: 'user', content: text, timestamp };
}

function toolResult(
  toolName: string,
  text: string,
  opts: { isError?: boolean; toolCallId?: string } = {},
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: opts.toolCallId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    content: [{ type: 'text', text }],
    details: undefined,
    isError: opts.isError ?? false,
    timestamp: Date.now(),
  };
}

/** Build a message list with N tool results of a given size, all from Read tool. */
function buildToolResults(count: number, textSize: number): AgentMessage[] {
  const messages: AgentMessage[] = [userMsg('Start')];
  for (let i = 0; i < count; i++) {
    messages.push(toolResult('Read', 'x'.repeat(textSize)));
  }
  return messages;
}

describe('createTransformContext', () => {
  describe('returns identity under pressure threshold', () => {
    it('returns messages unchanged when total tokens < 60% of contextWindow', async () => {
      // contextWindow = 200_000, so 60% = 120_000 tokens ≈ ~480_000 chars
      // We'll use small messages well under threshold
      const transform = createTransformContext(200_000);
      const messages: AgentMessage[] = [
        userMsg('Hello world'),
        toolResult('Read', 'short content'),
        toolResult('Grep', 'some grep output'),
      ];

      const result = await transform(messages);
      expect(result).toEqual(messages);
    });
  });

  describe('60% threshold — keep last 5 tool results', () => {
    it('replaces tool result content older than last 5 at >60% context pressure', async () => {
      // contextWindow = 600 tokens. 8 tool results × ~210 chars ≈ 1680 chars ≈ 373 tokens = 62%
      const contextWindow = 600;
      const transform = createTransformContext(contextWindow);

      // Create 8 Read tool results, each with enough text to exceed 60%
      const messages: AgentMessage[] = [userMsg('Go')];
      for (let i = 0; i < 8; i++) {
        messages.push(toolResult('Read', `content-${i}-${'a'.repeat(200)}`));
      }

      const result = await transform(messages);

      // Last 5 should be intact (indices 4-8 from the tool results, i.e. messages[5]-messages[8])
      for (let i = 4; i < 8; i++) {
        const msg = result[i + 1] as ToolResultMessage; // +1 for the user message at index 0
        expect(msg.content[0]).toHaveProperty('text');
        expect((msg.content[0] as { type: 'text'; text: string }).text).toContain(`content-${i}`);
      }

      // Older ones (indices 0-2) should be cleared
      for (let i = 0; i < 3; i++) {
        const msg = result[i + 1] as ToolResultMessage;
        expect((msg.content[0] as { type: 'text'; text: string }).text).toBe(
          '[tool result cleared — context pressure]',
        );
      }
    });
  });

  describe('75% threshold — keep last 3 tool results', () => {
    it('keeps only last 3 tool results at >75% context pressure', async () => {
      // contextWindow = 400. 8 × ~210 chars ≈ 1680 chars ≈ 373 tokens = 93% → >75%
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const messages: AgentMessage[] = [userMsg('Go')];
      for (let i = 0; i < 8; i++) {
        messages.push(toolResult('Read', `content-${i}-${'a'.repeat(200)}`));
      }

      const result = await transform(messages);

      // Last 3 should be intact (indices 5, 6, 7)
      for (let i = 5; i < 8; i++) {
        const msg = result[i + 1] as ToolResultMessage;
        expect((msg.content[0] as { type: 'text'; text: string }).text).toContain(`content-${i}`);
      }

      // Older ones (indices 0-4) should be cleared
      for (let i = 0; i < 5; i++) {
        const msg = result[i + 1] as ToolResultMessage;
        expect((msg.content[0] as { type: 'text'; text: string }).text).toBe(
          '[tool result cleared — context pressure]',
        );
      }
    });
  });

  describe('error-containing tool results are preserved', () => {
    it('does not clear tool results that contain error output', async () => {
      // contextWindow = 400 → >75% threshold, keepCount=3
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const messages: AgentMessage[] = [
        userMsg('Go'),
        toolResult('Read', 'Error: file not found', { isError: true }),
        toolResult('Read', `normal-${'a'.repeat(200)}`),
        toolResult('Bash', 'TypeError: Cannot read properties of undefined', { isError: true }),
        toolResult('Read', `normal2-${'a'.repeat(200)}`),
        toolResult('Read', `normal3-${'a'.repeat(200)}`),
        toolResult('Read', `normal4-${'a'.repeat(200)}`),
        toolResult('Read', `normal5-${'a'.repeat(200)}`),
      ];

      const result = await transform(messages);

      // Error results should always be preserved regardless of position
      const errorResult1 = result[1] as ToolResultMessage;
      expect((errorResult1.content[0] as { type: 'text'; text: string }).text).toContain('Error: file not found');

      const errorResult2 = result[3] as ToolResultMessage;
      expect((errorResult2.content[0] as { type: 'text'; text: string }).text).toContain('TypeError');
    });

    it('preserves tool results with error patterns in content even if isError is false', async () => {
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const messages: AgentMessage[] = [
        userMsg('Go'),
        toolResult('Bash', 'Error: ENOENT: no such file or directory'),
        toolResult('Read', `normal-${'a'.repeat(200)}`),
        toolResult('Read', `normal2-${'a'.repeat(200)}`),
        toolResult('Read', `normal3-${'a'.repeat(200)}`),
        toolResult('Read', `normal4-${'a'.repeat(200)}`),
        toolResult('Read', `normal5-${'a'.repeat(200)}`),
      ];

      const result = await transform(messages);

      // The Bash result with "Error:" pattern should be preserved
      const bashResult = result[1] as ToolResultMessage;
      expect((bashResult.content[0] as { type: 'text'; text: string }).text).toContain('ENOENT');
    });
  });

  describe('only compactable tools are cleared', () => {
    it('does not clear Edit or Write tool results', async () => {
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const messages: AgentMessage[] = [
        userMsg('Go'),
        toolResult('Edit', `edit-content-${'a'.repeat(200)}`),
        toolResult('Write', `write-content-${'a'.repeat(200)}`),
        toolResult('Read', `read-${'a'.repeat(200)}`),
        toolResult('Read', `read2-${'a'.repeat(200)}`),
        toolResult('Read', `read3-${'a'.repeat(200)}`),
        toolResult('Read', `read4-${'a'.repeat(200)}`),
      ];

      const result = await transform(messages);

      // Edit and Write should always be preserved
      const editMsg = result[1] as ToolResultMessage;
      expect((editMsg.content[0] as { type: 'text'; text: string }).text).toContain('edit-content');

      const writeMsg = result[2] as ToolResultMessage;
      expect((writeMsg.content[0] as { type: 'text'; text: string }).text).toContain('write-content');
    });

    it('clears Read, Bash, Grep, and Glob tool results', async () => {
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const messages: AgentMessage[] = [
        userMsg('Go'),
        toolResult('Read', `read-old-${'a'.repeat(200)}`),
        toolResult('Bash', `bash-old-${'a'.repeat(200)}`),
        toolResult('Grep', `grep-old-${'a'.repeat(200)}`),
        toolResult('Glob', `glob-old-${'a'.repeat(200)}`),
        // These 3 are the "last 3" that should survive at 75%
        toolResult('Read', `read-new-${'a'.repeat(200)}`),
        toolResult('Read', `read-new2-${'a'.repeat(200)}`),
        toolResult('Read', `read-new3-${'a'.repeat(200)}`),
      ];

      const result = await transform(messages);

      // Old compactable results should be cleared
      for (let i = 1; i <= 4; i++) {
        const msg = result[i] as ToolResultMessage;
        expect((msg.content[0] as { type: 'text'; text: string }).text).toBe(
          '[tool result cleared — context pressure]',
        );
      }
    });
  });

  describe('COMPACTABLE_TOOLS constant', () => {
    it('includes Read, Bash, Grep, Glob', () => {
      expect(COMPACTABLE_TOOLS).toContain('Read');
      expect(COMPACTABLE_TOOLS).toContain('Bash');
      expect(COMPACTABLE_TOOLS).toContain('Grep');
      expect(COMPACTABLE_TOOLS).toContain('Glob');
    });

    it('does not include Edit or Write', () => {
      expect(COMPACTABLE_TOOLS).not.toContain('Edit');
      expect(COMPACTABLE_TOOLS).not.toContain('Write');
    });
  });

  describe('non-tool-result messages are never modified', () => {
    it('preserves user messages unchanged', async () => {
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);

      const user = userMsg('Important instructions that must not be cleared');
      const messages: AgentMessage[] = [user, ...buildToolResults(10, 200)];

      const result = await transform(messages);
      expect(result[0]).toEqual(user);
    });
  });

  describe('message count is preserved', () => {
    it('returns the same number of messages (clears content, does not remove messages)', async () => {
      const contextWindow = 400;
      const transform = createTransformContext(contextWindow);
      const messages = buildToolResults(10, 200);

      const result = await transform(messages);
      expect(result).toHaveLength(messages.length);
    });
  });

  describe('return type', () => {
    it('returns a Promise<AgentMessage[]>', async () => {
      const transform = createTransformContext(200_000);
      const result = transform([userMsg('test')]);
      expect(result).toBeInstanceOf(Promise);
      const resolved = await result;
      expect(Array.isArray(resolved)).toBe(true);
    });
  });
});
