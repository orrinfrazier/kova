import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixState } from '../types/index.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint.js';

function makeState(overrides?: Partial<FixState>): FixState {
  return {
    issue: { number: 42, title: 'Test issue', body: 'body', labels: [], url: 'https://example.com' },
    repo: 'test-repo',
    repoPath: '/tmp/test',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedWaves: [],
    waveResults: {},
    status: 'running',
    ...overrides,
  };
}

describe('checkpoint', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('saveCheckpoint creates .kova/state.json', async () => {
    const state = makeState();
    await saveCheckpoint(workDir, state);

    const content = await readFile(join(workDir, '.kova', 'state.json'), 'utf-8');
    const parsed = JSON.parse(content) as FixState;
    expect(parsed.issue.number).toBe(42);
    expect(parsed.status).toBe('running');
  });

  it('loadCheckpoint returns null when no checkpoint exists', async () => {
    const result = await loadCheckpoint(workDir);
    expect(result).toBeNull();
  });

  it('loadCheckpoint returns saved state', async () => {
    const state = makeState({ completedWaves: ['assess', 'spec'] });
    await saveCheckpoint(workDir, state);

    const loaded = await loadCheckpoint(workDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.completedWaves).toEqual(['assess', 'spec']);
    expect(loaded?.issue.number).toBe(42);
  });

  it('clearCheckpoint removes the state file', async () => {
    const state = makeState();
    await saveCheckpoint(workDir, state);

    await clearCheckpoint(workDir);

    const loaded = await loadCheckpoint(workDir);
    expect(loaded).toBeNull();
  });

  it('clearCheckpoint is a no-op when no checkpoint exists', async () => {
    // Should not throw
    await clearCheckpoint(workDir);
  });

  it('saveCheckpoint overwrites existing checkpoint', async () => {
    const state1 = makeState({ completedWaves: ['assess'] });
    await saveCheckpoint(workDir, state1);

    const state2 = makeState({ completedWaves: ['assess', 'spec', 'test'] });
    await saveCheckpoint(workDir, state2);

    const loaded = await loadCheckpoint(workDir);
    expect(loaded?.completedWaves).toEqual(['assess', 'spec', 'test']);
  });
});
