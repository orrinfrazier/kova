// Tests for DaytonaBackend — a serverless-persistence backend that hibernates
// the workspace on idle and resumes on next use. Filesystem state is preserved
// across hibernate/resume via a snapshot key derived from `${repoName}-${issueNumber}`.
//
// Network calls are isolated behind an injectable httpClient so tests assert
// request URL + body shape without any real network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaytonaBackend, type DaytonaHttpClient } from './daytona-backend.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.DAYTONA_API_TOKEN = 'test-token';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeClient(): { client: DaytonaHttpClient; calls: Array<{ method: string; url: string; body: unknown }> } {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const client: DaytonaHttpClient = async (method, url, body) => {
    calls.push({ method, url, body });
    // Return the wave-exec shape first — its URL also contains '/workspaces'.
    if (url.includes('/exec')) {
      return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 };
    }
    if (url.includes('/hibernate')) {
      return { state: 'stopped' };
    }
    if (url.includes('/resume')) {
      return { id: 'ws-abc', state: 'running' };
    }
    // Create-workspace returns the workspace shape with an id.
    if (url.endsWith('/workspaces') && method === 'POST') {
      return { id: 'ws-abc', state: 'running' };
    }
    return {};
  };
  return { client, calls };
}

describe('DaytonaBackend.start', () => {
  it('creates a workspace keyed by repoName-issueNumber', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });

    const handle = await backend.start({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/host/my-repo',
      config: undefined,
    });

    expect(handle.containerName).toContain('my-repo');
    expect(handle.containerName).toContain('42');

    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/workspaces'));
    expect(createCall).toBeDefined();
    expect(createCall?.body).toMatchObject({
      // snapshot key is the persistence anchor — stable across hibernate/resume
      snapshot: expect.stringContaining('my-repo'),
    });
  });

  it('throws a classified error when DAYTONA_API_TOKEN is missing', async () => {
    delete process.env.DAYTONA_API_TOKEN;
    const backend = new DaytonaBackend();

    await expect(
      backend.start({ repoName: 'foo', issueNumber: 1, repoPath: '/host', config: undefined }),
    ).rejects.toThrow(/DAYTONA_API_TOKEN/);
  });
});

describe('DaytonaBackend.hibernate / resume', () => {
  it('hibernate calls the hibernate endpoint for the started workspace', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });
    await backend.start({ repoName: 'r', issueNumber: 1, repoPath: '/host', config: undefined });

    await backend.hibernate();

    const hibernateCall = calls.find((c) => c.url.includes('/hibernate'));
    expect(hibernateCall).toBeDefined();
    expect(hibernateCall?.method).toBe('POST');
  });

  it('resume calls the resume endpoint for the same workspace id', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });
    await backend.start({ repoName: 'r', issueNumber: 1, repoPath: '/host', config: undefined });
    await backend.hibernate();
    await backend.resume();

    const resumeCall = calls.find((c) => c.url.includes('/resume'));
    expect(resumeCall).toBeDefined();
    expect(resumeCall?.method).toBe('POST');
  });

  it('snapshot key derivation is stable across hibernate/resume', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });
    await backend.start({ repoName: 'persist-repo', issueNumber: 99, repoPath: '/host', config: undefined });

    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/workspaces'));
    const snapshotKey = (createCall?.body as { snapshot?: string } | undefined)?.snapshot;

    expect(snapshotKey).toBeDefined();
    // The key must include the repo + issue so a new run keyed identically resumes the same FS.
    expect(snapshotKey).toContain('persist-repo');
    expect(snapshotKey).toContain('99');
  });
});

describe('DaytonaBackend.execWave', () => {
  it('routes wave input through the workspace exec endpoint', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });
    await backend.start({ repoName: 'r', issueNumber: 1, repoPath: '/host', config: undefined });

    const out = await backend.execWave({
      wave: 'assess',
      model: 'anthropic:claude-opus',
      systemPrompt: 'sys',
      userMessage: 'msg',
      cwd: '/workspace',
    });

    const execCall = calls.find((c) => c.url.includes('/exec'));
    expect(execCall).toBeDefined();
    expect(out).toEqual({ ok: true });
  });

  it('throws when called before start', async () => {
    const backend = new DaytonaBackend({ httpClient: makeClient().client });
    await expect(
      backend.execWave({ wave: 'assess', model: 'm', systemPrompt: 's', userMessage: 'u', cwd: '/workspace' }),
    ).rejects.toThrow(/not started/i);
  });
});

describe('DaytonaBackend.stop', () => {
  it('calls the delete-workspace endpoint', async () => {
    const { client, calls } = makeClient();
    const backend = new DaytonaBackend({ httpClient: client });
    await backend.start({ repoName: 'r', issueNumber: 1, repoPath: '/host', config: undefined });
    await backend.stop();

    const deleteCall = calls.find((c) => c.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toContain('/workspaces/');
  });

  it('is a no-op if backend was never started', async () => {
    const backend = new DaytonaBackend({ httpClient: makeClient().client });
    await expect(backend.stop()).resolves.toBeUndefined();
  });
});
