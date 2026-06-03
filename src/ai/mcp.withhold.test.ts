// Issue #271 — verify startAllMCPServers respects the `withholdServers` filter
// so callers (fix.ts) can suppress codegraph when its index is empty/uninitialized.

import { describe, expect, it, vi } from 'vitest';

const transportCtorCalls: Array<Record<string, unknown>> = [];

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(params: Record<string, unknown>) {
      transportCtorCalls.push(params);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {
      /* noop */
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: [] };
    }
    async close(): Promise<void> {
      /* noop */
    }
  },
}));

import { startAllMCPServers } from './mcp.js';

describe('startAllMCPServers withholdServers', () => {
  it('starts all servers when withholdServers is omitted (backward-compat)', async () => {
    transportCtorCalls.length = 0;
    const handles = await startAllMCPServers({
      'repo-intel': { command: 'repo-intel-server' },
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
    });
    expect(handles.size).toBe(2);
    expect(handles.has('repo-intel')).toBe(true);
    expect(handles.has('codegraph')).toBe(true);
  });

  it('skips servers named in withholdServers without erroring', async () => {
    transportCtorCalls.length = 0;
    const handles = await startAllMCPServers(
      {
        'repo-intel': { command: 'repo-intel-server' },
        codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
      },
      undefined,
      ['codegraph'],
    );
    expect(handles.size).toBe(1);
    expect(handles.has('repo-intel')).toBe(true);
    expect(handles.has('codegraph')).toBe(false);
  });

  it('still works when withholdServers references a server that is not configured', async () => {
    transportCtorCalls.length = 0;
    const handles = await startAllMCPServers({ 'repo-intel': { command: 'repo-intel-server' } }, undefined, [
      'codegraph',
      'nonexistent',
    ]);
    expect(handles.size).toBe(1);
    expect(handles.has('repo-intel')).toBe(true);
  });

  it('returns empty map when every server is withheld', async () => {
    transportCtorCalls.length = 0;
    const handles = await startAllMCPServers(
      {
        'repo-intel': { command: 'repo-intel-server' },
        codegraph: { command: 'codegraph' },
      },
      undefined,
      ['repo-intel', 'codegraph'],
    );
    expect(handles.size).toBe(0);
  });
});
