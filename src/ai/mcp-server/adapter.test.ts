// Unit tests for the MCP server wave adapter (issue #311).
// The adapter is a thin shim from MCP tool input → SpawnWaveAgentConfig →
// spawnWaveAgent(). It must:
//   - resolve the wave's default model when no `model` override is supplied
//   - forward optional max_cost_usd through to the spawn config
//   - return a single text content block whose payload is JSON.stringify(handoff)
//   - never widen the WaveHandoff schema (preserve the existing serialization)

import { describe, expect, it, vi } from 'vitest';
import type { WaveHandoff } from '../../types/index.js';
import type { AssessResult, ImplResult } from '../../types/waves.js';
import { adaptWaveCall, type SpawnWaveFn } from './adapter.js';

function makeFakeHandoff<T>(wave: WaveHandoff['wave'], artifact: T): WaveHandoff<T> {
  return {
    wave,
    timestamp: '2026-06-02T00:00:00.000Z',
    model: 'anthropic:claude-sonnet-4-6',
    cost: 0.0123,
    turns: 3,
    confidence: 'high',
    artifact,
    approach_notes: 'fake',
    parsed: true,
  };
}

describe('mcp-server/adapter — adaptWaveCall', () => {
  it('returns a single text content block containing the JSON-serialized handoff', async () => {
    const handoff = makeFakeHandoff<AssessResult>('assess', {
      grade: 'B',
      surface_area: { files: ['src/x.ts'], estimated_lines: 50, modules_affected: ['x'] },
      risk: 'low',
      reasoning: 'looks fine',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    const result = await adaptWaveCall(
      'assess',
      {
        handoff_context: '',
        user_message: 'assess this',
        cwd: '/tmp/repo',
      },
      { spawnWave: spawn },
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const parsed: unknown = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed).toEqual(handoff);
    expect(result.isError).toBeFalsy();
  });

  it('forwards user_message, handoff_context, and cwd to spawnWave verbatim', async () => {
    const handoff = makeFakeHandoff<ImplResult>('impl', {
      files_modified: ['a.ts'],
      files_created: [],
      tests_passing: true,
      approach_notes: 'small change',
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    await adaptWaveCall(
      'impl',
      {
        handoff_context: 'prior spec',
        user_message: 'implement piece 1',
        cwd: '/work',
      },
      { spawnWave: spawn },
    );

    expect(spawn).toHaveBeenCalledOnce();
    const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(config.wave).toBe('impl');
    expect(config.handoffContext).toBe('prior spec');
    expect(config.userMessage).toBe('implement piece 1');
    expect(config.cwd).toBe('/work');
  });

  it('forwards optional max_cost_usd to spawnWave', async () => {
    const handoff = makeFakeHandoff<AssessResult>('assess', {
      grade: 'A',
      surface_area: { files: [], estimated_lines: 0, modules_affected: [] },
      risk: 'low',
      reasoning: '',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    await adaptWaveCall(
      'assess',
      {
        handoff_context: '',
        user_message: 'go',
        cwd: '/tmp',
        max_cost_usd: 0.75,
      },
      { spawnWave: spawn },
    );

    const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(config.maxCostUsd).toBe(0.75);
  });

  it('passes through the model override when supplied', async () => {
    const handoff = makeFakeHandoff<AssessResult>('assess', {
      grade: 'A',
      surface_area: { files: [], estimated_lines: 0, modules_affected: [] },
      risk: 'low',
      reasoning: '',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    await adaptWaveCall(
      'assess',
      {
        handoff_context: '',
        user_message: 'go',
        cwd: '/tmp',
        model: 'anthropic:claude-opus-4-5',
      },
      { spawnWave: spawn },
    );

    const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(config.model).toBe('anthropic:claude-opus-4-5');
  });

  it('falls back to the wave default model when no override supplied', async () => {
    const handoff = makeFakeHandoff<AssessResult>('assess', {
      grade: 'A',
      surface_area: { files: [], estimated_lines: 0, modules_affected: [] },
      risk: 'low',
      reasoning: '',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    await adaptWaveCall(
      'assess',
      {
        handoff_context: '',
        user_message: 'go',
        cwd: '/tmp',
      },
      { spawnWave: spawn },
    );

    const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof config.model).toBe('string');
    expect(config.model.length).toBeGreaterThan(0);
  });

  it('attaches the structured-output format derived from waves.ts', async () => {
    const handoff = makeFakeHandoff<AssessResult>('assess', {
      grade: 'A',
      surface_area: { files: [], estimated_lines: 0, modules_affected: [] },
      risk: 'low',
      reasoning: '',
      should_proceed: true,
    });
    const spawn: SpawnWaveFn = vi.fn().mockResolvedValue(handoff);
    await adaptWaveCall('assess', { handoff_context: '', user_message: 'go', cwd: '/tmp' }, { spawnWave: spawn });

    const config = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(config.outputFormat).toBeDefined();
    expect(config.outputFormat.type).toBe('json_schema');
    expect(config.outputFormat.schema.type).toBe('object');
  });

  it('returns an MCP error result when spawnWave throws', async () => {
    const spawn: SpawnWaveFn = vi.fn().mockRejectedValue(new Error('agent exploded'));
    const result = await adaptWaveCall(
      'assess',
      { handoff_context: '', user_message: 'go', cwd: '/tmp' },
      { spawnWave: spawn },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('agent exploded');
  });
});
