/**
 * Tests for supervised.ts — supervised pipeline orchestrator.
 *
 * TDD Red Phase: all tests will fail because ./supervised.ts does not exist yet.
 *
 * Flow: brainstorm() → approveIssues() → createIssue() per approved →
 *       confirm() pause → fixByNumbers() → print summary
 *
 * --skip-brainstorm: fetchIssues(repoPath, 'approved') → fixByNumbers()
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstormIssue, RepoConfig } from '../types/index.js';

/* ------------------------------------------------------------------ */
/*  Mock: brainstorm pipeline                                           */
/* ------------------------------------------------------------------ */

const mockBrainstorm = vi.fn();
vi.mock('./brainstorm.js', () => ({
  brainstorm: (...args: unknown[]) => mockBrainstorm(...args),
}));

/* ------------------------------------------------------------------ */
/*  Mock: approval service                                             */
/* ------------------------------------------------------------------ */

const mockApproveIssues = vi.fn();
vi.mock('../services/approval.js', () => ({
  approveIssues: (...args: unknown[]) => mockApproveIssues(...args),
}));

/* ------------------------------------------------------------------ */
/*  Mock: GitHub service                                               */
/* ------------------------------------------------------------------ */

const mockCreateIssue = vi.fn();
const mockFetchIssues = vi.fn();
vi.mock('../services/github.js', () => ({
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
}));

/* ------------------------------------------------------------------ */
/*  Mock: fixByNumbers (does not exist yet either)                     */
/* ------------------------------------------------------------------ */

