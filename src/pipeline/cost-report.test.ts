import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, WaveResult } from '../types/index.js';
import { buildCostReport, type CostReport, printRunSummary, writeCostReport } from './cost-report.js';

function makeWaveResult(wave: string, overrides?: Partial<WaveResult>): WaveResult {
  return {
    wave: wave as WaveResult['wave'],
    success: true,
    artifact: {},
    duration: 5000,
    cost: 0.05,
    turns: 10,
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

function makeState(overrides?: Partial<FixState>): FixState {
  return {
    issue: { number: 42, title: 'Test issue', body: 'body', labels: [], url: 'https://example.com/42' },
    repo: 'test-repo',
    repoPath: '/tmp/test',
    startedAt: '2026-04-06T10:00:00.000Z',
    completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
    waveResults: {
      assess: makeWaveResult('assess', { cost: 0.12, turns: 5, duration: 3000 }),
      spec: makeWaveResult('spec', { cost: 0.08, turns: 3, duration: 2000 }),
      test: makeWaveResult('test', { cost: 0.15, turns: 12, duration: 8000 }),
      impl: makeWaveResult('impl', { cost: 0.2, turns: 20, duration: 12000 }),
      quality: makeWaveResult('quality', { cost: 0.03, turns: 4, duration: 1500 }),
      review: makeWaveResult('review', { cost: 0.1, turns: 8, duration: 5000 }),
      ship: makeWaveResult('ship', { cost: 0, turns: 0, duration: 500 }),
    },
    status: 'completed',
    ...overrides,
  };
}

describe('buildCostReport', () => {
  it('aggregates total cost across all waves', () => {
    const report = buildCostReport(makeState());
    expect(report.totalCost).toBeCloseTo(0.12 + 0.08 + 0.15 + 0.2 + 0.03 + 0.1 + 0, 4);
  });
  it('aggregates total turns across all waves', () => {
    expect(buildCostReport(makeState()).totalTurns).toBe(5 + 3 + 12 + 20 + 4 + 8 + 0);
  });
  it('aggregates total duration across all waves', () => {
    expect(buildCostReport(makeState()).totalDuration).toBe(3000 + 2000 + 8000 + 12000 + 1500 + 5000 + 500);
  });
  it('includes per-wave breakdown', () => {
    const report = buildCostReport(makeState());
    expect(report.waves).toHaveLength(7);
    expect(report.waves[0]).toMatchObject({
      wave: 'assess',
      cost: 0.12,
      turns: 5,
      duration: 3000,
      model: 'claude-sonnet-4-20250514',
    });
  });
  it('includes issue number and timestamps', () => {
    const report = buildCostReport(makeState());
    expect(report.issueNumber).toBe(42);
    expect(report.startedAt).toBe('2026-04-06T10:00:00.000Z');
    expect(report.completedAt).toBeDefined();
  });
  it('handles partial wave results (early exit)', () => {
    const report = buildCostReport(
      makeState({
        completedWaves: ['assess'],
        waveResults: { assess: makeWaveResult('assess', { cost: 0.12, turns: 5, duration: 3000 }) },
      }),
    );
    expect(report.totalCost).toBeCloseTo(0.12, 4);
    expect(report.totalTurns).toBe(5);
    expect(report.waves).toHaveLength(1);
  });
  it('handles waves with zero cost (ship wave)', () => {
    const shipWave = buildCostReport(makeState()).waves.find((w) => w.wave === 'ship');
    expect(shipWave).toBeDefined();
    expect(shipWave?.cost).toBe(0);
    expect(shipWave?.turns).toBe(0);
  });
});

describe('writeCostReport', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-cost-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes cost-report.json to .kova directory', async () => {
    const report: CostReport = {
      issueNumber: 42,
      totalCost: 0.68,
      apiCost: 0.68,
      localCost: 0,
      totalTurns: 52,
      totalDuration: 32000,
      waves: [{ wave: 'assess', cost: 0.12, turns: 5, duration: 3000, model: 'test-model' }],
      fallbackCount: 0,
      startedAt: '2026-04-06T10:00:00.000Z',
      completedAt: '2026-04-06T10:05:00.000Z',
    };
    await writeCostReport(workDir, report);
    const parsed = JSON.parse(await readFile(join(workDir, '.kova', 'cost-report.json'), 'utf-8')) as CostReport;
    expect(parsed.totalCost).toBe(0.68);
    expect(parsed.issueNumber).toBe(42);
    expect(parsed.waves).toHaveLength(1);
  });
  it('overwrites existing cost-report.json', async () => {
    await writeCostReport(workDir, {
      issueNumber: 42,
      totalCost: 0.5,
      apiCost: 0.5,
      localCost: 0,
      totalTurns: 30,
      totalDuration: 20000,
      waves: [],
      fallbackCount: 0,
      startedAt: '2026-04-06T10:00:00.000Z',
      completedAt: '2026-04-06T10:03:00.000Z',
    });
    await writeCostReport(workDir, {
      issueNumber: 42,
      totalCost: 0.75,
      apiCost: 0.75,
      localCost: 0,
      totalTurns: 55,
      totalDuration: 35000,
      waves: [],
      fallbackCount: 0,
      startedAt: '2026-04-06T10:00:00.000Z',
      completedAt: '2026-04-06T10:06:00.000Z',
    });
    const parsed = JSON.parse(await readFile(join(workDir, '.kova', 'cost-report.json'), 'utf-8')) as CostReport;
    expect(parsed.totalCost).toBe(0.75);
  });
});

