// Tests for sandbox wave-dispatch routing — verifies that when a SandboxContext
// is supplied, the dispatcher routes wave execution through
// `execWaveInContainer` instead of running on the host. This is the regression
// suite for issue #319 (docker isolation runs AI on host — execWaveInContainer
// is unreachable).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxContext } from './dispatch.js';

// Mock the underlying executors BEFORE importing the dispatch module.
// Dispatch imports the executors from `../ai/index.js`, so we mock that barrel.
vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    ...actual,
    spawnWaveAgentWithFallback: vi.fn(),
    executeWaveWithRetry: vi.fn(),
  };
});

vi.mock('../services/sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sandbox.js')>();
  return {
    ...actual,
    execWaveInContainer: vi.fn(),
  };
});

import { executeWaveWithRetry, spawnWaveAgentWithFallback } from '../ai/index.js';
import { execWaveInContainer } from '../services/sandbox.js';
import type { SandboxBackend } from './backend.js';
import { dispatchExecuteWave, dispatchSpawnWave, resolveOutputSchemaName } from './dispatch.js';

const mockSpawnWaveAgentWithFallback = vi.mocked(spawnWaveAgentWithFallback);
const mockExecuteWaveWithRetry = vi.mocked(executeWaveWithRetry);
const mockExecWaveInContainer = vi.mocked(execWaveInContainer);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseSpawnConfig = {
  wave: 'assess' as const,
  model: 'anthropic:claude-opus',
  tools: [],
  systemPrompt: 'sys',
  handoffContext: '',
  userMessage: 'do the thing',
  cwd: '/host/repo',
};

const baseWaveOptions = {
  wave: 'test' as const,
  systemPrompt: 'sys',
  userMessage: 'msg',
  cwd: '/host/repo',
  modelTier: 'medium' as const,
};

const sandbox: SandboxContext = {
  containerName: 'kova-sandbox-test-42',
  repoPath: '/host/repo',
};

describe('resolveOutputSchemaName', () => {
  it('returns wave-name for waves with a registered schema', () => {
    expect(resolveOutputSchemaName('assess', true)).toBe('assess');
    expect(resolveOutputSchemaName('spec', true)).toBe('spec');
    expect(resolveOutputSchemaName('quality', true)).toBe('quality');
    expect(resolveOutputSchemaName('review', true)).toBe('review');
    expect(resolveOutputSchemaName('brainstorm', true)).toBe('brainstorm');
  });

  it('returns undefined when hasOutputFormat is false', () => {
    expect(resolveOutputSchemaName('assess', false)).toBeUndefined();
    expect(resolveOutputSchemaName('spec', false)).toBeUndefined();
  });

  it('returns undefined for waves with no registered schema (test/impl)', () => {
    // Test and impl waves do not return structured JSON — they edit files and
    // return free-form markdown. They should not request schema validation.
    expect(resolveOutputSchemaName('test', true)).toBeUndefined();
    expect(resolveOutputSchemaName('impl', true)).toBeUndefined();
  });
});

