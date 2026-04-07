import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/github.js', () => ({
  fetchIssues: vi.fn().mockResolvedValue([
    { number: 1, title: 'Issue 1', body: 'body 1', labels: [], url: 'https://example.com/1' },
    { number: 2, title: 'Issue 2', body: 'body 2', labels: [], url: 'https://example.com/2' },
    { number: 3, title: 'Issue 3', body: 'body 3', labels: [], url: 'https://example.com/3' },
  ]),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  hasExistingWork: vi.fn().mockResolvedValue(false),
}));

vi.mock('./fix.js', () => ({
  fix: vi.fn().mockImplementation(({ issue }: { issue: Issue }) => ({
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: {
      issue,
      repo: 'test-repo',
      repoPath: '/tmp/test',
      startedAt: '2026-04-06T10:00:00.000Z',
      completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
      waveResults: {
        assess: { wave: 'assess', success: true, artifact: {}, duration: 3000, cost: 0.1, turns: 5 },
        spec: { wave: 'spec', success: true, artifact: {}, duration: 2000, cost: 0.08, turns: 3 },
        test: { wave: 'test', success: true, artifact: {}, duration: 5000, cost: 0.12, turns: 10 },
        impl: { wave: 'impl', success: true, artifact: {}, duration: 8000, cost: 0.18, turns: 15 },
        quality: { wave: 'quality', success: true, artifact: {}, duration: 1500, cost: 0.02, turns: 4 },
        review: { wave: 'review', success: true, artifact: {}, duration: 4000, cost: 0.08, turns: 6 },
        ship: { wave: 'ship', success: true, artifact: {}, duration: 500, cost: 0, turns: 0 },
      },
      status: 'completed',
    },
  })),
}));

const { fixLoop } = await import('./loop.js');
const { installSignalHandlers, removeSignalHandlers, resetShutdown } = await import('../services/shutdown.js');

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const },
    model: {
      assess: 'large',
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
      brainstorm: 'large',
    },
    isolation: 'none',
  };
}

describe('fixLoop — graceful shutdown', () => {
  beforeEach(() => {
    resetShutdown();
  });

  afterEach(() => {
    resetShutdown();
    removeSignalHandlers();
  });

  it('stops processing after current issue when shutdown requested', async () => {
    const { fix } = await import('./fix.js');
    const mockFix = vi.mocked(fix);
    let fixCallCount = 0;
    mockFix.mockImplementation(({ issue }: { issue: Issue }) => {
      fixCallCount++;
      if (fixCallCount === 1) {
        // After first issue completes, signal shutdown
        installSignalHandlers();
        process.emit('SIGINT', 'SIGINT');
      }
      return Promise.resolve({
        success: true,
        prUrl: `https://github.com/test/repo/pull/${issue.number}`,
        state: {
          issue,
          repo: 'test-repo',
          repoPath: '/tmp/test',
          startedAt: '2026-04-06T10:00:00.000Z',
          completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'] as const,
          waveResults: {
            assess: { wave: 'assess' as const, success: true, artifact: {}, duration: 1000, cost: 0.05, turns: 2 },
          },
          status: 'completed' as const,
        },
      });
    });

    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
    });

    // Should have processed only 1 issue (stopped after first due to shutdown)
    expect(result.total).toBe(1);
    expect(fixCallCount).toBe(1);
  });

  it('processes all issues when no shutdown requested', async () => {
    const result = await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(),
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
  });
});
