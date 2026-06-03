// Tests for the sandbox runner's in-container MCP bootstrap (issue #306).
//
// The runner inside the sandbox must reconstruct MCP servers from the host-
// forwarded `mcpServers` map, start them, build wave tools that include the
// MCP-derived tools, and tear servers down in finally regardless of how the
// wave terminates. When no `mcpServers` map is supplied the runner must
// preserve the prior behavior (no MCP startup, no MCP tools).
//
// We test the orchestrating helper `bootstrapMCPForWave` directly. The CLI
// entrypoint (`main`) is too thin to test as a unit — it reads `process.argv`
// and writes to `process.stdout` — but the helper is a pure function from
// (servers, waveOverrides, wave, cwd) → { tools, stop }.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the MCP module BEFORE importing run-wave-mcp.
vi.mock('../ai/mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/mcp.js')>();
  return {
    ...actual,
    startAllMCPServers: vi.fn(),
    stopAllMCPServers: vi.fn(),
    getMCPToolsForWave: vi.fn(),
  };
});

import { getMCPToolsForWave, startAllMCPServers, stopAllMCPServers } from '../ai/mcp.js';
import { bootstrapMCPForWave } from './run-wave-mcp.js';

const mockStart = vi.mocked(startAllMCPServers);
const mockStop = vi.mocked(stopAllMCPServers);
const mockGetTools = vi.mocked(getMCPToolsForWave);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('bootstrapMCPForWave', () => {
  it('returns empty tools and noop stop when servers map is undefined', async () => {
    const result = await bootstrapMCPForWave({
      wave: 'assess',
      cwd: '/workspace',
    });

    expect(result.tools).toEqual([]);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockGetTools).not.toHaveBeenCalled();

    // stop() is still a callable noop so callers can finally{} it unconditionally
    await result.stop();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('returns empty tools and noop stop when servers map is empty', async () => {
    const result = await bootstrapMCPForWave({
      wave: 'assess',
      cwd: '/workspace',
      mcpServers: {},
    });

    expect(result.tools).toEqual([]);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockGetTools).not.toHaveBeenCalled();
  });

  it('starts servers with cwd=/workspace and forwards wave overrides to getMCPToolsForWave', async () => {
    const handles = new Map();
    mockStart.mockResolvedValue(handles);
    mockGetTools.mockReturnValue([{ name: 'mcp__codegraph__find_symbol' } as never]);

    const servers = {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
    };
    const overrides = { assess: ['codegraph'] };

    const result = await bootstrapMCPForWave({
      wave: 'assess',
      cwd: '/workspace',
      mcpServers: servers,
      mcpWaveOverrides: overrides,
    });

    // startAllMCPServers must be called with the servers map AND the
    // in-container cwd, so path-sensitive servers (codegraph) index the right
    // directory.
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(servers, '/workspace');
    expect(mockGetTools).toHaveBeenCalledWith('assess', handles, overrides);
    expect(result.tools).toHaveLength(1);
  });

  it('passes undefined overrides through to getMCPToolsForWave when none supplied', async () => {
    const handles = new Map();
    mockStart.mockResolvedValue(handles);
    mockGetTools.mockReturnValue([]);

    await bootstrapMCPForWave({
      wave: 'spec',
      cwd: '/workspace',
      mcpServers: { foo: { command: 'foo' } },
    });

    expect(mockGetTools).toHaveBeenCalledWith('spec', handles, undefined);
  });

  it('stop() forwards handles to stopAllMCPServers when servers were started', async () => {
    const handles = new Map();
    mockStart.mockResolvedValue(handles);
    mockGetTools.mockReturnValue([]);
    mockStop.mockResolvedValue();

    const result = await bootstrapMCPForWave({
      wave: 'review',
      cwd: '/workspace',
      mcpServers: { foo: { command: 'foo' } },
    });

    await result.stop();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith(handles);
  });

  it('does not throw when startAllMCPServers throws — degrades to empty tools', async () => {
    // Acceptance criterion 4: "codegraph absent in-container -> degrade to
    // read/grep without error". If startup itself blows up (e.g. the binary
    // is missing entirely and the SDK throws synchronously), the wave still
    // proceeds with an empty MCP tool surface rather than crashing.
    mockStart.mockRejectedValue(new Error('codegraph binary not found'));

    const result = await bootstrapMCPForWave({
      wave: 'assess',
      cwd: '/workspace',
      mcpServers: { codegraph: { command: 'codegraph' } },
    });

    expect(result.tools).toEqual([]);
    // stop() should be safe to call even though startup failed.
    await expect(result.stop()).resolves.toBeUndefined();
  });
});
