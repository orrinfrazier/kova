// Tests for MCP server integration — client lifecycle, tool adapter, settings loading.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  MCP SDK module mocks — must be declared BEFORE `./mcp.js` import   */
/*  so vi.mock hoists ahead of the import resolution.                  */
/* ------------------------------------------------------------------ */

const transportCtorCalls: Array<Record<string, unknown>> = [];
const clientConnectCalls: Array<unknown> = [];

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class {
      constructor(params: Record<string, unknown>) {
        transportCtorCalls.push(params);
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class {
      async connect(transport: unknown): Promise<void> {
        clientConnectCalls.push(transport);
      }
      async listTools(): Promise<{ tools: unknown[] }> {
        return { tools: [] };
      }
      async close(): Promise<void> {
        /* noop */
      }
    },
  };
});

import {
  getMCPToolsForWave,
  loadMCPServersFromSettings,
  type MCPServerHandle,
  mcpToolToAgentTool,
  resolveMCPServers,
  startAllMCPServers,
  startMCPServer,
  WAVE_MCP_DEFAULTS,
} from './mcp.js';
import type { AIWaveName } from './wave-tools.js';

/* ------------------------------------------------------------------ */
/*  Temp directory management                                          */
/* ------------------------------------------------------------------ */

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kova-mcp-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  loadMCPServersFromSettings                                         */
/* ------------------------------------------------------------------ */

