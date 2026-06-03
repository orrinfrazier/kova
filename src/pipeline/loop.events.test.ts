/**
 * fixLoop / fixByNumbers share one EventBus across concurrent fixes so
 * external SSE/daemon subscribers (#291, #293) see a single event stream
 * regardless of which fix() call emits the event. Issue #340.
 *
 * What is verified here:
 *   - When LoopOptions.eventBus is provided, every fix() call receives the
 *     same EventBus reference.
 *   - When omitted, the loop resolves to the process-singleton
 *     getDefaultEventBus() so existing CLI/test callers see no behavior change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, getDefaultEventBus } from '../services/event-bus/bus.js';
import type { Issue, RepoConfig } from '../types/index.js';

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

const fetchIssuesMock = vi.fn();
const fetchIssueMock = vi.fn();

vi.mock('../services/github.js', () => ({
  fetchIssues: (...args: unknown[]) => fetchIssuesMock(...args),
  fetchIssue: (...args: unknown[]) => fetchIssueMock(...args),
  fetchMilestoneCounts: vi.fn().mockResolvedValue({ open: 0, closed: 0 }),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
  hasExistingWork: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: vi.fn().mockResolvedValue([]),
  extractPRFromResult: vi.fn().mockReturnValue(undefined),
}));

const fixMock = vi.fn();
vi.mock('./fix.js', () => ({
  fix: (...args: unknown[]) => fixMock(...args),
}));

const { fixLoop, fixByNumbers } = await import('./loop.js');

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Test issue ${n}`,
    body: '',
    labels: [],
    url: `https://github.com/test/repo/issues/${n}`,
  };
}

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
      concurrency: 1,
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  fixMock.mockImplementation(async ({ issue }: { issue: Issue }) => ({
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: {
      issue,
      repo: 'test-repo',
      repoPath: '/tmp/test',
      startedAt: '2026-06-02T22:30:00.000Z',
      completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
      waveResults: {},
      status: 'completed' as const,
    },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('fixLoop shares one EventBus across concurrent fixes (issue #340)', () => {
  it('forwards a caller-provided EventBus into every fix() call', async () => {
    const sharedBus = new EventBus();
    fetchIssuesMock.mockResolvedValueOnce([makeIssue(1), makeIssue(2), makeIssue(3)]);

    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test/repo',
      config: makeConfig(),
      eventBus: sharedBus,
    });

    expect(fixMock).toHaveBeenCalledTimes(3);
    for (const call of fixMock.mock.calls) {
      const [opts] = call as [{ eventBus?: EventBus }];
      expect(opts.eventBus).toBe(sharedBus);
    }
  });

  it('falls back to getDefaultEventBus() when no eventBus is provided', async () => {
    fetchIssuesMock.mockResolvedValueOnce([makeIssue(4)]);
    const defaultBus = getDefaultEventBus();

    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test/repo',
      config: makeConfig(),
    });

    expect(fixMock).toHaveBeenCalledTimes(1);
    const [opts] = fixMock.mock.calls[0] as [{ eventBus?: EventBus }];
    expect(opts.eventBus).toBe(defaultBus);
  });
});

describe('fixByNumbers shares one EventBus across fixes (issue #340)', () => {
  it('forwards a caller-provided EventBus into every fix() call', async () => {
    const sharedBus = new EventBus();
    fetchIssueMock.mockImplementation((_p: string, n: number) => Promise.resolve(makeIssue(n)));

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test/repo',
      config: makeConfig(),
      issueNumbers: [10, 11],
      eventBus: sharedBus,
    });

    expect(fixMock).toHaveBeenCalledTimes(2);
    for (const call of fixMock.mock.calls) {
      const [opts] = call as [{ eventBus?: EventBus }];
      expect(opts.eventBus).toBe(sharedBus);
    }
  });

  it('falls back to getDefaultEventBus() when no eventBus is provided', async () => {
    fetchIssueMock.mockImplementation((_p: string, n: number) => Promise.resolve(makeIssue(n)));
    const defaultBus = getDefaultEventBus();

    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test/repo',
      config: makeConfig(),
      issueNumbers: [20],
    });

    expect(fixMock).toHaveBeenCalledTimes(1);
    const [opts] = fixMock.mock.calls[0] as [{ eventBus?: EventBus }];
    expect(opts.eventBus).toBe(defaultBus);
  });
});
