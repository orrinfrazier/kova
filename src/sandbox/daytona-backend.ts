// DaytonaBackend — serverless-persistence sandbox (issue #301).
//
// Daytona (https://daytona.io) offers a workspace abstraction with stop-on-idle
// hibernation: the container's filesystem is snapshotted and the runtime is
// freed, so an idle workspace costs ~nothing while preserving state for the
// next resume. This backend wires that semantics behind the `SandboxBackend`
// interface so the pipeline can use it as a drop-in for `DockerBackend`.
//
// Network shape: every call goes through an injectable `DaytonaHttpClient` so
// tests assert URL + body without real network. Integration tests (gated on
// `DAYTONA_API_TOKEN` being set) hit the real API.

import type { SandboxConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import type {
  SandboxBackend,
  SandboxBackendWaveInput,
  SandboxHandle,
  SandboxStartOpts,
  SandboxStats,
} from './backend.js';

/** Injectable HTTP shim — keeps real network out of unit tests. */
export type DaytonaHttpClient = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => Promise<unknown>;

export interface DaytonaBackendOptions {
  /** Base URL for the Daytona REST API. Defaults to the public endpoint. */
  apiBase?: string;
  /** Injectable HTTP client (default uses `fetch`). Tests pass a mock. */
  httpClient?: DaytonaHttpClient;
}

interface WorkspaceState {
  id: string;
  containerName: string;
  snapshotKey: string;
  repoPath: string;
}

const DEFAULT_API_BASE = 'https://api.daytona.io/v1';

/**
 * Derive a stable snapshot key from repo + issue identity. Re-running the same
 * fix later resolves to the same workspace and resumes the same filesystem.
 */
function snapshotKeyFor(repoName: string, issueNumber: number): string {
  const sanitised = repoName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `kova-${sanitised}-${issueNumber}`;
}

/** Default HTTP client: uses global `fetch` with the API token from env. */
function defaultHttpClient(apiBase: string): DaytonaHttpClient {
  return async (method, url, body) => {
    const token = process.env.DAYTONA_API_TOKEN;
    if (token == null || token.length === 0) {
      throw new Error('DaytonaBackend: DAYTONA_API_TOKEN env var is not set');
    }
    const full = url.startsWith('http') ? url : `${apiBase}${url}`;
    const res = await fetch(full, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body != null && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      throw new Error(`Daytona API ${method} ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  };
}

export class DaytonaBackend implements SandboxBackend {
  private readonly apiBase: string;
  private readonly httpClient: DaytonaHttpClient;
  private state: WorkspaceState | undefined;

  constructor(options: DaytonaBackendOptions = {}) {
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.httpClient = options.httpClient ?? defaultHttpClient(this.apiBase);
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    if (process.env.DAYTONA_API_TOKEN == null || process.env.DAYTONA_API_TOKEN.length === 0) {
      throw new Error('DaytonaBackend.start: DAYTONA_API_TOKEN env var is not set');
    }
    const snapshotKey = snapshotKeyFor(opts.repoName, opts.issueNumber);
    const containerName = snapshotKey;
    const resourceCfg = opts.config ?? ({} as SandboxConfig);

    const created = (await this.httpClient('POST', '/workspaces', {
      snapshot: snapshotKey,
      name: containerName,
      // Forward resource hints — Daytona uses these to size the runtime when resumed.
      cpus: resourceCfg.cpus,
      memory: resourceCfg.memory,
      image: resourceCfg.image,
      repoPath: opts.repoPath,
    })) as { id?: string };

    if (typeof created.id !== 'string') {
      throw new Error('DaytonaBackend.start: workspace creation returned no id');
    }
    this.state = {
      id: created.id,
      containerName,
      snapshotKey,
      repoPath: opts.repoPath,
    };
    log.info(`[daytona] Workspace started: ${containerName} (${created.id})`);
    return { containerId: created.id, containerName };
  }

  async execWave(input: SandboxBackendWaveInput): Promise<unknown> {
    if (this.state == null) {
      throw new Error('DaytonaBackend.execWave: backend not started');
    }
    const res = (await this.httpClient('POST', `/workspaces/${this.state.id}/exec`, {
      wave: input.wave,
      model: input.model,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      cwd: input.cwd,
      ...(input.thinkingLevel != null && { thinkingLevel: input.thinkingLevel }),
      ...(input.fallbackModel != null && { fallbackModel: input.fallbackModel }),
      ...(input.outputSchemaName != null && { outputSchemaName: input.outputSchemaName }),
    })) as { stdout?: string; stderr?: string; exitCode?: number };

    const stdout = (res.stdout ?? '').trim();
    if (stdout.length === 0) {
      throw new Error(`[daytona] No output from wave '${input.wave}'`);
    }
    const lines = stdout.split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine == null || lastLine.length === 0) {
      throw new Error(`[daytona] No output from wave '${input.wave}'`);
    }
    try {
      return JSON.parse(lastLine) as unknown;
    } catch {
      throw new Error(`[daytona] Failed to parse wave output: ${lastLine.slice(0, 200)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.state == null) return;
    await this.httpClient('DELETE', `/workspaces/${this.state.id}`);
    log.info(`[daytona] Workspace deleted: ${this.state.containerName}`);
    this.state = undefined;
  }

  async getStats(): Promise<SandboxStats> {
    if (this.state == null) return { memoryMB: 0, cpuPercent: 0 };
    try {
      const res = (await this.httpClient('GET', `/workspaces/${this.state.id}/stats`)) as {
        memoryMB?: number;
        cpuPercent?: number;
      };
      return { memoryMB: res.memoryMB ?? 0, cpuPercent: res.cpuPercent ?? 0 };
    } catch {
      return { memoryMB: 0, cpuPercent: 0 };
    }
  }

  /** Hibernate the workspace — preserves filesystem snapshot, frees runtime. */
  async hibernate(): Promise<void> {
    if (this.state == null) return;
    await this.httpClient('POST', `/workspaces/${this.state.id}/hibernate`);
    log.info(`[daytona] Workspace hibernated: ${this.state.containerName}`);
  }

  /** Resume from hibernate — restores filesystem snapshot, restarts runtime. */
  async resume(): Promise<void> {
    if (this.state == null) {
      throw new Error('DaytonaBackend.resume: backend not started');
    }
    await this.httpClient('POST', `/workspaces/${this.state.id}/resume`);
    log.info(`[daytona] Workspace resumed: ${this.state.containerName}`);
  }
}
