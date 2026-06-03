// Tests for the ShipEngine adapter (issue #356).
//
// ShipEngine encapsulates the git operations phase of a fix: pre-ship
// conflict detection, conditional impl retry, rebase, secrets scan, commit,
// push, PR creation. It is NOT an AI wave — it has its own input/output
// shape distinct from `WaveEngine<TInput, TOutput>`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, ReviewFinding } from '../../types/index.js';
import { createShipEngine } from './ship.js';
import type { ShipEngineContext, ShipEngineInput } from './types.js';

// Stub every git-touching service so the tests stay hermetic.
vi.mock('../../services/conflict-check.js', () => ({
  checkForConflicts: vi.fn(),
}));
vi.mock('../../services/conflict-resolver.js', () => ({
  resolveConflicts: vi.fn(),
}));
vi.mock('../../services/secrets-scan.js', () => ({
  scanForSecrets: vi.fn(),
}));
vi.mock('../../services/github.js', () => ({
  createPR: vi.fn(),
  listOpenPRs: vi.fn(),
}));
vi.mock('../../services/worktree.js', () => ({
  commitAndPush: vi.fn(),
  detectDefaultBranch: vi.fn(),
  getChangedFiles: vi.fn(),
  rebaseOnDefault: vi.fn(),
}));

const { checkForConflicts } = await import('../../services/conflict-check.js');
const { resolveConflicts } = await import('../../services/conflict-resolver.js');
const { scanForSecrets } = await import('../../services/secrets-scan.js');
const { createPR, listOpenPRs } = await import('../../services/github.js');
const { commitAndPush, detectDefaultBranch, getChangedFiles, rebaseOnDefault } = await import(
  '../../services/worktree.js'
);

const mockCheckConflicts = checkForConflicts as unknown as ReturnType<typeof vi.fn>;
const mockResolveConflicts = resolveConflicts as unknown as ReturnType<typeof vi.fn>;
const mockScanSecrets = scanForSecrets as unknown as ReturnType<typeof vi.fn>;
const mockCreatePR = createPR as unknown as ReturnType<typeof vi.fn>;
const mockListOpenPRs = listOpenPRs as unknown as ReturnType<typeof vi.fn>;
const mockCommit = commitAndPush as unknown as ReturnType<typeof vi.fn>;
const mockDetectDefault = detectDefaultBranch as unknown as ReturnType<typeof vi.fn>;
const mockGetChanged = getChangedFiles as unknown as ReturnType<typeof vi.fn>;
const mockRebase = rebaseOnDefault as unknown as ReturnType<typeof vi.fn>;

const stubIssue: Issue = {
  number: 999,
  title: 'fix the thing',
  body: 'b',
  labels: [],
  url: 'https://github.com/owner/repo/issues/999',
};

function noConflicts() {
  return {
    hasConflicts: false,
    conflictingFiles: [],
    overlapping: [],
    nonOverlapping: [],
  };
}

function ctx(overrides: Partial<ShipEngineContext> = {}): ShipEngineContext {
  return {
    workDir: '/tmp/work',
    repoPath: '/tmp/repo',
    ...overrides,
  };
}

function input(overrides: Partial<ShipEngineInput> = {}): ShipEngineInput {
  return {
    issue: stubIssue,
    branch: 'kova/fix-999',
    specFiles: ['src/a.ts'],
    openPRs: [],
    ...overrides,
  };
}

function resetAll() {
  mockCheckConflicts.mockReset();
  mockResolveConflicts.mockReset();
  mockScanSecrets.mockReset();
  mockCreatePR.mockReset();
  mockListOpenPRs.mockReset();
  mockCommit.mockReset();
  mockDetectDefault.mockReset();
  mockGetChanged.mockReset();
  mockRebase.mockReset();

  // Defaults: happy path
  mockCheckConflicts.mockResolvedValue(noConflicts());
  mockRebase.mockResolvedValue({ success: true, conflicted: false });
  mockGetChanged.mockResolvedValue(['src/a.ts']);
  mockScanSecrets.mockResolvedValue({ clean: true, findings: [], report: '' });
  mockCommit.mockResolvedValue({
    committed: true,
    filesStaged: ['src/a.ts'],
    commitMessage: 'fix: the thing (#999)',
  });
  mockListOpenPRs.mockResolvedValue([]);
  mockCreatePR.mockResolvedValue('https://github.com/owner/repo/pull/123');
  mockDetectDefault.mockResolvedValue('main');
}

