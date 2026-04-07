import { describe, expect, it, vi } from 'vitest';
import type { RepoConfig } from '../types/index.js';

const mockFixLoop = vi.fn();
const mockFetchIssues = vi.fn();

vi.mock('../services/github.js', () => ({
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
}));

vi.mock('./loop.js', () => ({
  fixLoop: (...args: unknown[]) => mockFixLoop(...args),
}));

const { runAuto } = await import('./auto.js');

function makeConfig(autoOverrides?: Partial<RepoConfig['auto']>): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
    model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
    isolation: 'none',
    auto: {
      source: 'open_issues',
      max_per_run: 10,
      ...autoOverrides,
    },
  };
}

function makeLoopResult(overrides?: { failed?: number; succeeded?: number }) {
  return {
    total: 2,
    succeeded: overrides?.succeeded ?? 2,
    failed: overrides?.failed ?? 0,
    skipped: 0,
    totalCost: 1.0,
    totalTurns: 50,
    totalDuration: 30000,
    results: [],
  };
}

describe('runAuto', () => {
  it('calls fixLoop with config defaults when no CLI overrides', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeConfig({ filter: 'auto-fix', max_per_run: 5 });

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config,
      filter: 'auto-fix',
      maxIssues: 5,
    });
    expect(result.exitCode).toBe(0);
  });

  it('CLI --filter overrides config auto.filter', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeConfig({ filter: 'auto-fix' });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config, filter: 'bug' });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: 'bug' }));
  });

  it('CLI --max overrides config auto.max_per_run', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeConfig({ max_per_run: 20 });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config, max: 3 });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ maxIssues: 3 }));
  });

  it('returns exitCode 0 when all succeed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 3, failed: 0 }));
    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 1 when any failed', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult({ succeeded: 1, failed: 1 }));
    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });
    expect(result.exitCode).toBe(1);
  });

  it('uses labeled source filter from config', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config = makeConfig({ source: 'labeled', filter: 'kova' });

    await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: 'kova' }));
  });

  it('works when config has no auto section', async () => {
    mockFixLoop.mockResolvedValue(makeLoopResult());
    const config: RepoConfig = {
      path: '/tmp/test',
      rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
      model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
      isolation: 'none',
    };

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config });

    expect(mockFixLoop).toHaveBeenCalledWith(expect.objectContaining({ filter: undefined, maxIssues: 10 }));
    expect(result.exitCode).toBe(0);
  });

  it('returns loopResult for downstream consumption', async () => {
    const loopResult = makeLoopResult({ succeeded: 2, failed: 1 });
    mockFixLoop.mockResolvedValue(loopResult);

    const result = await runAuto({ repoPath: '/tmp/test', repoName: 'test-repo', config: makeConfig() });

    expect(result.loopResult).toEqual(loopResult);
  });
});
