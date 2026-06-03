// Unit tests for the kova MCP server bootstrap (issue #311).
// Uses an in-memory transport pair so we exercise the SDK's tools/list and
// tools/call paths without spawning a real subprocess. The spawnWave function
// is injected so no real agent runs.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { WaveHandoff } from '../../types/index.js';
import type { AssessResult, ReviewResult } from '../../types/waves.js';
import type { SpawnWaveFn } from './adapter.js';
import { createKovaMcpServer } from './server.js';

function makeHandoff<T>(wave: WaveHandoff['wave'], artifact: T): WaveHandoff<T> {
  return {
    wave,
    timestamp: '2026-06-02T00:00:00.000Z',
    model: 'anthropic:claude-sonnet-4-6',
    cost: 0.01,
    turns: 1,
    confidence: 'high',
    artifact,
    approach_notes: '',
    parsed: true,
  };
}

async function connectClientToServer(spawnWave: SpawnWaveFn): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = createKovaMcpServer({ spawnWave });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('mcp-server/server — tool registration', () => {
  it('registers exactly 6 kova.run_<wave> tools', async () => {
    const spawn: SpawnWaveFn = vi.fn();
    const { client, close } = await connectClientToServer(spawn);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'kova.run_assess',
        'kova.run_impl',
        'kova.run_quality',
        'kova.run_review',
        'kova.run_spec',
        'kova.run_test',
      ]);
    } finally {
      await close();
    }
  });

  it('each registered tool has an input schema and a description', async () => {
    const spawn: SpawnWaveFn = vi.fn();
    const { client, close } = await connectClientToServer(spawn);

    try {
      const { tools } = await client.listTools();
      for (const t of tools) {
        expect(t.description).toBeTruthy();
        expect(t.inputSchema).toBeDefined();
        expect(t.inputSchema.type).toBe('object');
      }
    } finally {
      await close();
    }
  });
});

describe('mcp-server/server — tools/call', () => {
  it('invokes spawnWave for kova.run_assess and returns the handoff as text', async () => {
    const handoff = makeHandoff<AssessResult>('assess', {
      grade: 'A',
      surface_area: { files: ['x.ts'], estimated_lines: 10, modules_affected: ['x'] },
      risk: 'low',
      reasoning: 'trivial',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    const { client, close } = await connectClientToServer(spawn);

    try {
      const result = await client.callTool({
        name: 'kova.run_assess',
        arguments: {
          handoff_context: '',
          user_message: 'assess issue 311',
          cwd: '/tmp/repo',
        },
      });
      expect(spawn).toHaveBeenCalledOnce();
      const content = Array.isArray(result.content) ? result.content : [];
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe('text');
      const parsed: unknown = JSON.parse((content[0] as { text: string }).text);
      expect(parsed).toEqual(handoff);
    } finally {
      await close();
    }
  });

  it('forwards max_cost_usd through tools/call to spawnWave', async () => {
    const handoff = makeHandoff<ReviewResult>('review', {
      verdict: 'pass',
      findings: [],
      summary: 'lgtm',
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    const { client, close } = await connectClientToServer(spawn);

    try {
      await client.callTool({
        name: 'kova.run_review',
        arguments: {
          handoff_context: '',
          user_message: 'review the diff',
          cwd: '/tmp/repo',
          max_cost_usd: 1.5,
        },
      });
      const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(config.maxCostUsd).toBe(1.5);
    } finally {
      await close();
    }
  });

  it('returns an MCP-shaped error when spawnWave fails', async () => {
    const spawn: SpawnWaveFn = vi.fn().mockRejectedValue(new Error('boom'));
    const { client, close } = await connectClientToServer(spawn);

    try {
      const result = await client.callTool({
        name: 'kova.run_impl',
        arguments: {
          handoff_context: '',
          user_message: 'do it',
          cwd: '/tmp',
        },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      expect((content[0] as { text: string }).text).toContain('boom');
    } finally {
      await close();
    }
  });
});
