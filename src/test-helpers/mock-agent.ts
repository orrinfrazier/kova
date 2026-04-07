/**
 * Reusable mock for pi-mono Agent — configurable canned responses per wave.
 *
 * Usage in tests:
 *   import { createMockAgent, setupResponseSequence, CANNED } from '../test-helpers/mock-agent.js';
 *   const mockConstructor = vi.fn();
 *   vi.mock('@mariozechner/pi-agent-core', () => ({ Agent: mockConstructor }));
 *   setupResponseSequence(mockConstructor, [{ structuredOutput: CANNED.ASSESS_PASS }]);
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaveResponse {
  result?: string;
  cost?: number;
  model?: string;
  structuredOutput?: unknown;
  error?: string;
  piMonoError?: string;
}

export interface MockAgent {
  subscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  state: Record<string, unknown>;
  abort: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Canned structured outputs — ready-made responses for each wave
// ---------------------------------------------------------------------------

export const CANNED = {
  ASSESS_PASS: {
    grade: 'A' as const,
    surface_area: { files: ['src/foo.ts'], estimated_lines: 30, modules_affected: ['core'] },
    risk: 'low' as const,
    reasoning: 'Small, well-scoped change',
    should_proceed: true,
  },

  ASSESS_FAIL: {
    grade: 'F' as const,
    surface_area: { files: [], estimated_lines: 5000, modules_affected: ['everything'] },
    risk: 'critical' as const,
    reasoning: 'Complete rewrite needed',
    should_proceed: false,
  },

  SPEC_RESULT: {
    summary: 'Add validation to input handler',
    pieces: [
      {
        name: 'input-validation',
        description: 'Validate user input',
        files: ['src/handler.ts'],
        acceptance_criteria: ['rejects empty input', 'trims whitespace'],
        wiring: ['export from index.ts'],
      },
    ],
    dependency_order: [[0]],
    constraints: ['Must not break existing API'],
  },

  IMPL_PASS: {
    files_modified: ['src/handler.ts'],
    files_created: [],
    tests_passing: true,
    approach_notes: 'Implementation complete, all tests passing',
  },

  REVIEW_PASS: {
    verdict: 'pass' as const,
    findings: [],
    summary: 'Looks good',
  },

  REVIEW_NEEDS_FIXES: {
    verdict: 'needs_fixes' as const,
    findings: [
      {
        category: 'mechanical_fix',
        file: 'src/handler.ts',
        line: 10,
        description: 'Unused import',
        severity: 'low',
      },
    ],
    summary: 'Minor fix needed',
  },

  QUALITY_PASS: {
    lint: 'pass' as const,
    typecheck: 'pass' as const,
    tests: 'pass' as const,
    coverage: 85,
    audit: 'pass' as const,
    all_passing: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Mock agent factory
// ---------------------------------------------------------------------------

export function createMockAgent(response: WaveResponse): MockAgent {
  const subscribers: Array<(event: unknown, signal: AbortSignal) => void> = [];

  const textResult = response.structuredOutput
    ? JSON.stringify(response.structuredOutput)
    : (response.result ?? 'completed');

  const hasError = response.error ?? response.piMonoError;

  const assistantMessage = response.piMonoError
    ? {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '' }],
        usage: { cost: { total: 0 } },
        stopReason: 'error' as const,
        errorMessage: response.piMonoError,
      }
    : {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: textResult }],
        usage: { cost: { total: response.cost ?? 0.05 } },
      };

  const messages = hasError
    ? response.piMonoError
      ? [{ role: 'user' as const, content: [{ type: 'text', text: 'prompt' }] }, assistantMessage]
      : []
    : [{ role: 'user' as const, content: [{ type: 'text', text: 'prompt' }] }, assistantMessage];

  const state: Record<string, unknown> = { messages };
  if (response.piMonoError) {
    state.errorMessage = response.piMonoError;
  }

  const mockPrompt = vi.fn(async (_userMessage?: string) => {
    if (response.error) {
      throw new Error(response.error);
    }
    const ac = new AbortController();
    for (const sub of subscribers) {
      sub({ type: 'turn_end', message: assistantMessage, toolResults: [] }, ac.signal);
    }
  });

  return {
    subscribe: vi.fn((listener: (event: unknown, signal: AbortSignal) => void) => {
      subscribers.push(listener);
      return () => {};
    }),
    prompt: mockPrompt,
    state,
    abort: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Response sequence helper — configures a vi.fn() constructor to return
// successive mock agents with the given responses
// ---------------------------------------------------------------------------

export interface ResponseSequenceState {
  callIndex: number;
  allPrompts: string[];
}

export function setupResponseSequence(
  mockConstructor: ReturnType<typeof vi.fn>,
  responses: WaveResponse[],
): ResponseSequenceState {
  const state: ResponseSequenceState = { callIndex: 0, allPrompts: [] };

  mockConstructor.mockImplementation((options: unknown) => {
    const response = responses[state.callIndex++];
    if (!response) {
      throw new Error(
        `Unexpected Agent constructor call #${state.callIndex} — only ${responses.length} responses configured`,
      );
    }
    const agent = createMockAgent(response);
    const originalPrompt = agent.prompt;
    agent.prompt = vi.fn(async (userMessage: string) => {
      state.allPrompts.push(userMessage);
      return originalPrompt(userMessage);
    });
    (agent as unknown as Record<string, unknown>)._options = options;
    return agent;
  });

  return state;
}

// ---------------------------------------------------------------------------
// Happy path preset — standard 6-wave sequence that passes everything
// ---------------------------------------------------------------------------

export function happyPathResponses(): WaveResponse[] {
  return [
    { structuredOutput: CANNED.ASSESS_PASS, cost: 0.1 },
    { structuredOutput: CANNED.SPEC_RESULT, cost: 0.08 },
    { result: 'Tests written: 3 test files', cost: 0.06 },
    { structuredOutput: CANNED.IMPL_PASS, cost: 0.07 },
    { result: 'All quality gates pass', cost: 0.02 },
    { structuredOutput: CANNED.REVIEW_PASS, cost: 0.09 },
  ];
}
