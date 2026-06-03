// Tests for DockerBackend — verifies it wraps the existing sandbox helpers
// without behavior changes. The interface contract is identical to what
// `src/pipeline/fix.ts` did inline before the extraction.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox.js')>();
  return {
    ...actual,
    startSandboxContainer: vi.fn(),
    execWaveInContainer: vi.fn(),
    killContainer: vi.fn(),
    getContainerStats: vi.fn(),
  };
});

import { DockerBackend } from './docker-backend.js';
import { execWaveInContainer, getContainerStats, killContainer, startSandboxContainer } from './sandbox.js';

const mockStart = vi.mocked(startSandboxContainer);
const mockExec = vi.mocked(execWaveInContainer);
const mockKill = vi.mocked(killContainer);
const mockStats = vi.mocked(getContainerStats);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DockerBackend.start', () => {
  it('delegates to startSandboxContainer with the supplied opts', async () => {
    mockStart.mockResolvedValue({ containerId: 'abc123', containerName: 'kova-sandbox-foo-7' });

    const backend = new DockerBackend();
    const handle = await backend.start({
      repoName: 'foo',
      issueNumber: 7,
      repoPath: '/host/foo',
      config: undefined,
    });

    expect(mockStart).toHaveBeenCalledWith({
      repoName: 'foo',
      issueNumber: 7,
      repoPath: '/host/foo',
      config: undefined,
    });
    expect(handle).toEqual({ containerId: 'abc123', containerName: 'kova-sandbox-foo-7' });
  });
});

describe('DockerBackend.execWave', () => {
  it('delegates to execWaveInContainer using the started container', async () => {
    mockStart.mockResolvedValue({ containerId: 'cid', containerName: 'kova-sandbox-foo-7' });
    mockExec.mockResolvedValue({ ok: true });

    const backend = new DockerBackend();
    await backend.start({ repoName: 'foo', issueNumber: 7, repoPath: '/host/foo', config: undefined });

    const out = await backend.execWave({
      wave: 'assess',
      model: 'anthropic:claude-opus',
      systemPrompt: 'sys',
      userMessage: 'msg',
      cwd: '/workspace',
    });

    expect(mockExec).toHaveBeenCalledWith(
      'kova-sandbox-foo-7',
      expect.objectContaining({ wave: 'assess', model: 'anthropic:claude-opus' }),
      '/host/foo',
      undefined,
    );
    expect(out).toEqual({ ok: true });
  });

  it('throws if execWave is called before start', async () => {
    const backend = new DockerBackend();
    await expect(
      backend.execWave({
        wave: 'assess',
        model: 'm',
        systemPrompt: 's',
        userMessage: 'u',
        cwd: '/workspace',
      }),
    ).rejects.toThrow(/not started/i);
  });
});

describe('DockerBackend.stop', () => {
  it('delegates to killContainer using the started container id', async () => {
    mockStart.mockResolvedValue({ containerId: 'cid-9', containerName: 'kova-sandbox-foo-7' });

    const backend = new DockerBackend();
    await backend.start({ repoName: 'foo', issueNumber: 7, repoPath: '/host/foo', config: undefined });
    await backend.stop();

    expect(mockKill).toHaveBeenCalledWith('cid-9', undefined);
  });

  it('is a no-op if backend was never started', async () => {
    const backend = new DockerBackend();
    await expect(backend.stop()).resolves.toBeUndefined();
    expect(mockKill).not.toHaveBeenCalled();
  });
});

describe('DockerBackend.getStats', () => {
  it('delegates to getContainerStats with the started container id', async () => {
    mockStart.mockResolvedValue({ containerId: 'cid-9', containerName: 'kova-sandbox-foo-7' });
    mockStats.mockResolvedValue({ memoryMB: 256, cpuPercent: 12.5 });

    const backend = new DockerBackend();
    await backend.start({ repoName: 'foo', issueNumber: 7, repoPath: '/host/foo', config: undefined });
    const stats = await backend.getStats();

    expect(mockStats).toHaveBeenCalledWith('cid-9', undefined);
    expect(stats).toEqual({ memoryMB: 256, cpuPercent: 12.5 });
  });

  it('returns zeros when not started', async () => {
    const backend = new DockerBackend();
    const stats = await backend.getStats();
    expect(stats).toEqual({ memoryMB: 0, cpuPercent: 0 });
  });
});

describe('DockerBackend.hibernate / resume', () => {
  it('hibernate is a no-op (docker has no persistence model)', async () => {
    mockStart.mockResolvedValue({ containerId: 'cid', containerName: 'name' });
    const backend = new DockerBackend();
    await backend.start({ repoName: 'foo', issueNumber: 7, repoPath: '/host/foo', config: undefined });
    await expect(backend.hibernate()).resolves.toBeUndefined();
  });

  it('resume is a no-op (docker has no persistence model)', async () => {
    const backend = new DockerBackend();
    await expect(backend.resume()).resolves.toBeUndefined();
  });
});
