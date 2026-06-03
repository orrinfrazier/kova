// MCP server integration — client lifecycle, tool adapter, and wave-specific tool resolution.
// Reads MCP server config from user settings (~/.claude/settings.json) and per-repo overrides.
// Spawns MCP servers as child processes via stdio transport, adapts MCP tools to AgentTool format.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { type TSchema, Type } from 'typebox';
import type { MCPConfig, MCPServerConfig } from '../types/config.js';
import { log } from '../utils/logger.js';
import { type TruncationOptions, withTruncatedResult } from './tool-result-truncate.js';
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
 *  - Reasoning waves (assess/spec/review/brainstorm) get repo-intel for code
 *    search/context AND codegraph for cheap, structured navigation
 *    (context/trace/explore/callers/callees/impact — see codegraph's MCP server).
 *    Steering these waves toward codegraph-first exploration cuts tool-call cost
 *    significantly vs re-deriving structure with grep/find each run.
 *  - Impl gets shadcn for component generation + repo-intel.
 *  - Quality/test get no MCP tools by default (they run checks and edit code,
 *    not navigate structure). Codegraph is intentionally NOT here.
 *
 *  Codegraph is consumed via stdio MCP (e.g. `codegraph serve --mcp`). If the
 *  user has not configured a `codegraph` entry in repos.yaml or settings.json,
 *  startup-time MCP resolution silently drops it and `getMCPToolsForWave` skips
 *  the missing handle — the pipeline keeps working with the remaining servers. */
export const WAVE_MCP_DEFAULTS: Record<AIWaveName, string[]> = {
  assess: ['repo-intel', 'codegraph'],
  spec: ['repo-intel', 'codegraph'],
  test: [],
  impl: ['repo-intel', 'shadcn'],
  quality: [],
  review: ['repo-intel', 'codegraph'],
  brainstorm: ['repo-intel', 'codegraph'],
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

/** Substitute `${workspaceFolder}` and `${cwd}` tokens with the supplied workDir.
 *  When workDir is undefined the input is returned unchanged so intentional shell
 *  strings like `${HOME}` are not silently swallowed by this helper.
 *  Exported for unit testing. */
export function substituteWorkDirTokens(value: string, workDir: string | undefined): string {
  if (workDir == null) return value;
  return value.replace(/\$\{workspaceFolder\}/g, workDir).replace(/\$\{cwd\}/g, workDir);
}

/** Apply token substitution across an args array. */
function substituteArgs(args: string[] | undefined, workDir: string | undefined): string[] | undefined {
  if (args == null) return args;
  if (workDir == null) return args;
  return args.map((arg) => substituteWorkDirTokens(arg, workDir));
}

/** Apply token substitution across env values. Keys are not substituted. */
function substituteEnv(
  env: Record<string, string> | undefined,
  workDir: string | undefined,
): Record<string, string> | undefined {
  if (env == null) return env;
  if (workDir == null) return env;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = substituteWorkDirTokens(v, workDir);
  }
  return result;
}

/** Start an MCP server as a child process and discover its tools.
 *
 *  When `workDir` is provided the child process is spawned with `cwd = workDir`
 *  and `${workspaceFolder}` / `${cwd}` tokens in args and env values are
 *  resolved to `workDir`. This lets path-sensitive servers (codegraph,
 *  language servers) index the per-fix worktree instead of the orchestrator's
 *  cwd. When `workDir` is undefined the child inherits the parent's cwd and
 *  template tokens are left literal (backward compatible). */
export async function startMCPServer(
  name: string,
  config: MCPServerConfig,
  workDir?: string,
): Promise<MCPServerHandle> {
  log.info(`[mcp] Starting MCP server: ${name} (${config.command})${workDir ? ` (cwd=${workDir})` : ''}`);

  const resolvedArgs = substituteArgs(config.args, workDir);
  const resolvedEnv = substituteEnv(config.env, workDir);

  const transportParams: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr: 'pipe';
    cwd?: string;
  } = { command: config.command, stderr: 'pipe' };
  if (resolvedArgs) transportParams.args = resolvedArgs;
  if (resolvedEnv) transportParams.env = { ...process.env, ...resolvedEnv } as Record<string, string>;
  if (workDir != null) transportParams.cwd = workDir;

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
 *  Servers that fail to start are logged and skipped (graceful degradation).
 *
 *  `workDir` is forwarded to each server: child processes spawn with
 *  `cwd = workDir` and `${workspaceFolder}` / `${cwd}` tokens in args/env
 *  resolve to it. This lets per-fix runs point path-sensitive servers
 *  (codegraph, language servers) at the worktree instead of the orchestrator's
 *  cwd. Omit `workDir` to preserve legacy behavior (child inherits parent cwd). */
export async function startAllMCPServers(
  servers: Record<string, MCPServerConfig>,
  workDir?: string,
): Promise<Map<string, MCPServerHandle>> {
  const handles = new Map<string, MCPServerHandle>();
  const entries = Object.entries(servers);
  if (entries.length === 0) return handles;

  const results = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      const handle = await startMCPServer(name, config, workDir);
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
 *  Tool name is prefixed with server name to avoid collisions: mcp__<server>__<tool>.
 *
 *  Issue #315 — the returned tool is wrapped with `withTruncatedResult` so MCP
 *  results respect the same token budget as built-in tools. Pass `false` to
 *  disable truncation for this tool, or a `TruncationOptions` object to
 *  override the defaults. Defaults to 8k/2k/2k (the canonical wave budget). */
export function mcpToolToAgentTool(
  serverName: string,
  mcpTool: MCPTool,
  client: Client,
  truncation?: TruncationOptions | false,
): AnyTool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;

  // Wrap MCP JSON Schema as TypeBox schema using Type.Unsafe()
  const parameters = Type.Unsafe(mcpTool.inputSchema) as TSchema;

  const inner: AnyTool = {
    name: qualifiedName,
    description: mcpTool.description ?? mcpTool.name,
    label: `[MCP:${serverName}] ${mcpTool.name}`,
    parameters,
    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> {
      const args = (params != null && typeof params === 'object' ? params : {}) as Record<string, unknown>;
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
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

  return withTruncatedResult(inner, truncation);
}

/** Get MCP-provided AgentTools for a given wave.
 *  Uses wave defaults or per-wave override from repo config.
 *
 *  Issue #315 — `truncation` is forwarded to every wrapped MCP tool so MCP
 *  results respect the wave's token budget. Omit (or pass `undefined`) for
 *  the default 8k budget; pass `false` to disable truncation; pass a
 *  `TruncationOptions` object to override head/tail/budget. */
export function getMCPToolsForWave(
  wave: AIWaveName,
  handles: Map<string, MCPServerHandle>,
  waveOverrides?: Partial<Record<AIWaveName, string[]>>,
  truncation?: TruncationOptions | false,
): AnyTool[] {
  const serverNames = waveOverrides?.[wave] ?? WAVE_MCP_DEFAULTS[wave];
  const tools: AnyTool[] = [];

  for (const serverName of serverNames) {
    const handle = handles.get(serverName);
    if (!handle) continue;
    for (const mcpTool of handle.tools) {
      tools.push(mcpToolToAgentTool(serverName, mcpTool, handle.client, truncation));
    }
  }

  return tools;
}
