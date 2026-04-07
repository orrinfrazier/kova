import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KovaConfig } from '../types/index.js';

// --- Mock github functions ---

const mockFetchOpenIssueCount = vi.fn();
const mockFetchKovaPRs = vi.fn();
vi.mock('../services/github.js', () => ({
  fetchOpenIssueCount: (...args: unknown[]) => mockFetchOpenIssueCount(...args),
  fetchKovaPRs: (...args: unknown[]) => mockFetchKovaPRs(...args),
}));

// --- Mock fs for .kova file reads ---

const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Dynamic import after mocks
const { gatherRepoStatus, gatherStatus, formatStatusTable, formatQueueTable } = await import('./status.js');

const SAMPLE_CONFIG: KovaConfig = {
  repos: {
    'my-app': {
      path: '/home/user/dev/my-app',
      rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const, concurrency: 1 },
      model: {
        assess: 'large',
        spec: 'large',
        test: 'medium',
        impl: 'medium',
        quality: 'small',
        review: 'large',
        brainstorm: 'large',
      },
      isolation: 'worktree',
    },
    'my-lib': {
      path: '/home/user/dev/my-lib',
      rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10, ci_merge: 'require' as const, concurrency: 1 },
      model: {
        assess: 'large',
        spec: 'large',
        test: 'medium',
        impl: 'medium',
        quality: 'small',
        review: 'large',
        brainstorm: 'large',
      },
      isolation: 'worktree',
    },
  },
};

const SAMPLE_KOVA_PRS = [
  { number: 42, title: 'fix: issue #10', branch: 'kova/fix-10', url: 'https://github.com/owner/repo/pull/42' },
  { number: 55, title: 'fix: issue #15', branch: 'kova/fix-15', url: 'https://github.com/owner/repo/pull/55' },
];

const SAMPLE_RUN_REPORT = {
  total: 3,
  succeeded: 2,
  failed: 1,
  skipped: 0,
  totalCost: 1.75,
  totalTurns: 80,
  totalDuration: 120000,
  budgetExceeded: false,
  issues: [],
  startedAt: '2026-04-01T10:00:00.000Z',
  completedAt: '2026-04-01T10:05:00.000Z',
};

const SAMPLE_COST_REPORT = {
  issueNumber: 5,
  totalCost: 0.42,
  totalTurns: 15,
  totalDuration: 30000,
  waves: [],
  startedAt: '2026-04-05T14:00:00.000Z',
  completedAt: '2026-04-05T14:02:00.000Z',
};

describe('gatherRepoStatus', () => {
  beforeEach(() => {
    mockFetchOpenIssueCount.mockReset();
    mockFetchKovaPRs.mockReset();
    mockReadFile.mockReset();
  });

  it('returns repo name, path, open issues, and kova PR count', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(12);
    mockFetchKovaPRs.mockResolvedValue(SAMPLE_KOVA_PRS);
    mockReadFile.mockRejectedValue(new Error('ENOENT')); // no .kova files

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.name).toBe('my-app');
    expect(status.path).toBe('/home/user/dev/my-app');
    expect(status.openIssues).toBe(12);
    expect(status.kovaPRs).toBe(2);
  });

  it('reads last run date from run-report.json', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(5);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('run-report.json')) {
        return JSON.stringify(SAMPLE_RUN_REPORT);
      }
      throw new Error('ENOENT');
    });

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.lastRunDate).toBe('2026-04-01T10:05:00.000Z');
  });

  it('falls back to cost-report.json for last run date', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(5);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('cost-report.json')) {
        return JSON.stringify(SAMPLE_COST_REPORT);
      }
      throw new Error('ENOENT');
    });

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.lastRunDate).toBe('2026-04-05T14:02:00.000Z');
  });

  it('reads total spend from run-report.json', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(5);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('run-report.json')) {
        return JSON.stringify(SAMPLE_RUN_REPORT);
      }
      throw new Error('ENOENT');
    });

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.totalSpend).toBe(1.75);
  });

  it('returns zero spend and null date when no .kova files exist', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(3);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.totalSpend).toBe(0);
    expect(status.lastRunDate).toBeNull();
  });

  it('handles GitHub API errors gracefully', async () => {
    mockFetchOpenIssueCount.mockRejectedValue(new Error('gh auth failed'));
    mockFetchKovaPRs.mockRejectedValue(new Error('gh auth failed'));
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const status = await gatherRepoStatus('my-app', '/home/user/dev/my-app');

    expect(status.openIssues).toBe(-1);
    expect(status.kovaPRs).toBe(-1);
  });
});

describe('gatherStatus', () => {
  beforeEach(() => {
    mockFetchOpenIssueCount.mockReset();
    mockFetchKovaPRs.mockReset();
    mockReadFile.mockReset();
  });

  it('gathers status for all repos in config', async () => {
    mockFetchOpenIssueCount.mockResolvedValue(5);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await gatherStatus(SAMPLE_CONFIG);

    expect(result.repos).toHaveLength(2);
    expect(result.repos[0]?.name).toBe('my-app');
    expect(result.repos[1]?.name).toBe('my-lib');
  });

  it('aggregates total spend across repos', async () => {
    let callCount = 0;
    mockFetchOpenIssueCount.mockResolvedValue(0);
    mockFetchKovaPRs.mockResolvedValue([]);
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('run-report.json')) {
        callCount++;
        return JSON.stringify({ ...SAMPLE_RUN_REPORT, totalCost: callCount === 1 ? 1.5 : 2.5 });
      }
      throw new Error('ENOENT');
    });

    const result = await gatherStatus(SAMPLE_CONFIG);

    expect(result.totalSpend).toBe(4.0);
  });
});

