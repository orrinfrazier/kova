// Tests for context-builder.ts (issue #435 — ADR 004 step 2).
//
// Light unit coverage. The spawnWave helper is largely a glue function over
// `dispatchSpawnWave`, `loadPrompt`, and `resolveWaveModel`; the bulk of its
// behavior is exercised end-to-end in fix.test.ts / fix.events.test.ts. Here
// we lock in the deterministic surfaces we care about:
//
//   - Module-shape: spawnWave is async, returns `{ handoff, promptHash }`.
//   - Cache-context session id (issue #297) is forwarded only when set.
//   - Sandbox MCP wiring only activates when sandbox AND resolvedMcpServers
//     are both set.
//   - LiveFixRegistry sink (issue #294) only runs on the host path.
//
// We mock the heavy dependencies (`dispatchSpawnWave`, `loadPrompt`,
// `resolveWaveModel`) so the test focuses on the surface contract.

import { describe, expect, it, vi } from 'vitest';
import type { RepoConfig, WaveHandoff } from '../types/index.js';

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn(async () => 'mock-prompt'),
  resolvePromptsDir: vi.fn(() => '/tmp/prompts'),
}));

vi.mock('../memory/prompt-versions.js', () => ({
  hashPrompt: vi.fn(() => 'hash-xyz'),
  detectPromptChange: vi.fn(async () => null),
  recordPromptVersion: vi.fn(async () => {}),
}));

vi.mock('../ai/index.js', async () => {
  const actual = await vi.importActual<typeof import('../ai/index.js')>('../ai/index.js');
  return {
    ...actual,
    resolveWaveModel: vi.fn(() => ({ provider: 'anthropic', id: 'claude-sonnet-4-6' })),
    getMCPToolsForWave: vi.fn(() => []),
    getWaveTools: vi.fn(() => []),
    getModelString: vi.fn(() => 'anthropic:claude-sonnet-4-6'),
    resolveThinkingLevel: vi.fn(() => 'medium'),
    buildWaveSessionId: vi.fn(
      (ctx: { repo: string; issue: string | number; wave: string }) => `kova-${ctx.repo}-${ctx.issue}-${ctx.wave}`,
    ),
  };
});

const dispatchMock = vi.fn();
vi.mock('../sandbox/dispatch.js', () => ({
  dispatchSpawnWave: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('../telemetry/live-fix-registry.js', () => ({
  buildLiveHandleSink: vi.fn(() => undefined),
}));

vi.mock('./engines/fallback.js', () => ({
  waveFallbackModel: vi.fn(() => undefined),
}));

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/repo',
    model: {
      assess: 'medium',
      spec: 'medium',
      test: 'medium',
      impl: 'medium',
      quality: 'medium',
      review: 'medium',
      brainstorm: 'medium',
    },
    rules: {},
  } as unknown as RepoConfig;
}

function makeHandoff(): WaveHandoff {
  return {
    wave: 'quality',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    cost: 0.01,
    turns: 1,
    confidence: 'high',
    parsed: true,
    artifact: { result: 'ok' },
    approach_notes: '',
  };
}

describe('spawnWave', () => {
  it('returns { handoff, promptHash } shape from dispatchSpawnWave', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    const result = await spawnWave('quality', '/tmp/wd', '/tmp/repo', makeConfig(), 'do something');
    expect(result.handoff.wave).toBe('quality');
    expect(result.promptHash).toBe('hash-xyz');
  });

  it('forwards a deterministic sessionId only when cacheContext is set', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    await spawnWave(
      'quality',
      '/tmp/wd',
      '/tmp/repo',
      makeConfig(),
      'msg',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { repo: 'owner/r', issue: 42 },
    );
    const lastCall = dispatchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ sessionId: 'kova-owner/r-42-quality' });
  });

  it('omits sessionId when cacheContext is undefined', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    await spawnWave('quality', '/tmp/wd', '/tmp/repo', makeConfig(), 'msg');
    const lastCall = dispatchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).not.toHaveProperty('sessionId');
  });

  it('forwards sandbox-MCP map only when sandbox AND resolvedMcpServers are both set', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    const sandbox = { containerName: 'box-1', repoPath: '/workspace' };
    const mcp = { foo: { command: 'foo', args: [] } };
    await spawnWave(
      'quality',
      '/tmp/wd',
      '/tmp/repo',
      makeConfig(),
      'msg',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sandbox,
      undefined,
      undefined,
      undefined,
      undefined,
      mcp,
    );
    const lastCall = dispatchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ mcpServers: mcp });
    expect(lastCall?.[1]).toBe(sandbox);
  });

  it('does NOT forward mcpServers when no sandbox', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    const mcp = { foo: { command: 'foo', args: [] } };
    await spawnWave(
      'quality',
      '/tmp/wd',
      '/tmp/repo',
      makeConfig(),
      'msg',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // no sandbox
      undefined,
      undefined,
      undefined,
      undefined,
      mcp,
    );
    const lastCall = dispatchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).not.toHaveProperty('mcpServers');
  });

  it('clears the live registry entry after the wave completes', async () => {
    dispatchMock.mockResolvedValueOnce(makeHandoff());
    const { spawnWave } = await import('./context-builder.js');
    const clear = vi.fn();
    // Build a minimal LiveFixRegistry shape — the helper only calls `.clear`.
    const registry = {
      clear,
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      send: vi.fn(),
      kill: vi.fn(),
    } as unknown as Parameters<typeof spawnWave>[17];
    const eventBus = { publish: vi.fn(), subscribe: vi.fn(), subscribeForFix: vi.fn() } as unknown as Parameters<
      typeof spawnWave
    >[14] & { eventBus: unknown };
    await spawnWave(
      'quality', // 1: wave
      '/tmp/wd', // 2: workDir
      '/tmp/repo', // 3: repoPath
      makeConfig(), // 4: config
      'msg', // 5: userMessage
      undefined, // 6: outputFormat
      undefined, // 7: mcpHandles
      undefined, // 8: playwright
      undefined, // 9: promptsDir
      undefined, // 10: projectContext
      undefined, // 11: abTestVariant
      undefined, // 12: sandbox
      undefined, // 13: runSkills
      undefined, // 14: cacheContext
      // 15: eventContext (must be set so fixId flows to clear())
      {
        eventBus: eventBus as unknown as Parameters<typeof spawnWave>[14] extends { eventBus: infer E } ? E : never,
        runId: 'r1',
        repoId: 'owner/r',
        fixId: 'f1',
      } as Parameters<typeof spawnWave>[14],
      undefined, // 16: runtimeFactory
      undefined, // 17: resolvedMcpServers
      registry, // 18: liveFixRegistry
    );
    expect(clear).toHaveBeenCalledWith('f1');
  });
});