describe('loadMCPServersFromSettings', () => {
  it('loads MCP servers from a settings file', async () => {
    const settings = {
      mcpServers: {
        'repo-intel': {
          command: 'npx',
          args: ['-y', '@anthropic-ai/repo-intel-mcp'],
        },
        shadcn: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/shadcn-mcp'],
          env: { SHADCN_KEY: 'test123' },
        },
      },
    };
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(settings));

    const servers = await loadMCPServersFromSettings(settingsPath);

    expect(servers).toBeDefined();
    expect(Object.keys(servers)).toHaveLength(2);
    expect(servers['repo-intel']).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic-ai/repo-intel-mcp'],
    });
    expect(servers.shadcn).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic-ai/shadcn-mcp'],
      env: { SHADCN_KEY: 'test123' },
    });
  });

  it('returns empty object when settings file does not exist', async () => {
    const servers = await loadMCPServersFromSettings(join(tempDir, 'nonexistent.json'));
    expect(servers).toEqual({});
  });

  it('returns empty object when mcpServers key is missing', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }));

    const servers = await loadMCPServersFromSettings(settingsPath);
    expect(servers).toEqual({});
  });

  it('returns empty object when settings file is invalid JSON', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(settingsPath, '{not valid json');

    const servers = await loadMCPServersFromSettings(settingsPath);
    expect(servers).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  resolveMCPServers                                                  */
/* ------------------------------------------------------------------ */

describe('resolveMCPServers', () => {
  it('returns user settings servers when no repo config override', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          'repo-intel': { command: 'npx', args: ['-y', 'repo-intel'] },
        },
      }),
    );

    const servers = await resolveMCPServers(undefined, settingsPath);
    expect(servers['repo-intel']).toBeDefined();
  });

  it('repo config servers override user settings servers with same name', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          'repo-intel': { command: 'npx', args: ['-y', 'repo-intel'] },
        },
      }),
    );

    const repoMcp = {
      servers: {
        'repo-intel': { command: 'node', args: ['./custom-server.js'] },
      },
    };

    const servers = await resolveMCPServers(repoMcp, settingsPath);
    expect(servers['repo-intel']?.command).toBe('node');
    expect(servers['repo-intel']?.args).toEqual(['./custom-server.js']);
  });

  it('merges user settings and repo config servers', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          'repo-intel': { command: 'npx', args: ['-y', 'repo-intel'] },
        },
      }),
    );

    const repoMcp = {
      servers: {
        shadcn: { command: 'npx', args: ['-y', 'shadcn-mcp'] },
      },
    };

    const servers = await resolveMCPServers(repoMcp, settingsPath);
    expect(Object.keys(servers)).toHaveLength(2);
    expect(servers['repo-intel']).toBeDefined();
    expect(servers.shadcn).toBeDefined();
  });

  it('returns empty when neither settings nor repo config has servers', async () => {
    const servers = await resolveMCPServers(undefined, join(tempDir, 'nonexistent.json'));
    expect(servers).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  mcpToolToAgentTool                                                 */
/* ------------------------------------------------------------------ */

describe('mcpToolToAgentTool', () => {
  const mockClient = {
    callTool: vi.fn(),
  };

  beforeEach(() => {
    mockClient.callTool.mockReset();
  });

  it('converts an MCP tool to AgentTool format', () => {
    const mcpTool = {
      name: 'search_code',
      description: 'Search code in the repository',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    };

    const agentTool = mcpToolToAgentTool('repo-intel', mcpTool, mockClient as never);

    expect(agentTool.name).toBe('mcp__repo-intel__search_code');
    expect(agentTool.description).toBe('Search code in the repository');
    expect(agentTool.label).toBe('[MCP:repo-intel] search_code');
    expect(agentTool.parameters).toBeDefined();
  });

  it('uses tool name as description when description is missing', () => {
    const mcpTool = {
      name: 'list_files',
      inputSchema: { type: 'object' as const },
    };

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never);
    expect(agentTool.description).toBe('list_files');
  });

  it('execute() calls MCP client.callTool and returns text content', async () => {
    const mcpTool = {
      name: 'search',
      description: 'Search',
      inputSchema: { type: 'object' as const },
    };

    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Found 3 results' }],
    });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never);
    const result = await agentTool.execute('call-1', { query: 'test' });

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { query: 'test' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Found 3 results' }]);
  });

  it('execute() handles MCP error responses', async () => {
    const mcpTool = {
      name: 'fail',
      description: 'Fails',
      inputSchema: { type: 'object' as const },
    };

    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Error: not found' }],
      isError: true,
    });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never);

    await expect(agentTool.execute('call-2', {})).rejects.toThrow('MCP tool server/fail failed: Error: not found');
  });

  it('execute() handles empty content', async () => {
    const mcpTool = {
      name: 'empty',
      description: 'Returns empty',
      inputSchema: { type: 'object' as const },
    };

    mockClient.callTool.mockResolvedValue({ content: [] });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never);
    const result = await agentTool.execute('call-3', {});

    expect(result.content).toEqual([{ type: 'text', text: '(no output)' }]);
  });

  // Issue #315 — MCP results go through the runtime-agnostic truncation
  // primitive (`withTruncatedResult`) so MCP truncation is symmetric with
  // built-in tools and survives a swap away from pi-agent-core's
  // `afterToolCall` hook.
  it('execute() truncates large MCP results to the configured token budget', async () => {
    const mcpTool = {
      name: 'big-grep',
      description: 'Returns a large blob',
      inputSchema: { type: 'object' as const },
    };

    const largeText = 'x'.repeat(200_000); // ≈ 50k tokens, well over the 8k default
    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: largeText }],
    });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never);
    const result = await agentTool.execute('call-big', {});

    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text.length).toBeLessThan(largeText.length);
    expect(block.text).toContain('[middle truncated');
  });

  it('execute() honors a custom truncation budget when passed', async () => {
    const mcpTool = {
      name: 'big-grep',
      description: 'Returns a large blob',
      inputSchema: { type: 'object' as const },
    };

    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(800) }],
    });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never, {
      tokenBudget: 50,
      headTokens: 10,
      tailTokens: 10,
    });
    const result = await agentTool.execute('call-budget', {});

    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text.length).toBeLessThan(800);
    expect(block.text).toContain('[middle truncated');
  });

  it('execute() passes results through unchanged when truncation is disabled', async () => {
    const mcpTool = {
      name: 'big-grep',
      description: 'Returns a large blob',
      inputSchema: { type: 'object' as const },
    };

    const largeText = 'x'.repeat(200_000);
    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: largeText }],
    });

    const agentTool = mcpToolToAgentTool('server', mcpTool, mockClient as never, false);
    const result = await agentTool.execute('call-untruncated', {});

    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe(largeText);
  });
});

/* ------------------------------------------------------------------ */
/*  WAVE_MCP_DEFAULTS                                                  */
/* ------------------------------------------------------------------ */