describe('formatStatusTable', () => {
  it('renders a formatted table with headers', () => {
    const result = {
      repos: [
        {
          name: 'my-app',
          path: '/home/user/dev/my-app',
          openIssues: 12,
          kovaPRs: 2,
          lastRunDate: '2026-04-01T10:05:00.000Z',
          totalSpend: 1.75,
        },
        {
          name: 'my-lib',
          path: '/home/user/dev/my-lib',
          openIssues: 3,
          kovaPRs: 0,
          lastRunDate: null,
          totalSpend: 0,
        },
      ],
      totalSpend: 1.75,
    };

    const table = formatStatusTable(result);

    expect(table).toContain('Repo');
    expect(table).toContain('Open Issues');
    expect(table).toContain('Kova PRs');
    expect(table).toContain('Last Run');
    expect(table).toContain('Spend');
    expect(table).toContain('my-app');
    expect(table).toContain('my-lib');
    expect(table).toContain('12');
    expect(table).toContain('$1.75');
    expect(table).toContain('—'); // null last run
    expect(table).toContain('Total: $1.75');
  });

  it('shows error indicator for failed repos', () => {
    const result = {
      repos: [
        {
          name: 'broken-repo',
          path: '/tmp/broken',
          openIssues: -1,
          kovaPRs: -1,
          lastRunDate: null,
          totalSpend: 0,
        },
      ],
      totalSpend: 0,
    };

    const table = formatStatusTable(result);

    expect(table).toContain('ERR');
  });

  it('formats date as relative when recent', () => {
    const now = new Date();
    const result = {
      repos: [
        {
          name: 'my-app',
          path: '/tmp/app',
          openIssues: 5,
          kovaPRs: 1,
          lastRunDate: now.toISOString(),
          totalSpend: 0.5,
        },
      ],
      totalSpend: 0.5,
    };

    const table = formatStatusTable(result);

    // Should show a relative time like "0s ago", not a raw ISO string
    expect(table).not.toContain(now.toISOString());
    expect(table).toContain('ago');
  });

  it('includes queue table when queue status is provided', () => {
    const result = {
      repos: [],
      totalSpend: 0,
      queue: {
        entries: [
          {
            request: { issueNumber: 5, repoPath: '/tmp', repoName: 'repo', score: 80, blockedBy: [] },
            status: 'running' as const,
            consecutiveFailures: 0,
          },
          {
            request: { issueNumber: 10, repoPath: '/tmp', repoName: 'repo', score: 60, blockedBy: [5] },
            status: 'blocked' as const,
            consecutiveFailures: 0,
          },
        ],
        activeSlots: 1,
        maxSlots: 3,
        completedCount: 2,
        failedCount: 0,
        skippedCount: 1,
      },
    };

    const table = formatStatusTable(result);

    expect(table).toContain('Queue (1/3 slots active)');
    expect(table).toContain('#5');
    expect(table).toContain('#10');
    expect(table).toContain('running');
    expect(table).toContain('blocked');
    expect(table).toContain('2 completed');
    expect(table).toContain('1 skipped');
  });

  it('does not include queue section when queue is undefined', () => {
    const result = {
      repos: [],
      totalSpend: 0,
    };

    const table = formatStatusTable(result);

    expect(table).not.toContain('Queue');
  });
});

describe('formatQueueTable', () => {
  it('shows empty message for empty queue', () => {
    const table = formatQueueTable({
      entries: [],
      activeSlots: 0,
      maxSlots: 2,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });

    expect(table).toContain('(empty)');
    expect(table).toContain('Queue (0/2 slots active)');
  });

  it('renders entries with headers', () => {
    const table = formatQueueTable({
      entries: [
        {
          request: { issueNumber: 1, repoPath: '/tmp', repoName: 'repo', score: 90, blockedBy: [] },
          status: 'completed' as const,
          consecutiveFailures: 0,
        },
        {
          request: { issueNumber: 2, repoPath: '/tmp', repoName: 'repo', score: 50, blockedBy: [1] },
          status: 'waiting' as const,
          consecutiveFailures: 0,
        },
      ],
      activeSlots: 0,
      maxSlots: 2,
      completedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });

    expect(table).toContain('Issue');
    expect(table).toContain('Score');
    expect(table).toContain('Status');
    expect(table).toContain('Failures');
    expect(table).toContain('Blocked By');
    expect(table).toContain('#1');
    expect(table).toContain('#2');
    expect(table).toContain('1 completed');
  });

  it('shows consecutive failure count', () => {
    const table = formatQueueTable({
      entries: [
        {
          request: { issueNumber: 7, repoPath: '/tmp', repoName: 'repo', score: 40, blockedBy: [] },
          status: 'skipped' as const,
          consecutiveFailures: 3,
        },
      ],
      activeSlots: 0,
      maxSlots: 1,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 1,
    });

    expect(table).toContain('3');
    expect(table).toContain('skipped');
    expect(table).toContain('1 skipped');
  });
});
