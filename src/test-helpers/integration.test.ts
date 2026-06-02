/**
 * Integration test — runs the full fix pipeline against a fixture repo
 * with mock SDK, verifying wave progression and artifact creation.
 *
 * This is a higher-level test than fix.e2e.test.ts: it uses the shared
 * test helpers from test-helpers/ instead of inline mocks.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANNED,
  createMockTestRunner,
  createTypeScriptFixture,
  happyPathResponses,
  makeConfig,
  makeIssue,
  setupResponseSequence,
  type TempRepo,
} from './index.js';

// ---------------------------------------------------------------------------
// Module mocks — installed once, configured per test via setupResponseSequence
// ---------------------------------------------------------------------------

const mockAgentConstructor = vi.fn();

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: mockAgentConstructor,
}));

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return { ...original, streamSimple: vi.fn() };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return { ...original, convertToLlm: (msgs: unknown[]) => msgs };
});

const mockCreatePR = vi.fn().mockResolvedValue('https://github.com/test/repo/pull/99');
const mockListOpenPRs = vi.fn().mockResolvedValue([]);
const mockCommentOnIssue = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/github.js', () => ({
  listOpenPRs: (...args: unknown[]) => mockListOpenPRs(...args),
  createPR: (...args: unknown[]) => mockCreatePR(...args),
  commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
}));

vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest', linter: 'biome' }),
  formatToolingContext: vi.fn().mockReturnValue('Language: typescript\nTest runner: vitest\nLinter: biome'),
}));

const mockCreateWorktree = vi.fn();
const mockRemoveWorktree = vi.fn().mockResolvedValue(undefined);
const mockCommitAndPush = vi.fn().mockResolvedValue({
  committed: true,
  filesStaged: ['src/validate.ts'],
  commitMessage: 'fix: Fix login bug (#42)',
});
vi.mock('../services/worktree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/worktree.js')>();
  return {
    ...original,
    createWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
    removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
    commitAndPush: (...args: unknown[]) => mockCommitAndPush(...args),
    rebaseOnDefault: vi.fn().mockResolvedValue({ success: true, conflicted: false }),
  };
});

vi.mock('../services/conflict-check.js', () => ({
  checkForConflicts: vi.fn().mockResolvedValue({
    hasConflicts: false,
    conflictingFiles: [],
    overlapping: [],
    nonOverlapping: [],
  }),
}));

vi.mock('../services/conflict-resolver.js', () => ({
  resolveConflicts: vi.fn().mockResolvedValue({ resolved: true, filesResolved: [] }),
}));

const { fix } = await import('../pipeline/fix.js');
const { loadCheckpoint } = await import('../services/checkpoint.js');

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------

describe('integration: fix pipeline with shared test helpers', () => {
  let fixture: TempRepo | undefined;
  const mockTestRunner = createMockTestRunner();

  function fixturePath(): string {
    if (!fixture) throw new Error('fixture not initialized');
    return fixture.path;
  }

  beforeEach(async () => {
    fixture = await createTypeScriptFixture();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it('completes full pipeline against TypeScript fixture', async () => {
    const seqState = setupResponseSequence(mockAgentConstructor, happyPathResponses());

    const result = await fix({
      issue: makeIssue(42, { title: 'Fix email validation', body: 'validateEmail accepts invalid emails' }),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    expect(result.success).toBe(true);
    expect(result.state.status).toBe('completed');
    expect(result.state.completedWaves).toEqual(['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship']);
    expect(result.prUrl).toBe('https://github.com/test/repo/pull/99');
    expect(seqState.callIndex).toBe(6); // 6 Agent constructor calls
  });

  it('persists checkpoint with wave results', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());

    await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    const checkpoint = await loadCheckpoint(fixturePath());
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.status).toBe('completed');
    expect(checkpoint?.waveResults.assess).toBeDefined();
    expect(checkpoint?.waveResults.assess?.success).toBe(true);
    expect(checkpoint?.waveResults.review).toBeDefined();
  });

  it('writes handoff files for each wave', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());

    await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    for (const wave of ['assess', 'spec', 'test', 'impl', 'quality', 'review'] as const) {
      const handoffPath = join(fixturePath(), '.kova', 'handoffs', `${wave}.json`);
      const content = JSON.parse(await readFile(handoffPath, 'utf-8')) as { wave: string };
      expect(content.wave).toBe(wave);
    }
  });

  it('stores assess artifact with correct grade', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());

    const result = await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    const assess = result.state.waveResults.assess?.artifact as typeof CANNED.ASSESS_PASS;
    expect(assess.grade).toBe('A');
    expect(assess.should_proceed).toBe(true);
  });

  it('stops pipeline when assess says should_proceed=false', async () => {
    setupResponseSequence(mockAgentConstructor, [{ structuredOutput: CANNED.ASSESS_FAIL, cost: 0.1 }]);

    const result = await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    expect(result.success).toBe(false);
    expect(result.state.completedWaves).toContain('assess');
    expect(result.state.completedWaves).not.toContain('spec');
  });

  it('handles agent error mid-pipeline gracefully', async () => {
    setupResponseSequence(mockAgentConstructor, [
      { structuredOutput: CANNED.ASSESS_PASS, cost: 0.1 },
      { error: 'rate limit exceeded' },
    ]);

    const result = await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    expect(result.success).toBe(false);
    expect(result.state.status).toBe('failed');
    expect(result.state.completedWaves).toContain('assess');

    // Checkpoint should still be written
    const checkpoint = await loadCheckpoint(fixturePath());
    expect(checkpoint?.waveResults.assess).toBeDefined();
  });

  it('creates PR with correct arguments', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());

    await fix({
      issue: makeIssue(42, { title: 'Fix email validation' }),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    expect(mockCreatePR).toHaveBeenCalledOnce();
    const [repoPath, branch, title, body] = mockCreatePR.mock.calls[0] as [string, string, string, string];
    expect(repoPath).toBe(fixturePath());
    expect(branch).toBe('kova/fix-42');
    expect(title).toContain('Fix email validation');
    expect(body).toContain('Fixes #42');
  });

  it('uses worktree isolation when configured', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());
    mockCreateWorktree.mockResolvedValue({ path: fixturePath(), branch: 'kova/fix-42' });

    const result = await fix({
      issue: makeIssue(42),
      repoPath: '/tmp/original-repo',
      repoName: 'ts-fixture',
      config: makeConfig({ isolation: 'worktree' }),
      testRunner: mockTestRunner,
    });

    expect(result.success).toBe(true);
    expect(mockCreateWorktree).toHaveBeenCalledOnce();
    expect(mockRemoveWorktree).toHaveBeenCalledOnce();
  });

  it('.kova directory is created in fixture path', async () => {
    setupResponseSequence(mockAgentConstructor, happyPathResponses());

    await fix({
      issue: makeIssue(42),
      repoPath: fixturePath(),
      repoName: 'ts-fixture',
      config: makeConfig(),
      testRunner: mockTestRunner,
    });

    const kovaDir = await stat(join(fixturePath(), '.kova'));
    expect(kovaDir.isDirectory()).toBe(true);
  });
});
