// Pluggable execution-backend interface (issue #301).
//
// `SandboxBackend` is the abstraction every isolation mechanism must satisfy.
// `DockerBackend` is the historical implementation (no behavior change vs the
// pre-extraction `startSandboxContainer` / `execWaveInContainer` / `killContainer`
// helpers). `DaytonaBackend` is a serverless-persistence implementation that
// hibernates on idle and resumes on next use, preserving the workspace
// filesystem across runs.
//
// Selection is driven by `repos.yaml`'s `sandbox.backend` field (Zod-validated
// in `src/types/config.ts`). Pipeline callers go through `getSandboxBackend()`
// — they never instantiate concrete backends directly. That way new backends
// (modal, fly.io, e2b, …) can be added with a single switch-arm change here.

import type { SandboxConfig } from '../types/index.js';
import { DaytonaBackend } from './daytona-backend.js';
import { DockerBackend } from './docker-backend.js';

/** Backend names accepted in `repos.yaml`. Mirrors the Zod enum in `types/config.ts`. */
export type SandboxBackendName = 'docker' | 'daytona';

/** Input passed to `backend.start()` — repo identity, mount path, optional resource limits. */
export interface SandboxStartOpts {
  repoName: string;
  issueNumber: number;
  repoPath: string;
  config?: SandboxConfig | undefined;
}

/** Handle returned from `start()`. `containerName` is the human-readable id used in logs/cleanup. */
export interface SandboxHandle {
  containerId: string;
  containerName: string;
}

/** Wave input passed through to the backend's exec channel. Mirrors `SandboxWaveInput` in `sandbox/sandbox.ts`. */
export interface SandboxBackendWaveInput {
  wave: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  thinkingLevel?: string | undefined;
  fallbackModel?: string | undefined;
  outputSchemaName?: string | undefined;
  /**
   * Issue #306 — host-resolved MCP server config forwarded into the backend
   * workspace. The runner that the backend dispatches reconstructs and starts
   * these servers on `/workspace` so codegraph (and other path-sensitive MCP
   * servers) operate on the bind-mounted worktree without any host round-trip.
   * Omit → no MCP startup (current behavior preserved for callers that have
   * not opted in).
   */
  mcpServers?:
    | Record<string, { command: string; args?: string[] | undefined; env?: Record<string, string> | undefined }>
    | undefined;
  /**
   * Issue #306 — per-wave MCP server allowlist override. Mirrors the
   * `mcp.waves` block in repos.yaml. Omit → runner falls back to
   * `WAVE_MCP_DEFAULTS` from `src/ai/mcp.ts`.
   */
  mcpWaveOverrides?: Partial<Record<string, string[]>> | undefined;
}

/** Resource-usage snapshot returned by `getStats()`. */
export interface SandboxStats {
  memoryMB: number;
  cpuPercent: number;
}

/**
 * The contract every backend must satisfy.
 *
 * `hibernate()` / `resume()` are optional in concept (Docker has no persistence
 * model so they're no-ops) but mandatory on the interface so callers can invoke
 * them without backend-type narrowing. The Daytona/Modal/Fly backends do real
 * work here; DockerBackend just resolves.
 */
export interface SandboxBackend {
  /** Start the sandbox. Returns a handle used in logs and stop(). */
  start(opts: SandboxStartOpts): Promise<SandboxHandle>;
  /** Execute one Agent SDK wave inside the sandbox. Returns the WaveHandoff JSON. */
  execWave(input: SandboxBackendWaveInput): Promise<unknown>;
  /** Tear down the sandbox. Idempotent — calling before start() is a no-op. */
  stop(): Promise<void>;
  /** Resource-usage snapshot. Returns zeros when not started. */
  getStats(): Promise<SandboxStats>;
  /** Stop the sandbox while preserving filesystem state. No-op for non-persistent backends. */
  hibernate(): Promise<void>;
  /** Resume from hibernate. No-op for non-persistent backends. */
  resume(): Promise<void>;
}

/**
 * Resolve a backend by name. Caller-supplied names come from `repos.yaml`'s
 * `sandbox.backend` field; Zod validation rejects unknowns at config-load time
 * but we double-check here so direct internal callers also fail fast.
 *
 * Returns a fresh instance every call — backends carry per-run state
 * (workspace id, container handle) and cannot be shared across fixes.
 */
export function getSandboxBackend(name: SandboxBackendName): SandboxBackend {
  switch (name) {
    case 'docker':
      return new DockerBackend();
    case 'daytona':
      return new DaytonaBackend();
    default: {
      // Exhaustiveness check — TS narrows `name` to `never`, so any missed
      // backend name causes a compile error here. The runtime throw covers
      // callers that bypass the type (e.g. a stale repos.yaml hand-edit).
      const exhaustive: never = name;
      throw new Error(`unknown sandbox backend: ${String(exhaustive)}`);
    }
  }
}
