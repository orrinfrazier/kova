// In-container MCP bootstrap for the sandbox runner (issue #306).
//
// Sandboxed waves (docker isolation with `restrict_network: true`) cannot
// reach host MCP servers — the container has `--network none`. The host
// orchestrator forwards the resolved `mcpServers` map across the docker-exec
// boundary; this module is the runner-side counterpart that starts those
// servers locally on `/workspace`, builds wave tools that include the MCP
// tools, and exposes a `stop()` to tear servers down in `finally`.
//
// Why a separate module: `run-wave.ts` is a CLI entrypoint (`#!/usr/bin/env
// node` + `process.argv[2]` read at import). It is intentionally too thin to
// test as a unit. This helper is a pure function from
// `(servers, waveOverrides, wave, cwd) -> { tools, stop }` so it can be tested
// without spawning the CLI.

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { getMCPToolsForWave, type MCPServerHandle, startAllMCPServers, stopAllMCPServers } from '../ai/mcp.js';
import type { AIWaveName } from '../ai/wave-tools.js';
import type { MCPServerConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

// biome-ignore lint/suspicious/noExplicitAny: pi-mono AgentTool uses any for tool parameter schemas
type AnyTool = AgentTool<any>;

export interface BootstrapMCPInput {
  wave: AIWaveName;
  cwd: string;
  /** Host-resolved MCP server config forwarded via SandboxWaveInput. */
  mcpServers?: Record<string, MCPServerConfig> | undefined;
  /** Per-wave MCP server allowlist override forwarded from the host. */
  mcpWaveOverrides?: Partial<Record<AIWaveName, string[]>> | undefined;
}

export interface BootstrapMCPResult {
  /** MCP-derived AgentTools to merge into the wave tool surface. */
  tools: AnyTool[];
  /** Tear down any started MCP servers. Always safe to call (idempotent / noop on no startup). */
  stop: () => Promise<void>;
}

const NOOP_RESULT: BootstrapMCPResult = {
  tools: [],
  stop: async () => {
    /* no servers started */
  },
};

/**
 * Start MCP servers inside the sandbox (if any were forwarded) and return the
 * tools + a teardown function.
 *
 * Graceful degradation paths (acceptance criterion 4 of #306):
 * - `mcpServers` undefined / empty → return empty tools + noop stop (no
 *   behavior change for callers that haven't opted in).
 * - `startAllMCPServers` throws → log and return empty tools + noop stop so
 *   the wave proceeds with read/grep instead of crashing the runner.
 * - Individual MCP server failures inside `startAllMCPServers` are already
 *   absorbed by its `Promise.allSettled` semantics (see `src/ai/mcp.ts`).
 */
export async function bootstrapMCPForWave(input: BootstrapMCPInput): Promise<BootstrapMCPResult> {
  const { wave, cwd, mcpServers, mcpWaveOverrides } = input;

  if (mcpServers == null || Object.keys(mcpServers).length === 0) {
    return NOOP_RESULT;
  }

  let handles: Map<string, MCPServerHandle>;
  try {
    handles = await startAllMCPServers(mcpServers, cwd);
  } catch (err) {
    // startAllMCPServers itself is wrapped in allSettled internally so this
    // should be rare — defensive against the SDK throwing synchronously.
    log.warn(
      `[sandbox-mcp] MCP startup failed entirely — degrading to read/grep tools: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NOOP_RESULT;
  }

  const tools = getMCPToolsForWave(wave, handles, mcpWaveOverrides);
  log.info(
    `[sandbox-mcp] ${handles.size} MCP server(s) running in sandbox (cwd=${cwd}); ${tools.length} tool(s) exposed for wave '${wave}'`,
  );

  return {
    tools,
    stop: async () => {
      try {
        await stopAllMCPServers(handles);
      } catch (err) {
        log.warn(`[sandbox-mcp] Error stopping MCP servers: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
