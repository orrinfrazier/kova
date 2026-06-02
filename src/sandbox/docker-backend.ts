// DockerBackend — the historical sandbox implementation, wrapped as a
// SandboxBackend so the pipeline can switch to other backends (Daytona, Modal,
// Fly.io, e2b) via `repos.yaml`'s `sandbox.backend` field.
//
// This is a thin facade over the existing helpers in `src/services/sandbox.ts`
// — no behavior changes vs the pre-extraction direct calls. The pre-existing
// `startSandboxContainer` / `execWaveInContainer` / `killContainer` /
// `getContainerStats` helpers stay exported for legacy callers and tests.

import {
  execWaveInContainer,
  getContainerStats,
  killContainer,
  type SandboxWaveInput,
  startSandboxContainer,
} from '../services/sandbox.js';
import type {
  SandboxBackend,
  SandboxBackendWaveInput,
  SandboxHandle,
  SandboxStartOpts,
  SandboxStats,
} from './backend.js';

/**
 * Docker-backed sandbox. Mirrors the in-tree behavior from before issue #301:
 * one container per fix, bind-mounted /workspace, no persistence between runs.
 */
export class DockerBackend implements SandboxBackend {
  private containerId: string | undefined;
  private containerName: string | undefined;
  private repoPath: string | undefined;
  private dockerCommand: string | undefined;

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const handle = await startSandboxContainer({
      repoName: opts.repoName,
      issueNumber: opts.issueNumber,
      repoPath: opts.repoPath,
      config: opts.config,
    });
    this.containerId = handle.containerId;
    this.containerName = handle.containerName;
    this.repoPath = opts.repoPath;
    return handle;
  }

  async execWave(input: SandboxBackendWaveInput): Promise<unknown> {
    if (this.containerName == null || this.repoPath == null) {
      throw new Error('DockerBackend.execWave: backend not started');
    }
    // The runtime wire shape is identical to SandboxWaveInput; the local
    // alias just exists so the interface stays backend-agnostic.
    const wireInput: SandboxWaveInput = {
      wave: input.wave,
      model: input.model,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      cwd: input.cwd,
      ...(input.thinkingLevel != null && { thinkingLevel: input.thinkingLevel }),
      ...(input.fallbackModel != null && { fallbackModel: input.fallbackModel }),
      ...(input.outputSchemaName != null && { outputSchemaName: input.outputSchemaName }),
    };
    return execWaveInContainer(this.containerName, wireInput, this.repoPath, this.dockerCommand);
  }

  async stop(): Promise<void> {
    if (this.containerId == null) return;
    await killContainer(this.containerId, this.dockerCommand);
    this.containerId = undefined;
    this.containerName = undefined;
  }

  async getStats(): Promise<SandboxStats> {
    if (this.containerId == null) return { memoryMB: 0, cpuPercent: 0 };
    return getContainerStats(this.containerId, this.dockerCommand);
  }

  /** Docker has no persistence model — hibernate is a no-op. */
  async hibernate(): Promise<void> {
    // intentionally empty — see SandboxBackend.hibernate() docstring
  }

  /** Docker has no persistence model — resume is a no-op. */
  async resume(): Promise<void> {
    // intentionally empty — see SandboxBackend.resume() docstring
  }
}