describe('API vs local cost split', () => {
  it('calculates apiCost and localCost from provider info', () => {
    const state = makeState({
      waveResults: {
        assess: makeWaveResult('assess', { cost: 0.12, provider: 'anthropic' }),
        spec: makeWaveResult('spec', { cost: 0.08, provider: 'anthropic' }),
        test: makeWaveResult('test', { cost: 0, provider: 'ollama' }),
        impl: makeWaveResult('impl', { cost: 0, provider: 'ollama' }),
        quality: makeWaveResult('quality', { cost: 0, provider: 'ollama' }),
        review: makeWaveResult('review', { cost: 0.1, provider: 'anthropic' }),
        ship: makeWaveResult('ship', { cost: 0, turns: 0 }),
      },
    });
    const report = buildCostReport(state);
    expect(report.apiCost).toBeCloseTo(0.3, 4);
    expect(report.localCost).toBeCloseTo(0, 4);
  });

  it('includes provider in per-wave breakdown', () => {
    const state = makeState({
      waveResults: {
        assess: makeWaveResult('assess', { cost: 0.12, provider: 'anthropic' }),
        impl: makeWaveResult('impl', { cost: 0, provider: 'ollama' }),
      },
    });
    const report = buildCostReport(state);
    const assessWave = report.waves.find((w) => w.wave === 'assess');
    const implWave = report.waves.find((w) => w.wave === 'impl');
    expect(assessWave?.provider).toBe('anthropic');
    expect(implWave?.provider).toBe('ollama');
  });

  it('treats undefined provider as API (backward compat)', () => {
    const report = buildCostReport(makeState());
    // All waves have no provider set — should count as API
    expect(report.apiCost).toBeCloseTo(report.totalCost, 4);
    expect(report.localCost).toBe(0);
  });
});

describe('fallback tracking in cost report', () => {
  it('counts fallback waves', () => {
    const state = makeState({
      waveResults: {
        assess: makeWaveResult('assess', { cost: 0.12, turns: 5, duration: 3000, fallback_used: true }),
        spec: makeWaveResult('spec', { cost: 0.08, turns: 3, duration: 2000 }),
      },
      completedWaves: ['assess', 'spec'],
    });
    const report = buildCostReport(state);
    expect(report.fallbackCount).toBe(1);
  });

  it('returns 0 fallbackCount when no fallbacks used', () => {
    const report = buildCostReport(makeState());
    expect(report.fallbackCount).toBe(0);
  });

  it('sums localCost from waves with fallback', () => {
    const state = makeState({
      waveResults: {
        assess: makeWaveResult('assess', {
          cost: 0.12,
          turns: 5,
          duration: 3000,
          fallback_used: true,
          local_attempt_cost: 0.0,
        }),
        spec: makeWaveResult('spec', { cost: 0.08, turns: 3, duration: 2000 }),
      },
      completedWaves: ['assess', 'spec'],
    });
    const report = buildCostReport(state);
    expect(report.localCost).toBe(0.0);
  });

  it('includes fallback_used flag in per-wave breakdown', () => {
    const state = makeState({
      waveResults: {
        assess: makeWaveResult('assess', {
          cost: 0.12,
          turns: 5,
          duration: 3000,
          fallback_used: true,
        }),
      },
      completedWaves: ['assess'],
    });
    const report = buildCostReport(state);
    expect(report.waves[0]?.fallback_used).toBe(true);
  });
});

describe('printRunSummary', () => {
  it('logs total cost, per-wave breakdown, turns, and duration', () => {
    const report: CostReport = {
      issueNumber: 42,
      totalCost: 0.68,
      apiCost: 0.68,
      localCost: 0,
      totalTurns: 52,
      totalDuration: 32000,
      waves: [
        { wave: 'assess', cost: 0.12, turns: 5, duration: 3000, model: 'claude-opus-4-20250514' },
        { wave: 'spec', cost: 0.08, turns: 3, duration: 2000, model: 'claude-opus-4-20250514' },
        { wave: 'impl', cost: 0.2, turns: 20, duration: 12000, model: 'claude-sonnet-4-20250514' },
      ],
      fallbackCount: 0,
      startedAt: '2026-04-06T10:00:00.000Z',
      completedAt: '2026-04-06T10:05:00.000Z',
    };
    const consoleSpy = vi.spyOn(console, 'log');
    printRunSummary(report);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('$0.68');
    expect(output).toContain('52');
    expect(output).toContain('32');
    expect(output).toContain('assess');
    expect(output).toContain('$0.12');
    expect(output).toContain('impl');
    expect(output).toContain('$0.20');
    consoleSpy.mockRestore();
  });
});