describe('WAVE_MCP_DEFAULTS', () => {
  it('defines default MCP server sets for all AI waves', () => {
    const waves: AIWaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'brainstorm'];
    for (const wave of waves) {
      expect(WAVE_MCP_DEFAULTS[wave]).toBeDefined();
      expect(Array.isArray(WAVE_MCP_DEFAULTS[wave])).toBe(true);
    }
  });

  it('read-only waves include repo-intel for code search', () => {
    expect(WAVE_MCP_DEFAULTS.assess).toContain('repo-intel');
    expect(WAVE_MCP_DEFAULTS.spec).toContain('repo-intel');
    expect(WAVE_MCP_DEFAULTS.review).toContain('repo-intel');
    expect(WAVE_MCP_DEFAULTS.brainstorm).toContain('repo-intel');
  });

  it('impl wave includes shadcn for component generation', () => {
    expect(WAVE_MCP_DEFAULTS.impl).toContain('shadcn');
  });

  it('reasoning waves include codegraph for cheap structural context', () => {
    // codegraph exposes read-only structural tools (context/trace/explore/callers/...)
    // — much cheaper than re-grepping the repo. It belongs in the 4 reasoning waves.
    expect(WAVE_MCP_DEFAULTS.assess).toContain('codegraph');
    expect(WAVE_MCP_DEFAULTS.spec).toContain('codegraph');
    expect(WAVE_MCP_DEFAULTS.review).toContain('codegraph');
    expect(WAVE_MCP_DEFAULTS.brainstorm).toContain('codegraph');
  });

  it('execution waves (test/impl/quality) do NOT include codegraph', () => {
    // codegraph is for reasoning, not execution — test/impl/quality run checks
    // and edit code, not navigate structure.
    expect(WAVE_MCP_DEFAULTS.test).not.toContain('codegraph');
    expect(WAVE_MCP_DEFAULTS.impl).not.toContain('codegraph');
    expect(WAVE_MCP_DEFAULTS.quality).not.toContain('codegraph');
  });
});

/* ------------------------------------------------------------------ */
/*  getMCPToolsForWave                                                 */
/* ------------------------------------------------------------------ */

describe('getMCPToolsForWave', () => {
  const mockHandle = (name: string, toolNames: string[]): MCPServerHandle => ({
    name,
    client: {} as never,
    transport: {} as never,
    tools: toolNames.map((t) => ({
      name: t,
      description: `${t} tool`,
      inputSchema: { type: 'object' as const },
    })),
  });

  it('returns MCP tools for servers assigned to the wave', () => {
    const handles = new Map<string, MCPServerHandle>();
    handles.set('repo-intel', mockHandle('repo-intel', ['search', 'context']));

    const tools = getMCPToolsForWave('assess', handles);
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).toEqual(['mcp__repo-intel__search', 'mcp__repo-intel__context']);
  });

  it('returns empty array when no handles match the wave defaults', () => {
    const handles = new Map<string, MCPServerHandle>();
    handles.set('custom-server', mockHandle('custom-server', ['custom_tool']));

    const tools = getMCPToolsForWave('assess', handles);
    expect(tools.length).toBe(0);
  });

  it('uses per-wave override from repo config', () => {
    const handles = new Map<string, MCPServerHandle>();
    handles.set('custom', mockHandle('custom', ['custom_tool']));
    handles.set('repo-intel', mockHandle('repo-intel', ['search']));

    const waveOverride: Partial<Record<AIWaveName, string[]>> = {
      assess: ['custom'],
    };

    const tools = getMCPToolsForWave('assess', handles, waveOverride);
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe('mcp__custom__custom_tool');
  });

  it('returns empty array when handles map is empty', () => {
    const handles = new Map<string, MCPServerHandle>();
    const tools = getMCPToolsForWave('spec', handles);
    expect(tools.length).toBe(0);
  });

  it('skips servers that are in defaults but not in handles', () => {
    const handles = new Map<string, MCPServerHandle>();
    // repo-intel is in defaults for assess but not in handles
    const tools = getMCPToolsForWave('assess', handles);
    expect(tools.length).toBe(0);
  });

  it('reasoning wave still works when codegraph handle is absent (graceful degradation)', () => {
    // codegraph is in WAVE_MCP_DEFAULTS for assess, but only repo-intel is running.
    // Pipeline must keep working — codegraph is dropped silently, repo-intel tools surface.
    const handles = new Map<string, MCPServerHandle>();
    handles.set('repo-intel', mockHandle('repo-intel', ['search', 'context']));
    // Intentionally NOT registering 'codegraph' — simulating "codegraph not installed"

    const tools = getMCPToolsForWave('assess', handles);
    // Should return only the repo-intel tools; no error thrown.
    expect(tools.map((t) => t.name)).toEqual(['mcp__repo-intel__search', 'mcp__repo-intel__context']);
  });
});

