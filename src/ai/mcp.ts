// MCP server integration — client lifecycle, tool adapter, and wave-specific tool resolution.
// Reads MCP server config from user settings (~/.claude/settings.json) and per-repo overrides.
// Spawns MCP servers as child processes via stdio transport, adapts MCP tools to AgentTool format.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { type TSchema, Type } from '@sinclair/typebox';
import type { MCPConfig, MCPServerConfig } from '../types/config.js';
import { log } from '../utils/logger.js';
import type { AIWaveName } from './wave-tools.js';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

/** A running MCP server with its client, transport, and discovered tools. */
export interface MCPServerHandle {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: MCPTool[];
}

/** Default MCP server assignment per wave.
 *  - Read-only waves get repo-intel for code search/context.
 *  - Impl gets shadcn for component generation + repo-intel.
 *  - Quality/test get no MCP tools by default (they run checks). */
export const WAVE_MCP_DEFAULTS: Record<AIWaveName, string[]> = {
  assess: ['repo-intel'],
  spec: ['repo-intel'],
  test: [],
  impl: ['repo-intel', 'shadcn'],
  quality: [],
  review: ['repo-intel'],
  brainstorm: ['repo-intel'],
};

/** Default path to Claude Code user settings. */
const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Load MCP server configs from a Claude Code settings.json file.
 *  Returns empty object if file doesn't exist or is malformed. */
export async function loadMCPServersFromSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): Promise<Record<string, MCPServerConfig>> {
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = settings.mcpServers;
    if (mcpServers == null || typeof mcpServers !== 'object') return {};
    // Validate each entry has at minimum a command string
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, config] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (config != null && typeof config === 'object' && 'command' in config && typeof config.command === 'string') {
        const entry = config as { command: string; args?: string[]; env?: Record<string, string> };
        result[name] = {
          command: entry.command,
          ...(entry.args != null && { args: entry.args }),
          ...(entry.env != null && { env: entry.env }),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Resolve MCP servers from user settings + per-repo config override.
 *  Per-repo config overrides user settings for servers with the same name. */
export async function resolveMCPServers(
  repoMcp: MCPConfig | undefined,
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): Promise<Record<string, MCPServerConfig>> {
  const userServers = await loadMCPServersFromSettings(settingsPath);
  const repoServers = repoMcp?.servers ?? {};
  // Repo config overrides user settings for same-named servers
  return { ...userServers, ...repoServers };
}

/** Start an MCP server as a child process and discover its tools.
 *  Returns a handle for tool execution and lifecycle management. */
export async function startMCPServer(name: string, config: MCPServerConfig): Promise<MCPServerHandle> {
  log.info(`[mcp] Starting MCP server: ${name} (${config.command})`);

  const transportParams: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr: 'pipe';
  } = { command: config.command, stderr: 'pipe' };
  if (config.args) transportParams.args = config.args;
  if (config.env) transportParams.env = { ...process.env, ...config.env } as Record<string, string>;

  const transport = new StdioClientTransport(transportParams);

  const client = new Client({ name: `kova-${name}`, version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  log.info(`[mcp] Server ${name} ready — ${tools.length} tools available`);

  return { name, client, transport, tools };
}

/** Stop an MCP server gracefully. */
export async function stopMCPServer(handle: MCPServerHandle): Promise<void> {
  log.info(`[mcp] Stopping MCP server: ${handle.name}`);
  try {
    await handle.client.close();
  } catch (error) {
    log.warn(`[mcp] Error closing server ${handle.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Start all resolved MCP servers. Returns a map of name → handle.
 *  Servers that fail to start are logged and skipped (graceful degradation). */
export async function startAllMCPServers(
  servers: Record<string, MCPServerConfig>,
): Promise<Map<string, MCPServerHandle>> {
  const handles = new Map<string, MCPServerHandle>();
  const entries = Object.entries(servers);
  if (entries.length === 0) return handles;

  const results = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      const handle = await startMCPServer(name, config);
      return { name, handle };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      handles.set(result.value.name, result.value.handle);
    } else {
      log.warn(
        `[mcp] Failed to start MCP server: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  return handles;
}

/** Stop all running MCP servers. */
export async function stopAllMCPServers(handles: Map<string, MCPServerHandle>): Promise<void> {
  await Promise.allSettled([...handles.values()].map(stopMCPServer));
  handles.clear();
}

/** Convert an MCP tool to a pi-agent-core AgentTool.
 *  Tool name is prefixed with server name to avoid collisions: mcp__<server>__<tool>. */
export function mcpToolToAgentTool(serverName: string, mcpTool: MCPTool, client: Client): AnyTool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;

  // Wrap MCP JSON Schema as TypeBox schema using Type.Unsafe()
  const parameters = Type.Unsafe(mcpTool.inputSchema) as TSchema;

  return {
    name: qualifiedName,
    description: mcpTool.description ?? mcpTool.name,
    label: `[MCP:${serverName}] ${mcpTool.name}`,
    parameters,
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: params,
      });

      const resultContent = Array.isArray(result.content) ? result.content : [];

      // Check for MCP-level errors
      if (result.isError) {
        const errorText =
          resultContent
            .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('\n') || 'Unknown error';
        throw new Error(`MCP tool ${serverName}/${mcpTool.name} failed: ${errorText}`);
      }

      // Convert MCP content to AgentToolResult content
      const content = resultContent
        .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c: { text: string }) => ({ type: 'text' as const, text: c.text }));

      return {
        content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }],
        details: undefined,
      };
    },
  };
}

/** Get MCP-provided AgentTools for a given wave.
 *  Uses wave defaults or per-wave override from repo config. */
export function getMCPToolsForWave(
  wave: AIWaveName,
  handles: Map<string, MCPServerHandle>,
  waveOverrides?: Partial<Record<AIWaveName, string[]>>,
): AnyTool[] {
  const serverNames = waveOverrides?.[wave] ?? WAVE_MCP_DEFAULTS[wave];
  const tools: AnyTool[] = [];

  for (const serverName of serverNames) {
    const handle = handles.get(serverName);
    if (!handle) continue;
    for (const mcpTool of handle.tools) {
      tools.push(mcpToolToAgentTool(serverName, mcpTool, handle.client));
    }
  }

  return tools;
}
