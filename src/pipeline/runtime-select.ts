/**
 * Pipeline-level helper for issue #407.
 *
 * The CLI, FixOptions, BrainstormOptions, etc. accept an optional
 * `runtime?: RuntimeKind` field. This module owns the resolution precedence
 * (option > config.runtime > 'pi') and the construction of the right
 * `AgentRuntimeFactory` for the resolved kind — optionally with the kova MCP
 * map already merged in for the `claude-cli` path.
 *
 * Keeping the helper here (not in `src/ai/runtime/`) means it can take a
 * dependency on `RepoConfig` without inverting the layer ordering — `pipeline`
 * already imports from `ai/`, never the reverse.
 */

import {
  type AgentRuntimeFactory,
  defaultAgentRuntimeFactory,
  type RuntimeKind,
  resolveRuntimeFactory,
  wrapClaudeCliFactoryWithMcp,
} from '../ai/runtime/index.js';
import type { MCPServerConfig } from '../types/config.js';

/**
 * Resolve the effective runtime kind for a pipeline run.
 *
 * Precedence:
 *   1. Per-invocation option (`fix({ runtime })`, `kova fix --runtime …`)
 *   2. Per-repo config (`repos.yaml runtime:`)
 *   3. Default `'pi'`
 *
 * The schema layer already guarantees `configRuntime` is a valid `RuntimeKind`
 * or undefined when the field was omitted from a fixture; the CLI parser does
 * the same for `optionRuntime`.
 */
export function resolveRuntimeKind(
  optionRuntime: RuntimeKind | undefined,
  configRuntime: RuntimeKind | undefined,
): RuntimeKind {
  return optionRuntime ?? configRuntime ?? 'pi';
}

/**
 * Build the `AgentRuntimeFactory` that `spawnWaveAgent` will receive for this
 * pipeline run. When `kind === 'claude-cli'` AND an MCP server map was
 * resolved by the caller, the factory is wrapped so every `create()` call
 * carries the map through to `ClaudeCliRuntimeConfig.mcpServers`.
 *
 * For the `pi` path the `mcpServers` arg is intentionally ignored — pi-mono
 * consumes live `MCPServerHandle` objects via the tools array, not a static
 * config map.
 */
export function buildRuntimeFactory(
  kind: RuntimeKind,
  mcpServers?: Record<string, MCPServerConfig>,
): AgentRuntimeFactory {
  if (kind === 'pi') return defaultAgentRuntimeFactory;
  const inner = resolveRuntimeFactory(kind);
  if (!mcpServers || Object.keys(mcpServers).length === 0) return inner;
  return wrapClaudeCliFactoryWithMcp(inner, mcpServers);
}