describe('dispatchSpawnWave', () => {
  it('routes through spawnWaveAgentWithFallback when no sandbox is supplied', async () => {
    mockSpawnWaveAgentWithFallback.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: { ok: true },
      approach_notes: '',
      fallback_used: false,
    });

    await dispatchSpawnWave(baseSpawnConfig);

    expect(mockSpawnWaveAgentWithFallback).toHaveBeenCalledTimes(1);
    expect(mockExecWaveInContainer).not.toHaveBeenCalled();
  });

  it('routes through execWaveInContainer when sandbox is supplied', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: { ok: true },
      approach_notes: '',
    });

    await dispatchSpawnWave(baseSpawnConfig, sandbox);

    expect(mockExecWaveInContainer).toHaveBeenCalledTimes(1);
    expect(mockSpawnWaveAgentWithFallback).not.toHaveBeenCalled();

    const [containerName, input, repoPath] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect(containerName).toBe('kova-sandbox-test-42');
    expect(repoPath).toBe('/host/repo');
    // CRITICAL: cwd inside the container must be /workspace, NOT the host path.
    // Issue #319: passing host paths into the container would let the AI act
    // on host filesystem.
    expect((input as { cwd?: string })?.cwd).toBe('/workspace');
    expect((input as { wave?: string })?.wave).toBe('assess');
  });

  it('passes outputSchemaName when outputFormat is provided', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'spec',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        wave: 'spec',
        outputFormat: { type: 'json_schema', schema: {} },
      },
      sandbox,
    );

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect((input as { outputSchemaName?: string })?.outputSchemaName).toBe('spec');
  });

  it('omits outputSchemaName when outputFormat is not provided', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'impl',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: '',
      approach_notes: '',
    });

    await dispatchSpawnWave({ ...baseSpawnConfig, wave: 'impl' }, sandbox);

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect((input as { outputSchemaName?: string })?.outputSchemaName).toBeUndefined();
  });

  it('preserves thinkingLevel and fallbackModel in container input', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        thinkingLevel: 'high',
        fallbackModel: 'anthropic:claude-sonnet',
      },
      sandbox,
    );

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect((input as { thinkingLevel?: string })?.thinkingLevel).toBe('high');
    expect((input as { fallbackModel?: string })?.fallbackModel).toBe('anthropic:claude-sonnet');
  });

  it('concatenates handoffContext into userMessage with separator', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        handoffContext: 'previous wave output',
        userMessage: 'next task',
      },
      sandbox,
    );

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect((input as { userMessage?: string })?.userMessage).toBe('previous wave output\n\n---\n\nnext task');
  });

  it('forwards a custom dockerCommand', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(baseSpawnConfig, { ...sandbox, dockerCommand: 'podman' });

    const [, , , dockerCommand] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect(dockerCommand).toBe('podman');
  });

  it('defaults fallback_used to false when runner omits it', async () => {
    // Runner-side `WaveHandoff` lacks `fallback_used` — dispatcher must default
    // it so the caller (which expects `FallbackWaveHandoff`) does not see
    // undefined.
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    const handoff = await dispatchSpawnWave(baseSpawnConfig, sandbox);
    expect(handoff.fallback_used).toBe(false);
  });
});

describe('dispatchExecuteWave', () => {
  it('routes through executeWaveWithRetry when no sandbox is supplied', async () => {
    mockExecuteWaveWithRetry.mockResolvedValue({
      result: 'ok',
      success: true,
      duration: 100,
      turns: 1,
      cost: 0.01,
      model: 'anthropic:claude-sonnet',
      provider: 'anthropic',
    });

    await dispatchExecuteWave(baseWaveOptions);

    expect(mockExecuteWaveWithRetry).toHaveBeenCalledTimes(1);
    expect(mockExecWaveInContainer).not.toHaveBeenCalled();
  });

  it('routes through execWaveInContainer when sandbox is supplied', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'test',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.01,
      turns: 1,
      confidence: 'high',
      artifact: 'test output',
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(baseWaveOptions, sandbox);

    expect(mockExecWaveInContainer).toHaveBeenCalledTimes(1);
    expect(mockExecuteWaveWithRetry).not.toHaveBeenCalled();

    const [containerName, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    expect(containerName).toBe('kova-sandbox-test-42');
    expect((input as { cwd?: string })?.cwd).toBe('/workspace');
    expect(result.success).toBe(true);
    expect(result.result).toBe('test output');
  });

  it('converts handoff fields to WaveExecutionResult shape', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'review',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.25,
      turns: 5,
      confidence: 'high',
      artifact: { verdict: 'pass', findings: [], summary: 'looks good' },
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(
      { ...baseWaveOptions, wave: 'review', outputFormat: { type: 'json_schema', schema: {} } },
      sandbox,
    );

    expect(result.success).toBe(true);
    expect(result.cost).toBe(0.25);
    expect(result.turns).toBe(5);
    // structuredOutput should be set when confidence is high
    expect(result.structuredOutput).toEqual({ verdict: 'pass', findings: [], summary: 'looks good' });
  });

  it('retries on transient failures inside the container and eventually returns failure', async () => {
    mockExecWaveInContainer.mockRejectedValue(new Error('docker exec failed'));

    const result = await dispatchExecuteWave(baseWaveOptions, sandbox, 1);

    // 1 + 1 retries = 2 calls
    expect(mockExecWaveInContainer).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
  }, 30_000);

  it('succeeds on retry after one transient failure', async () => {
    mockExecWaveInContainer.mockRejectedValueOnce(new Error('docker exec transient')).mockResolvedValueOnce({
      wave: 'test',
      timestamp: '2026-06-01T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.02,
      turns: 1,
      confidence: 'medium',
      artifact: 'recovered',
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(baseWaveOptions, sandbox, 2);

    expect(result.success).toBe(true);
    expect(result.result).toBe('recovered');
    // structuredOutput should NOT be set when confidence is medium
    expect(result.structuredOutput).toBeUndefined();
  }, 30_000);
});

// ----------------------------------------------------------------------------
// Issue #379: when `sandbox.backend` is supplied, dispatch must route through
// `backend.execWave()` rather than `execWaveInContainer` so non-Docker backends
// (Daytona, Modal, Fly.io, e2b) can fully own wave execution. The Docker path —
// where only `containerName`+`repoPath` are supplied — must remain bit-for-bit
// identical for back-compat.
// ----------------------------------------------------------------------------

/** Build a minimal SandboxBackend test double with a Vitest-mocked execWave. */
function makeFakeBackend(): SandboxBackend & { execWave: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(),
    execWave: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn(),
    hibernate: vi.fn(),
    resume: vi.fn(),
  };
}

