import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, Issue, WaveName } from '../types/index.js';

// --- Mocks ---

const mockCreateIssueComment = vi.fn();
const mockEditIssueComment = vi.fn();
const mockUpsertTrackingComment = vi.fn();

vi.mock('../vcs/github.js', () => ({
  createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
  editIssueComment: (...args: unknown[]) => mockEditIssueComment(...args),
  upsertTrackingComment: (...args: unknown[]) => mockUpsertTrackingComment(...args),
  DEFAULT_TRACKING_MARKER: '<!-- kova-tracking -->',
}));

const { ProgressTracker, formatProgressBody } = await import('./progress.js');

// --- Factories ---

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Test issue ${n}`,
    body: 'body',
    labels: [],
    url: `https://github.com/owner/repo/issues/${n}`,
  };
}

function makeState(completedWaves: WaveName[]): FixState {
  return {
    issue: makeIssue(42),
    repo: 'test-repo',
    repoPath: '/tmp/test',
    startedAt: '2026-04-07T12:00:00.000Z',
    completedWaves,
    waveResults: {},
    status: 'running',
  };
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateIssueComment.mockResolvedValue(12345);
  mockEditIssueComment.mockResolvedValue(undefined);
  mockUpsertTrackingComment.mockResolvedValue(12345);
});

describe('formatProgressBody', () => {
  it('shows all waves pending at start', () => {
    const body = formatProgressBody(makeIssue(42), [], 'running');
    expect(body).toContain('Kova is working on this issue');
    expect(body).toContain('Assess');
    expect(body).toContain('Spec');
    expect(body).toContain('Test');
    expect(body).toContain('Impl');
    expect(body).toContain('Quality');
    expect(body).toContain('Review');
    expect(body).toContain('Ship');
  });

  it('marks completed waves with checkmark', () => {
    const body = formatProgressBody(makeIssue(42), ['assess', 'spec'], 'running');
    // Completed waves should have a check mark
    expect(body).toMatch(/Assess\s+.*?done/i);
    expect(body).toMatch(/Spec\s+.*?done/i);
  });

  it('marks next pending wave as in-progress', () => {
    const body = formatProgressBody(makeIssue(42), ['assess', 'spec'], 'running');
    // The next wave (test) should show as in-progress
    expect(body).toMatch(/Test\s+.*?progress/i);
  });

  it('shows success message with PR link when completed', () => {
    const body = formatProgressBody(
      makeIssue(42),
      ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
      'completed',
      'https://github.com/owner/repo/pull/10',
    );
    expect(body).toContain('https://github.com/owner/repo/pull/10');
    expect(body).toMatch(/complete|success|done/i);
  });

  it('shows error message on failure', () => {
    const body = formatProgressBody(makeIssue(42), ['assess', 'spec'], 'failed', undefined, 'TI loop exhausted');
    expect(body).toContain('TI loop exhausted');
    expect(body).toMatch(/fail/i);
  });
});

describe('ProgressTracker', () => {
  it('creates initial comment on start()', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    await tracker.start();

    expect(mockUpsertTrackingComment).toHaveBeenCalledOnce();
    expect(mockUpsertTrackingComment).toHaveBeenCalledWith(
      'owner/repo',
      42,
      expect.stringContaining('Kova is working on this issue'),
    );
  });

  it('updates existing comment on waveCompleted()', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    await tracker.start();
    await tracker.waveCompleted('assess', makeState(['assess']));

    expect(mockEditIssueComment).toHaveBeenCalledOnce();
    expect(mockEditIssueComment).toHaveBeenCalledWith('owner/repo', 12345, expect.stringContaining('Assess'));
  });

  it('updates with PR link on complete()', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    await tracker.start();
    await tracker.complete('https://github.com/owner/repo/pull/10');

    expect(mockEditIssueComment).toHaveBeenCalledWith(
      'owner/repo',
      12345,
      expect.stringContaining('https://github.com/owner/repo/pull/10'),
    );
  });

  it('updates with error on failed()', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    await tracker.start();
    await tracker.failed('Test suite timeout');

    expect(mockEditIssueComment).toHaveBeenCalledWith(
      'owner/repo',
      12345,
      expect.stringContaining('Test suite timeout'),
    );
  });

  it('does not crash if start() was not called before waveCompleted()', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    // No start() call — should upsert (find-or-create) instead of edit by id
    await tracker.waveCompleted('assess', makeState(['assess']));

    expect(mockUpsertTrackingComment).toHaveBeenCalledOnce();
    expect(mockEditIssueComment).not.toHaveBeenCalled();
  });

  it('swallows errors from GitHub API (non-blocking)', async () => {
    mockUpsertTrackingComment.mockRejectedValue(new Error('API rate limit'));

    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    // Should not throw
    await expect(tracker.start()).resolves.toBeUndefined();
  });

  it('tracks multiple wave completions progressively', async () => {
    const tracker = new ProgressTracker({
      repoPath: '/tmp/test',
      ownerRepo: 'owner/repo',
      issue: makeIssue(42),
    });

    await tracker.start();
    await tracker.waveCompleted('assess', makeState(['assess']));
    await tracker.waveCompleted('spec', makeState(['assess', 'spec']));
    await tracker.waveCompleted('test', makeState(['assess', 'spec', 'test']));

    expect(mockEditIssueComment).toHaveBeenCalledTimes(3);

    // Last call should show 3 completed waves
    const lastBody = mockEditIssueComment.mock.calls[2]?.[2] as string;
    expect(lastBody).toBeDefined();
  });
});
