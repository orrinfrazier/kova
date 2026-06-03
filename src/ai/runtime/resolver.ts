/**
 * Runtime kind resolver (issue #407).
 *
 * Translates a string-typed `RuntimeKind` ("pi" | "claude-cli") into the
 * matching `AgentRuntimeFactory` so the pipeline can pick a runtime at
 * configure-time without `if/else` chains at every spawn call site.
 *
 * IMPORTANT: in-process `AgentTool[]` implementations supplied via
 * `SpawnWaveAgentConfig.tools` are pi-mono-only. The claude-cli runtime only
 * sees the static allowlist + MCP server map — that's a hard property of the
 * CLI subprocess design, not a kova choice. When `kind === 'claude-cli'`,
 * callers must surface tool surfaces via MCP. See `wrapClaudeCliFactoryWithMcp`
 * for the well-scoped seam.
 */

import type { MCPServerConfig } from '../../types/config.js';
import type { ClaudeCliRuntimeConfig } from './claude-cli-runtime.js';
import { claudeCliRuntimeFactory } from './claude-cli-runtime.js';
import { defaultAgentRuntimeFactory } from './pi-agent-runtime.js';
import type { AgentRuntimeConfig, AgentRuntimeFactory } from './types.js';

/**
 * The two runtimes kova currently knows how to drive end-to-end.
 *
 * Adding a new entry here means:
 *   - exporting the factory from this directory
 *   - extending `resolveRuntimeFactory` below
 *   - extending `RepoConfigSchema.runtime` in `src/types/config.ts`
 *   - extending the `--runtime` CLI option in `src/cli/index.ts`
 */
export const RUNTIME_KINDS = ['pi', 'claude-cli'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/**
 * Map a `RuntimeKind` string to the matching `AgentRuntimeFactory`.
 *
 * Throws on unknown values — the schema layer (`RepoConfigSchema.runtime`) and
 * the CLI parser already enforce the enum at I/O boundaries, so reaching this
 * branch means a programming error in an internal caller.
 */
export function resolveRuntimeFactory(kind: RuntimeKind): AgentRuntimeFactory {
  switch (kind) {
    case 'pi':
      return defaultAgentRuntimeFactory;
    case 'claude-cli':
      return claudeCliRuntimeFactory;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown runtime kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * MCP server map in the shape the claude-cli runtime accepts. We accept the
 * full kova `MCPServerConfig` (which is a superset — `command + args? + env?`)
 * because the wrapper just forwards the map without inspection.
 */
type ClaudeCliMcpMap = NonNullable<ClaudeCliRuntimeConfig['mcpServers']>;

/**
 * Wrap an `AgentRuntimeFactory` so every `create()` call carries the supplied
 * MCP server map through to the claude-cli adapter via
 * `ClaudeCliRuntimeConfig.mcpServers`.
 *
 * Why a wrapper instead of an extra config field on `SpawnWaveAgentConfig`:
 * `mcpServers` is claude-cli-specific (pi-mono uses live `MCPServerHandle`
 * objects, not a static config map). Pushing it into the cross-runtime config
 * type would couple the kova interface to a CLI quirk. Keeping it as a
 * factory-level concern means the pi path stays untouched and the wrap is a
 * one-line opt-in at the resolution layer.
 *
 * Precedence: a caller that passes its own `mcpServers` in the spawn config
 * wins. The wrapper only fills the field when the caller didn't.
 */
export function wrapClaudeCliFactoryWithMcp(
  inner: AgentRuntimeFactory,
  mcpServers: Record<string, MCPServerConfig> | ClaudeCliMcpMap,
): AgentRuntimeFactory {
  return {
    create(config: AgentRuntimeConfig) {
      // The kova `AgentRuntimeConfig` does not declare `mcpServers` (it's a
      // claude-cli extension). The claude-cli factory tolerates extra fields,
      // so we widen, merge, and pass straight through.
      const widened = config as AgentRuntimeConfig & { mcpServers?: ClaudeCliMcpMap };
      const merged: AgentRuntimeConfig & { mcpServers?: ClaudeCliMcpMap } = {
        ...widened,
        // Caller's explicit map wins over the resolved one.
        mcpServers: widened.mcpServers ?? (mcpServers as ClaudeCliMcpMap),
      };
      return inner.create(merged);
    },
  };
}