/* ------------------------------------------------------------------ */
/*  startMCPServer — workDir threading (issue #270)                    */
/*                                                                     */
/*  Literal ${workspaceFolder} / ${cwd} tokens in the string literals  */
/*  below are intentional — they're the fixtures the substitution      */
/*  helper consumes. Biome's noTemplateCurlyInString check is disabled */
/*  for this section to keep them readable as fixtures.                */
/* ------------------------------------------------------------------ */

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: intentional template-token fixtures for substitution tests
describe('startMCPServer — workDir threading', () => {
  beforeEach(() => {
    transportCtorCalls.length = 0;
    clientConnectCalls.length = 0;
  });

  it('passes cwd to StdioClientTransport when workDir is provided', async () => {
    await startMCPServer('codegraph', { command: 'codegraph', args: ['serve', '--mcp'] }, '/tmp/worktree-A');

    expect(transportCtorCalls.length).toBe(1);
    expect(transportCtorCalls[0]?.cwd).toBe('/tmp/worktree-A');
  });

  it('omits cwd from StdioClientTransport when workDir is undefined (backward compat)', async () => {
    await startMCPServer('repo-intel', { command: 'npx', args: ['-y', 'repo-intel'] });

    expect(transportCtorCalls.length).toBe(1);
    expect(transportCtorCalls[0]?.cwd).toBeUndefined();
  });

  it('substitutes ${workspaceFolder} in args when workDir is provided', async () => {
    await startMCPServer(
      'codegraph',
      { command: 'codegraph', args: ['serve', '--mcp', '--path', '${workspaceFolder}'] },
      '/tmp/worktree-B',
    );

    expect(transportCtorCalls[0]?.args).toEqual(['serve', '--mcp', '--path', '/tmp/worktree-B']);
  });

  it('substitutes ${cwd} in args when workDir is provided', async () => {
    await startMCPServer('svr', { command: 'node', args: ['index.js', '--root', '${cwd}'] }, '/tmp/worktree-C');

    expect(transportCtorCalls[0]?.args).toEqual(['index.js', '--root', '/tmp/worktree-C']);
  });

  it('substitutes ${workspaceFolder} in env values when workDir is provided', async () => {
    await startMCPServer(
      'svr',
      {
        command: 'node',
        args: ['index.js'],
        env: { PROJECT_ROOT: '${workspaceFolder}', UNRELATED: 'static-value' },
      },
      '/tmp/worktree-D',
    );

    const params = transportCtorCalls[0] as { env: Record<string, string> };
    expect(params.env.PROJECT_ROOT).toBe('/tmp/worktree-D');
    expect(params.env.UNRELATED).toBe('static-value');
  });

  it('keeps tokens literal when workDir is undefined (no substitution)', async () => {
    // Tokens stay literal — avoids silently swallowing intentional ${VAR} shell strings.
    await startMCPServer('svr', {
      command: 'node',
      args: ['index.js', '--root', '${workspaceFolder}'],
    });

    expect(transportCtorCalls[0]?.args).toEqual(['index.js', '--root', '${workspaceFolder}']);
  });

  it('concurrent calls with different workDirs each pass their own cwd', async () => {
    // Acceptance criterion: "Concurrent/multi-repo fixes each point at their own worktree"
    await Promise.all([
      startMCPServer('codegraph', { command: 'codegraph', args: ['serve'] }, '/tmp/wt-alpha'),
      startMCPServer('codegraph', { command: 'codegraph', args: ['serve'] }, '/tmp/wt-beta'),
    ]);

    expect(transportCtorCalls.length).toBe(2);
    const cwds = transportCtorCalls.map((p) => p.cwd).sort();
    expect(cwds).toEqual(['/tmp/wt-alpha', '/tmp/wt-beta']);
  });

  it('startAllMCPServers forwards workDir to each StdioClientTransport', async () => {
    await startAllMCPServers(
      {
        codegraph: { command: 'codegraph', args: ['serve', '--mcp', '--path', '${workspaceFolder}'] },
        'repo-intel': { command: 'npx', args: ['-y', 'repo-intel'] },
      },
      '/tmp/worktree-E',
    );

    expect(transportCtorCalls.length).toBe(2);
    for (const params of transportCtorCalls) {
      expect(params.cwd).toBe('/tmp/worktree-E');
    }
    // codegraph args got templated
    const codegraphCall = transportCtorCalls.find((p) => (p as { command: string }).command === 'codegraph');
    expect(codegraphCall?.args).toEqual(['serve', '--mcp', '--path', '/tmp/worktree-E']);
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: intentional template-token fixtures for substitution tests