const mockFixByNumbers = vi.fn();
vi.mock('./loop.js', () => ({
  fixByNumbers: (...args: unknown[]) => mockFixByNumbers(...args),
  fixLoop: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Mock: @clack/prompts                                               */
/* ------------------------------------------------------------------ */

const mockConfirm = vi.fn();
const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockNote = vi.fn();
const mockIsCancel = vi.fn().mockReturnValue(false);
vi.mock('@clack/prompts', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  note: (...args: unknown[]) => mockNote(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
}));

/* ------------------------------------------------------------------ */
/*  Mock: zx fs for session file I/O                                   */
/* ------------------------------------------------------------------ */

const mockFsReadFile = vi.fn();
const mockFsWriteFile = vi.fn();
const mockFsMkdir = vi.fn();
const mockFsUnlink = vi.fn();

vi.mock('zx', () => ({
  fs: {
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    unlink: (...args: unknown[]) => mockFsUnlink(...args),
  },
  $: vi.fn(),
  path: {
    join: (...parts: string[]) => parts.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  },
}));

/* ------------------------------------------------------------------ */
/*  Dynamic import after mocks are registered                          */
/* ------------------------------------------------------------------ */

const { runSupervised, clearSupervisedSession } = await import('./supervised.js');

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const SAMPLE_ISSUES: BrainstormIssue[] = [
  {
    title: 'Add input validation',
    body: 'Several endpoints accept user input without validation.',
    labels: ['bug', 'security'],
    priority: 'high',
    category: 'security',
    confidence: 0.9,
  },
  {
    title: 'Refactor error handling',
    body: 'Error handling is copy-pasted across 5 files.',
    labels: ['tech-debt'],
    priority: 'medium',
    category: 'tech-debt',
    confidence: 0.8,
  },
];

const DEFAULT_CONFIG: RepoConfig = {
  path: '/tmp/repo',
  rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
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
};

function makeBrainstormReturn(overrides?: Partial<{ success: boolean; issues: BrainstormIssue[]; error: string }>) {
  return {
    success: overrides?.success ?? true,
    issues: overrides?.issues ?? SAMPLE_ISSUES,
    filtered: [],
    cost: 0.05,
    model: 'test-model',
    error: overrides?.error,
  };
}

function makeApprovalResult(overrides?: Partial<{ approved: BrainstormIssue[]; cancelled: boolean }>) {
  return {
    approved: overrides?.approved ?? SAMPLE_ISSUES,
    rejected: 0,
    edited: 0,
    skipped: 0,
    cancelled: overrides?.cancelled ?? false,
  };
}

function makeLoopResult() {
  return {
    total: 2,
    succeeded: 2,
    failed: 0,
    skipped: 0,
    totalCost: 1.0,
    totalTurns: 50,
    totalDuration: 30000,
    budgetExceeded: false,
    startedAt: new Date().toISOString(),
    results: [],
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function setupNoSession() {
  // No session file exists — readFile throws ENOENT
  mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

function setupWriteSuccess() {
  mockFsMkdir.mockResolvedValue(undefined);
  mockFsWriteFile.mockResolvedValue(undefined);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  mockBrainstorm.mockReset();
  mockApproveIssues.mockReset();
  mockCreateIssue.mockReset();
  mockFetchIssues.mockReset();
  mockFixByNumbers.mockReset();
  mockConfirm.mockReset();
  mockIntro.mockReset();
  mockOutro.mockReset();
  mockNote.mockReset();
  mockIsCancel.mockReturnValue(false);
  mockFsReadFile.mockReset();
  mockFsWriteFile.mockReset();
  mockFsMkdir.mockReset();
  mockFsUnlink.mockReset();
});

describe('runSupervised', () => {
  describe('normal flow (brainstorm → approve → create → confirm → fix)', () => {
    it('calls brainstorm, approveIssues, createIssue, and fixByNumbers in order', async () => {
      const callOrder: string[] = [];

      setupNoSession();
      setupWriteSuccess();

      mockBrainstorm.mockImplementation(async () => {
        callOrder.push('brainstorm');
        return makeBrainstormReturn();
      });
      mockApproveIssues.mockImplementation(async () => {
        callOrder.push('approveIssues');
        return makeApprovalResult();
      });
      mockCreateIssue.mockImplementation(async () => {
        callOrder.push('createIssue');
        return { number: Math.floor(Math.random() * 100) + 1, url: 'https://github.com/test/issues/1' };
      });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockImplementation(async () => {
        callOrder.push('fixByNumbers');
        return makeLoopResult();
      });

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(callOrder.indexOf('brainstorm')).toBeLessThan(callOrder.indexOf('approveIssues'));
      expect(callOrder.indexOf('approveIssues')).toBeLessThan(callOrder.indexOf('createIssue'));
      expect(callOrder.indexOf('createIssue')).toBeLessThan(callOrder.indexOf('fixByNumbers'));
    });

    it("creates issues with 'approved' label appended to existing labels", async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      // First issue has labels ['bug', 'security'] — should have 'approved' appended
      const firstCall = mockCreateIssue.mock.calls[0] as [string, string, string, string[]];
      expect(firstCall[3]).toContain('approved');
      expect(firstCall[3]).toContain('bug');
      expect(firstCall[3]).toContain('security');

      // Second issue has labels ['tech-debt'] — should have 'approved' appended
      const secondCall = mockCreateIssue.mock.calls[1] as [string, string, string, string[]];
      expect(secondCall[3]).toContain('approved');
      expect(secondCall[3]).toContain('tech-debt');
    });

    it('returns SupervisedResult with success=true when all phases complete', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.success).toBe(true);
    });

    it('returns SupervisedResult with created issue numbers', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue
        .mockResolvedValueOnce({ number: 101, url: 'https://github.com/test/issues/101' })
        .mockResolvedValueOnce({ number: 102, url: 'https://github.com/test/issues/102' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.createdIssues).toEqual([101, 102]);
    });

    it('returns brainstormResult in the SupervisedResult', async () => {
      setupNoSession();
      setupWriteSuccess();
      const brainstormReturn = makeBrainstormReturn();
      mockBrainstorm.mockResolvedValue(brainstormReturn);
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.brainstormResult).toBeDefined();
      expect(result.brainstormResult?.success).toBe(true);
    });

    it('returns fixResult in the SupervisedResult', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      const loopResult = makeLoopResult();
      mockFixByNumbers.mockResolvedValue(loopResult);

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.fixResult).toBeDefined();
      expect(result.fixResult?.succeeded).toBe(2);
    });
  });

  describe('--skip-brainstorm flow', () => {
    it("fetches issues with 'approved' label and skips brainstorm", async () => {
      setupNoSession();
      setupWriteSuccess();
      mockFetchIssues.mockResolvedValue([
        { number: 10, title: 'Existing issue', body: 'body', labels: ['approved'], url: 'https://example.com/10' },
      ]);
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        skipBrainstorm: true,
      });

      expect(mockBrainstorm).not.toHaveBeenCalled();
      expect(mockFetchIssues).toHaveBeenCalledWith('/tmp/repo', 'approved');
    });

    it('calls fixByNumbers with fetched issue numbers when skipBrainstorm=true', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockFetchIssues.mockResolvedValue([
        { number: 10, title: 'Issue A', body: 'body', labels: ['approved'], url: 'https://example.com/10' },
        { number: 11, title: 'Issue B', body: 'body', labels: ['approved'], url: 'https://example.com/11' },
      ]);
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        skipBrainstorm: true,
      });

      expect(mockFixByNumbers).toHaveBeenCalled();
      const callArgs = mockFixByNumbers.mock.calls[0]?.[0] as { issueNumbers: number[] };
      expect(callArgs.issueNumbers).toContain(10);
      expect(callArgs.issueNumbers).toContain(11);
    });

    it('returns success=true when skip-brainstorm flow completes', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockFetchIssues.mockResolvedValue([
        { number: 10, title: 'Issue A', body: 'body', labels: ['approved'], url: 'https://example.com/10' },
      ]);
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      const result = await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        skipBrainstorm: true,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('failure cases', () => {
    it('stops and returns success=false if brainstorm fails', async () => {
      setupNoSession();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn({ success: false, issues: [], error: 'Agent crashed' }));

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockApproveIssues).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockFixByNumbers).not.toHaveBeenCalled();
    });

    it('stops and returns success=false if approval is cancelled (Ctrl-C)', async () => {
      setupNoSession();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult({ cancelled: true, approved: [] }));

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockFixByNumbers).not.toHaveBeenCalled();
    });

    it('returns success=true with empty fixResult if no issues are approved', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult({ approved: [], cancelled: false }));

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.success).toBe(true);
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockFixByNumbers).not.toHaveBeenCalled();
      expect(result.createdIssues).toEqual([]);
    });

    it('stops if user declines confirm before fix phase', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(false);

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(mockFixByNumbers).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  describe('pause before fix phase', () => {
    it('calls confirm before starting fix phase', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(mockConfirm).toHaveBeenCalled();
    });

    it('exits cleanly (success=false, status=interrupted) when Ctrl-C at confirm pause', async () => {
      const cancelSymbol = Symbol('cancel');
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(cancelSymbol);
      mockIsCancel.mockImplementation((val) => val === cancelSymbol);

      const result = await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(result.success).toBe(false);
      expect(mockFixByNumbers).not.toHaveBeenCalled();
    });
  });

  describe('checkpoint / session state', () => {
    it('saves session state to .kova/supervised-session.json after issue creation', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue
        .mockResolvedValueOnce({ number: 201, url: 'https://github.com/test/issues/201' })
        .mockResolvedValueOnce({ number: 202, url: 'https://github.com/test/issues/202' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      // The session file should have been written
      expect(mockFsWriteFile).toHaveBeenCalled();
      const writeCall = mockFsWriteFile.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('supervised-session.json'),
      );
      expect(writeCall).toBeDefined();

      // The content should be parseable and contain issue numbers + phase
      const writtenContent = JSON.parse(writeCall?.[1] as string) as {
        phase: string;
        issueNumbers: number[];
      };
      expect(writtenContent.phase).toBe('fixing');
      expect(writtenContent.issueNumbers).toContain(201);
      expect(writtenContent.issueNumbers).toContain(202);
    });

    it('resumes from session state — skips brainstorm when phase=fixing', async () => {
      const sessionState = {
        phase: 'fixing',
        issueNumbers: [301, 302],
        createdAt: new Date().toISOString(),
        repoPath: '/tmp/repo',
      };
      // Session file exists
      mockFsReadFile.mockResolvedValue(JSON.stringify(sessionState));
      setupWriteSuccess();
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(mockBrainstorm).not.toHaveBeenCalled();
      expect(mockApproveIssues).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();

      // fixByNumbers should be called with the saved issue numbers
      expect(mockFixByNumbers).toHaveBeenCalled();
      const callArgs = mockFixByNumbers.mock.calls[0]?.[0] as { issueNumbers: number[] };
      expect(callArgs.issueNumbers).toContain(301);
      expect(callArgs.issueNumbers).toContain(302);
    });
  });

  describe('option forwarding', () => {
    it('passes budgetUsd to fixByNumbers when provided', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        budgetUsd: 2.5,
      });

      const callArgs = mockFixByNumbers.mock.calls[0]?.[0] as { budgetUsd?: number };
      expect(callArgs.budgetUsd).toBe(2.5);
    });

    it('passes threshold and focus to brainstorm when provided', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        threshold: 0.85,
        focus: ['security', 'performance'],
      });

      const brainstormArgs = mockBrainstorm.mock.calls[0]?.[0] as { threshold?: number; focus?: string[] };
      expect(brainstormArgs.threshold).toBe(0.85);
      expect(brainstormArgs.focus).toEqual(['security', 'performance']);
    });

    it('passes autoApprove to approveIssues when yes=true', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());

      await runSupervised({
        repoPath: '/tmp/repo',
        repoName: 'test-repo',
        config: DEFAULT_CONFIG,
        yes: true,
      });

      expect(mockApproveIssues).toHaveBeenCalledWith(expect.anything(), { autoApprove: true });
    });
  });

  describe('session cleanup', () => {
    it('clears session file after successful fix phase', async () => {
      setupNoSession();
      setupWriteSuccess();
      mockBrainstorm.mockResolvedValue(makeBrainstormReturn());
      mockApproveIssues.mockResolvedValue(makeApprovalResult());
      mockCreateIssue.mockResolvedValue({ number: 1, url: 'https://github.com/test/issues/1' });
      mockConfirm.mockResolvedValue(true);
      mockFixByNumbers.mockResolvedValue(makeLoopResult());
      mockFsUnlink.mockResolvedValue(undefined);

      await runSupervised({ repoPath: '/tmp/repo', repoName: 'test-repo', config: DEFAULT_CONFIG });

      expect(mockFsUnlink).toHaveBeenCalled();
      const unlinkPath = mockFsUnlink.mock.calls[0]?.[0] as string;
      expect(unlinkPath).toContain('supervised-session.json');
    });
  });
});

describe('clearSupervisedSession', () => {
  it('removes the supervised-session.json file', async () => {
    mockFsUnlink.mockResolvedValue(undefined);

    await clearSupervisedSession('/tmp/repo');

    expect(mockFsUnlink).toHaveBeenCalled();
    const unlinkPath = mockFsUnlink.mock.calls[0]?.[0] as string;
    expect(unlinkPath).toContain('supervised-session.json');
  });

  it('is a no-op when session file does not exist', async () => {
    mockFsUnlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    // Should not throw
    await expect(clearSupervisedSession('/tmp/repo')).resolves.toBeUndefined();
  });
});