describe('dispatchSpawnWave — backend routing (issue #379)', () => {
  it('routes through backend.execWave when sandbox.backend is supplied', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: { ok: true },
      approach_notes: '',
    });

    await dispatchSpawnWave(baseSpawnConfig, { ...sandbox, backend });

    expect(backend.execWave).toHaveBeenCalledTimes(1);
    // The docker-exec fallback MUST NOT be touched when a backend is in play.
    expect(mockExecWaveInContainer).not.toHaveBeenCalled();
    expect(mockSpawnWaveAgentWithFallback).not.toHaveBeenCalled();

    const input = backend.execWave.mock.calls[0]?.[0] as {
      cwd?: string;
      wave?: string;
      systemPrompt?: string;
      userMessage?: string;
    };
    // Same /workspace cwd contract that docker enforces — the runner inside the
    // workspace expects to operate on /workspace, never the host path.
    expect(input?.cwd).toBe('/workspace');
    expect(input?.wave).toBe('assess');
    expect(input?.systemPrompt).toBe('sys');
    expect(input?.userMessage).toBe('do the thing');
  });

  it('defaults fallback_used to false when backend.execWave omits it', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    const handoff = await dispatchSpawnWave(baseSpawnConfig, { ...sandbox, backend });
    expect(handoff.fallback_used).toBe(false);
  });

  it('forwards outputSchemaName + thinkingLevel + fallbackModel through backend.execWave', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockResolvedValue({
      wave: 'spec',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        wave: 'spec',
        thinkingLevel: 'high',
        fallbackModel: 'anthropic:claude-sonnet',
        outputFormat: { type: 'json_schema', schema: {} },
      },
      { ...sandbox, backend },
    );

    const input = backend.execWave.mock.calls[0]?.[0] as {
      thinkingLevel?: string;
      fallbackModel?: string;
      outputSchemaName?: string;
    };
    expect(input?.thinkingLevel).toBe('high');
    expect(input?.fallbackModel).toBe('anthropic:claude-sonnet');
    expect(input?.outputSchemaName).toBe('spec');
  });

  it('preserves docker-exec back-compat when sandbox.backend is NOT set', async () => {
    // Regression guard: existing Docker callers pass only containerName+repoPath
    // (no backend field). dispatch must still call execWaveInContainer — never
    // try to invent a backend.
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(baseSpawnConfig, sandbox);

    expect(mockExecWaveInContainer).toHaveBeenCalledTimes(1);
    expect(mockSpawnWaveAgentWithFallback).not.toHaveBeenCalled();
  });
});

describe('dispatchExecuteWave — backend routing (issue #379)', () => {
  it('routes through backend.execWave when sandbox.backend is supplied', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockResolvedValue({
      wave: 'test',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.01,
      turns: 1,
      confidence: 'high',
      artifact: 'test output',
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(baseWaveOptions, { ...sandbox, backend });

    expect(backend.execWave).toHaveBeenCalledTimes(1);
    expect(mockExecWaveInContainer).not.toHaveBeenCalled();
    expect(mockExecuteWaveWithRetry).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.result).toBe('test output');

    const input = backend.execWave.mock.calls[0]?.[0] as { cwd?: string };
    expect(input?.cwd).toBe('/workspace');
  });

  it('retries on transient backend.execWave failures, then succeeds', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockRejectedValueOnce(new Error('backend transient')).mockResolvedValueOnce({
      wave: 'test',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.02,
      turns: 1,
      confidence: 'high',
      artifact: 'recovered via backend',
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(baseWaveOptions, { ...sandbox, backend }, 2);

    expect(backend.execWave).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.result).toBe('recovered via backend');
    // docker-exec path must never fire when a backend owns the dispatch
    expect(mockExecWaveInContainer).not.toHaveBeenCalled();
  }, 30_000);

  it('returns failure result after backend.execWave exhausts retries', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockRejectedValue(new Error('backend permafail'));

    const result = await dispatchExecuteWave(baseWaveOptions, { ...sandbox, backend }, 1);

    // 1 + 1 retries = 2 calls (mirrors the docker-exec contract)
    expect(backend.execWave).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
  }, 30_000);

  it('preserves docker-exec back-compat when sandbox.backend is NOT set', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'test',
      timestamp: '2026-06-02T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.01,
      turns: 1,
      confidence: 'high',
      artifact: 'docker output',
      approach_notes: '',
    });

    const result = await dispatchExecuteWave(baseWaveOptions, sandbox);

    expect(mockExecWaveInContainer).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.result).toBe('docker output');
  });
});