describe('ShipEngine', () => {
  beforeEach(() => {
    resetAll();
  });

  it('declares name === "ship"', () => {
    const engine = createShipEngine();
    expect(engine.name).toBe('ship');
  });

  it('happy path: returns status="shipped" with prUrl', async () => {
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(result.status).toBe('shipped');
    if (result.status === 'shipped') {
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/123');
      expect(result.commitMessage).toBe('fix: the thing (#999)');
      expect(result.filesStaged).toEqual(['src/a.ts']);
    }
  });

  it('returns status="no_changes" when commitAndPush reports no commit', async () => {
    mockCommit.mockResolvedValueOnce({ committed: false, filesStaged: [] });
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(result.status).toBe('no_changes');
  });

  it('returns status="failed" with reason="secrets" when scanForSecrets finds something', async () => {
    mockScanSecrets.mockResolvedValueOnce({
      clean: false,
      findings: [{ file: 'src/a.ts', line: 1, type: 'AWS access key' }],
      report: 'AKIA...',
    });
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('secrets');
      expect(result.error.toLowerCase()).toContain('secrets');
    }
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('returns status="failed" with reason="rebase" when rebase conflicts unresolvable', async () => {
    mockRebase.mockResolvedValueOnce({
      success: false,
      conflicted: true,
      conflictFiles: ['src/a.ts'],
    });
    mockResolveConflicts.mockResolvedValueOnce({
      resolved: false,
      filesUnresolved: ['src/a.ts'],
    });
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('rebase');
      expect(result.error).toContain('src/a.ts');
    }
  });

  it('proceeds when rebase conflicts auto-resolved', async () => {
    mockRebase.mockResolvedValueOnce({
      success: false,
      conflicted: true,
      conflictFiles: ['src/a.ts'],
    });
    mockResolveConflicts.mockResolvedValueOnce({
      resolved: true,
      filesResolved: ['src/a.ts'],
    });
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(result.status).toBe('shipped');
  });

  it('runs retryParallelTILoop when overlapping conflicts detected', async () => {
    mockCheckConflicts.mockResolvedValueOnce({
      hasConflicts: true,
      conflictingFiles: ['src/a.ts'],
      overlapping: ['src/a.ts'],
      nonOverlapping: [],
    });
    const retry = vi.fn().mockResolvedValue({ testsPassing: true });
    const engine = createShipEngine();
    await engine.run(ctx(), input({ retryParallelTILoop: retry }));
    expect(retry).toHaveBeenCalledOnce();
    const arg = retry.mock.calls[0]?.[0] as { codebaseContext?: string };
    expect(arg.codebaseContext).toContain('conflict');
  });

  it('skips retryParallelTILoop when only non-overlapping conflicts', async () => {
    mockCheckConflicts.mockResolvedValueOnce({
      hasConflicts: true,
      conflictingFiles: ['unrelated.md'],
      overlapping: [],
      nonOverlapping: ['unrelated.md'],
    });
    const retry = vi.fn();
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input({ retryParallelTILoop: retry }));
    expect(retry).not.toHaveBeenCalled();
    expect(result.status).toBe('shipped');
  });

  it('threads openPRs + mergeDependencies + reviewKnownIssues into PR body sections', async () => {
    const known: ReviewFinding[] = [
      { category: 'mechanical_fix', file: 'src/b.ts', description: 'orphan', severity: 'medium' },
    ];
    mockListOpenPRs.mockResolvedValueOnce(['#42 other pr (some-branch)']);
    const engine = createShipEngine();
    await engine.run(
      ctx(),
      input({
        mergeDependencies: [10],
        reviewKnownIssues: known,
      }),
    );
    const args = mockCreatePR.mock.calls[0];
    expect(args).toBeDefined();
    const body = args?.[3] as string;
    expect(body).toContain('## Summary');
    expect(body).toContain('Fixes #999');
    expect(body).toContain('## Open PRs');
    expect(body).toContain('#42 other pr');
    expect(body).toContain('## Merge Dependencies');
    expect(body).toContain('depends on #10');
    expect(body).toContain('## Known Issues');
    expect(body).toContain('src/b.ts');
    expect(body).toContain('orphan');
  });

  it('skips secrets scan when no files changed', async () => {
    mockGetChanged.mockResolvedValueOnce([]);
    // No changes means no commit, so commitAndPush returns committed=false.
    mockCommit.mockResolvedValueOnce({ committed: false, filesStaged: [] });
    const engine = createShipEngine();
    const result = await engine.run(ctx(), input());
    expect(mockScanSecrets).not.toHaveBeenCalled();
    expect(result.status).toBe('no_changes');
  });
});