// ----------------------------------------------------------------------------
// Issue #306: MCP server config must be plumbed from the host orchestrator
// through dispatch into the in-container runner so codegraph (and other
// MCP servers) are available to sandboxed waves. With `restrict_network:true`
// the container has `--network none`, so the runner must reconstruct/start
// MCP servers locally on /workspace rather than proxying to the host.
// ----------------------------------------------------------------------------

describe('dispatchSpawnWave — MCP plumbing (issue #306)', () => {
  it('forwards mcpServers and mcpWaveOverrides into the docker-exec wire input', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-03T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    const mcpServers = {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
      'repo-intel': { command: 'repo-intel', args: ['mcp'] },
    };
    const mcpWaveOverrides: Partial<Record<'assess' | 'spec', string[]>> = {
      assess: ['codegraph'],
      spec: ['codegraph', 'repo-intel'],
    };

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        mcpServers,
        mcpWaveOverrides,
      },
      sandbox,
    );

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    const cast = input as {
      mcpServers?: Record<string, unknown>;
      mcpWaveOverrides?: Record<string, string[]>;
    };
    expect(cast.mcpServers).toEqual(mcpServers);
    expect(cast.mcpWaveOverrides).toEqual(mcpWaveOverrides);
  });

  it('omits mcpServers when none are supplied (backward compat)', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'assess',
      timestamp: '2026-06-03T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    await dispatchSpawnWave(baseSpawnConfig, sandbox);

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    const cast = input as { mcpServers?: unknown; mcpWaveOverrides?: unknown };
    expect(cast.mcpServers).toBeUndefined();
    expect(cast.mcpWaveOverrides).toBeUndefined();
  });

  it('forwards mcpServers and mcpWaveOverrides into backend.execWave input', async () => {
    const backend = makeFakeBackend();
    backend.execWave.mockResolvedValue({
      wave: 'review',
      timestamp: '2026-06-03T00:00:00Z',
      model: 'anthropic:claude-opus',
      cost: 0.1,
      turns: 1,
      confidence: 'high',
      artifact: {},
      approach_notes: '',
    });

    const mcpServers = {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp', '--path', '/workspace'] },
    };
    const mcpWaveOverrides: Partial<Record<'review', string[]>> = { review: ['codegraph'] };

    await dispatchSpawnWave(
      {
        ...baseSpawnConfig,
        wave: 'review',
        mcpServers,
        mcpWaveOverrides,
      },
      { ...sandbox, backend },
    );

    const input = backend.execWave.mock.calls[0]?.[0] as {
      mcpServers?: Record<string, unknown>;
      mcpWaveOverrides?: Record<string, string[]>;
    };
    expect(input.mcpServers).toEqual(mcpServers);
    expect(input.mcpWaveOverrides).toEqual(mcpWaveOverrides);
  });
});

describe('dispatchExecuteWave — MCP plumbing (issue #306)', () => {
  it('forwards mcpServers and mcpWaveOverrides into the docker-exec wire input', async () => {
    mockExecWaveInContainer.mockResolvedValue({
      wave: 'test',
      timestamp: '2026-06-03T00:00:00Z',
      model: 'anthropic:claude-sonnet',
      cost: 0.01,
      turns: 1,
      confidence: 'high',
      artifact: 'ok',
      approach_notes: '',
    });

    const mcpServers = {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
    };
    const mcpWaveOverrides: Partial<Record<'test', string[]>> = { test: ['codegraph'] };

    await dispatchExecuteWave(
      {
        ...baseWaveOptions,
        mcpServers,
        mcpWaveOverrides,
      },
      sandbox,
    );

    const [, input] = mockExecWaveInContainer.mock.calls[0] ?? [];
    const cast = input as {
      mcpServers?: Record<string, unknown>;
      mcpWaveOverrides?: Record<string, string[]>;
    };
    expect(cast.mcpServers).toEqual(mcpServers);
    expect(cast.mcpWaveOverrides).toEqual(mcpWaveOverrides);
  });
});
