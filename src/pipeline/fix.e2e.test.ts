// End-to-end test with mock SDK — verifies the full pipeline without hitting the API.
// Mocks query() at the SDK level, lets the real wave-executor, checkpoint, and pipeline run.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixState, Issue, RepoConfig, WaveName } from '../types/index.js';

// ---------------------------------------------------------------------------
// Canned structured outputs per wave
// ---------------------------------------------------------------------------

const ASSESS_PASS = {
  grade: 'A',
  surface_area: { files: ['src/foo.ts'], estimated_lines: 30, modules_affected: ['core'] },
  risk: 'low',
  reasoning: 'Small, well-scoped change',
  should_proceed: true,
};

const ASSESS_FAIL = {
  grade: 'F',
  surface_area: { files: [], estimated_lines: 5000, modules_affected: ['everything'] },
  risk: 'critical',
  reasoning: 'Complete rewrite needed',
  should_proceed: false,
};

const SPEC_RESULT = {
  summary: 'Add validation to input handler',
  pieces: [
    {
      name: 'input-validation',
      description: 'Validate user input',
      files: ['src/handler.ts'],
      acceptance_criteria: ['rejects empty input', 'trims whitespace'],
      wiring: ['export from index.ts'],
    },
  ],
  dependency_order: [[0]],
  constraints: ['Must not break existing API'],
};

const REVIEW_PASS = {
  verdict: 'pass',
  findings: [],
  summary: 'Looks good',
};

const REVIEW_NEEDS_FIXES = {
  verdict: 'needs_fixes',
  findings: [
    {
      category: 'mechanical_fix',
      file: 'src/handler.ts',
      line: 10,
      description: 'Unused import',
      severity: 'low',
    },
  ],
  summary: 'Minor fix needed',
};

// ---------------------------------------------------------------------------
// Mock SDK query() — returns async generators with canned message sequences
// ---------------------------------------------------------------------------

interface WaveResponse {
  result?: string;
  cost?: number;
  model?: string;
  structuredOutput?: unknown;
  error?: string;
}

async function* mockQueryGenerator(response: WaveResponse): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', model: response.model ?? 'claude-opus-4-6' };
  if (response.error) {
    yield { type: 'assistant', error: response.error };
    return;
  }
  yield { type: 'assistant' };
  yield {
    type: 'result',
    result: response.result ?? 'completed',
    total_cost_usd: response.cost ?? 0.05,
    ...(response.structuredOutput !== undefined && { structured_output: response.structuredOutput }),
  };
}

function happyPathResponses(): WaveResponse[] {
  return [
    { structuredOutput: ASSESS_PASS, cost: 0.1 },
    { structuredOutput: SPEC_RESULT, cost: 0.08 },
    { result: 'Tests written: 3 test files', cost: 0.06 },
    { result: 'Implementation complete, all tests passing', cost: 0.07 },
    { result: 'All quality gates pass', cost: 0.02 },
    { structuredOutput: REVIEW_PASS, cost: 0.09 },
  ];
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockCreatePR = vi.fn().mockResolvedValue('https://github.com/test/repo/pull/42');
const mockListOpenPRs = vi.fn().mockResolvedValue(['#10: Other fix (kova/fix-10)']);
const mockCommentOnIssue = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/github.js', () => ({
  listOpenPRs: (...args: unknown[]) => mockListOpenPRs(...args),
  createPR: (...args: unknown[]) => mockCreatePR(...args),
  commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
}));

// Mock language-detect — avoid filesystem probing in test tmpdirs
vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest', linter: 'biome' }),
  formatToolingContext: vi.fn().mockReturnValue('Language: typescript\nTest runner: vitest\nLinter: biome'),
}));

const mockCreateWorktree = vi.fn();
const mockRemoveWorktree = vi.fn().mockResolvedValue(undefined);
const mockCommitAndPush = vi.fn().mockResolvedValue({
  committed: true,
  filesStaged: ['src/handler.ts', 'src/handler.test.ts'],
  commitMessage: 'fix: Test issue (#7)',
});
vi.mock('../services/worktree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/worktree.js')>();
  return {
    ...original,
    createWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
    removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
    commitAndPush: (...args: unknown[]) => mockCommitAndPush(...args),
  };
});

const { fix } = await import('./fix.js');
const { loadCheckpoint } = await import('../services/checkpoint.js');

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Test issue ${n}`,
    body: 'Fix the broken handler',
    labels: ['bug'],
    url: `https://github.com/test/repo/issues/${n}`,
  };
}

function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    path: '/tmp/test-repo',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
    model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
    isolation: 'none',
    ...overrides,
  };
}

function setupQuerySequence(responses: WaveResponse[]): void {
  let callIndex = 0;
  mockQuery.mockImplementation(() => {
    const response = responses[callIndex++];
    if (!response) {
      throw new Error(`Unexpected query() call #${callIndex} — only ${responses.length} responses configured`);
    }
    return mockQueryGenerator(response);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fix — E2E with mock SDK', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-e2e-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('full pipeline happy path', () => {
    it('runs all waves assess -> spec -> test -> impl -> quality -> review -> ship', async () => {
      setupQuerySequence(happyPathResponses());

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.success).toBe(true);
      expect(result.prUrl).toBe('https://github.com/test/repo/pull/42');
      expect(mockQuery).toHaveBeenCalledTimes(6);

      const allWaves: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];
      expect(result.state.completedWaves).toEqual(allWaves);
      expect(result.state.status).toBe('completed');
    });

    it('passes wave-specific prompts through to query()', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const firstCallPrompt = mockQuery.mock.calls[0]?.[0]?.prompt as string;
      expect(firstCallPrompt).toContain('Issue #7');
      expect(firstCallPrompt).toContain('Test issue 7');

      const secondCallPrompt = mockQuery.mock.calls[1]?.[0]?.prompt as string;
      expect(secondCallPrompt).toContain('Assessment');
    });

    it('uses correct model tiers per wave', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const models = mockQuery.mock.calls.map((c) => (c[0] as { options: { model: string } }).options.model);
      expect(models[0]).toBe('claude-opus-4-6');
      expect(models[1]).toBe('claude-opus-4-6');
      expect(models[2]).toBe('claude-sonnet-4-6');
      expect(models[3]).toBe('claude-sonnet-4-6');
      expect(models[4]).toBe('claude-haiku-4-5-20251001');
      expect(models[5]).toBe('claude-opus-4-6');
    });

    it('accumulates cost across waves in state', async () => {
      setupQuerySequence(happyPathResponses());

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.state.waveResults.assess?.cost).toBe(0.1);
      expect(result.state.waveResults.spec?.cost).toBe(0.08);

      const totalCost = Object.values(result.state.waveResults)
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .reduce((sum, r) => sum + r.cost, 0);
      expect(totalCost).toBeGreaterThan(0);
    });
  });

  describe('checkpoint saves after each wave', () => {
    it('persists checkpoint to disk after every AI wave', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const finalCheckpoint = await loadCheckpoint(workDir);
      expect(finalCheckpoint).not.toBeNull();
      expect(finalCheckpoint?.completedWaves).toEqual(['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship']);
      expect(finalCheckpoint?.status).toBe('completed');
    });

    it('writes checkpoint file with correct structure', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const raw = await readFile(join(workDir, '.kova', 'state.json'), 'utf-8');
      const checkpoint = JSON.parse(raw) as FixState;

      expect(checkpoint.issue.number).toBe(7);
      expect(checkpoint.repo).toBe('test-repo');
      expect(checkpoint.status).toBe('completed');

      for (const wave of ['assess', 'spec', 'test', 'impl', 'quality', 'review'] as const) {
        const wr = checkpoint.waveResults[wave];
        expect(wr).toBeDefined();
        expect(wr?.wave).toBe(wave);
        expect(wr?.success).toBe(true);
        expect(typeof wr?.duration).toBe('number');
        expect(typeof wr?.cost).toBe('number');
      }

      const ship = checkpoint.waveResults.ship;
      expect(ship).toBeDefined();
      const shipArtifact = ship?.artifact as { prUrl: string; filesStaged: string[] };
      expect(shipArtifact.prUrl).toBe('https://github.com/test/repo/pull/42');
      expect(shipArtifact.filesStaged).toContain('src/handler.ts');
    });

    it('preserves structured output in wave artifacts', async () => {
      setupQuerySequence(happyPathResponses());

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const assess = result.state.waveResults.assess?.artifact as typeof ASSESS_PASS;
      expect(assess.grade).toBe('A');
      expect(assess.should_proceed).toBe(true);
      expect(assess.surface_area.files).toContain('src/foo.ts');

      const spec = result.state.waveResults.spec?.artifact as typeof SPEC_RESULT;
      expect(spec.summary).toBe('Add validation to input handler');
      expect(spec.pieces).toHaveLength(1);

      const review = result.state.waveResults.review?.artifact as typeof REVIEW_PASS;
      expect(review.verdict).toBe('pass');

      expect(result.state.waveResults.test?.artifact).toBe('Tests written: 3 test files');
      expect(result.state.waveResults.impl?.artifact).toBe('Implementation complete, all tests passing');
    });
  });

  describe('worktree creation and cleanup', () => {
    it('creates worktree when isolation=worktree and cleans up on success', async () => {
      setupQuerySequence(happyPathResponses());
      mockCreateWorktree.mockResolvedValue({ path: workDir, branch: 'kova/fix-7' });

      const result = await fix({
        issue: makeIssue(7),
        repoPath: '/tmp/test-repo',
        repoName: 'test-repo',
        config: makeConfig({ isolation: 'worktree' }),
      });

      expect(result.success).toBe(true);
      expect(mockCreateWorktree).toHaveBeenCalledOnce();
      expect(mockCreateWorktree).toHaveBeenCalledWith('/tmp/test-repo', 7);
      expect(mockRemoveWorktree).toHaveBeenCalledOnce();
      expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/test-repo', workDir);
    });

    it('does NOT create worktree when isolation=none', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig({ isolation: 'none' }),
      });

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('keeps worktree on failure for debugging', async () => {
      const wtDir = await mkdtemp(join(tmpdir(), 'kova-wt-'));
      try {
        let callIndex = 0;
        mockQuery.mockImplementation(() => {
          const i = callIndex++;
          if (i === 0) return mockQueryGenerator({ structuredOutput: ASSESS_PASS, cost: 0.1 });
          return mockQueryGenerator({ error: 'authentication_failed' });
        });
        mockCreateWorktree.mockResolvedValue({ path: wtDir, branch: 'kova/fix-7' });

        const result = await fix({
          issue: makeIssue(7),
          repoPath: '/tmp/test-repo',
          repoName: 'test-repo',
          config: makeConfig({ isolation: 'worktree' }),
        });

        expect(result.success).toBe(false);
        expect(result.state.status).toBe('failed');
        expect(mockCreateWorktree).toHaveBeenCalledOnce();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
      } finally {
        await rm(wtDir, { recursive: true, force: true });
      }
    }, 20_000);
  });

  describe('PR creation', () => {
    it('creates PR with correct title, body, and branch', async () => {
      setupQuerySequence(happyPathResponses());

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(mockCreatePR).toHaveBeenCalledOnce();
      const [prRepoPath, branch, title, body] = mockCreatePR.mock.calls[0] as [string, string, string, string];
      expect(prRepoPath).toBe(workDir);
      expect(branch).toBe('kova/fix-7');
      expect(title).toBe('fix: Test issue 7 (#7)');
      expect(body).toContain('Fixes #7');
      expect(body).toContain('Test issue 7');
      expect(body).toContain('Open PRs');
    });

    it('includes open PRs in PR body', async () => {
      setupQuerySequence(happyPathResponses());
      mockListOpenPRs.mockResolvedValue(['#10: Other fix (kova/fix-10)', '#11: Another fix (kova/fix-11)']);

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      const body = mockCreatePR.mock.calls[0]?.[3] as string;
      expect(body).toContain('#10: Other fix');
      expect(body).toContain('#11: Another fix');
    });

    it('skips PR when no changes committed', async () => {
      setupQuerySequence(happyPathResponses());
      mockCommitAndPush.mockResolvedValue({ committed: false, filesStaged: [] });

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.success).toBe(true);
      expect(result.prUrl).toBeUndefined();
      expect(mockCreatePR).not.toHaveBeenCalled();
    });

    it('calls commitAndPush with correct branch from worktree', async () => {
      setupQuerySequence(happyPathResponses());
      mockCreateWorktree.mockResolvedValue({ path: workDir, branch: 'kova/fix-7' });

      await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig({ isolation: 'worktree' }),
      });

      expect(mockCommitAndPush).toHaveBeenCalledWith(
        workDir,
        'kova/fix-7',
        expect.objectContaining({ number: 7, title: 'Test issue 7' }),
      );
    });
  });

  describe('assess gate', () => {
    it('stops pipeline when assess says should_proceed=false', async () => {
      setupQuerySequence([{ structuredOutput: ASSESS_FAIL, cost: 0.05 }]);

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
        noComment: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('graded F');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.state.completedWaves).toEqual(['assess']);
      expect(mockCommitAndPush).not.toHaveBeenCalled();
      expect(mockCreatePR).not.toHaveBeenCalled();
    });
  });

  describe('review loop', () => {
    it('re-runs impl + quality when review returns needs_fixes', async () => {
      setupQuerySequence([
        { structuredOutput: ASSESS_PASS, cost: 0.1 },
        { structuredOutput: SPEC_RESULT, cost: 0.08 },
        { result: 'Tests written', cost: 0.06 },
        { result: 'Implemented', cost: 0.07 },
        { result: 'Quality OK', cost: 0.02 },
        { structuredOutput: REVIEW_NEEDS_FIXES, cost: 0.09 },
        { result: 'Fixed unused import', cost: 0.03 },
        { result: 'Quality OK after fixes', cost: 0.02 },
      ]);

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.success).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(8);

      const reimplPrompt = mockQuery.mock.calls[6]?.[0]?.prompt as string;
      expect(reimplPrompt).toContain('review findings');
      expect(reimplPrompt).toContain('Unused import');
    });
  });

  describe('failure handling', () => {
    it('saves failed state to checkpoint when wave throws', async () => {
      let callIndex = 0;
      mockQuery.mockImplementation(() => {
        const i = callIndex++;
        if (i === 0) return mockQueryGenerator({ structuredOutput: ASSESS_PASS, cost: 0.1 });
        return mockQueryGenerator({ error: 'authentication_failed' });
      });

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.success).toBe(false);
      expect(result.state.status).toBe('failed');

      const checkpoint = await loadCheckpoint(workDir);
      expect(checkpoint?.status).toBe('failed');
      expect(checkpoint?.error).toBeDefined();
    }, 20_000);

    it('records partial progress in checkpoint on mid-pipeline failure', async () => {
      const successResponses: WaveResponse[] = [
        { structuredOutput: ASSESS_PASS },
        { structuredOutput: SPEC_RESULT },
        { result: 'Tests written' },
      ];
      let callIndex = 0;
      mockQuery.mockImplementation(() => {
        const i = callIndex++;
        if (i < successResponses.length) return mockQueryGenerator(successResponses[i]!);
        return mockQueryGenerator({ error: 'authentication_failed' });
      });

      const result = await fix({
        issue: makeIssue(7),
        repoPath: workDir,
        repoName: 'test-repo',
        config: makeConfig(),
      });

      expect(result.success).toBe(false);

      const checkpoint = await loadCheckpoint(workDir);
      expect(checkpoint?.completedWaves).toContain('assess');
      expect(checkpoint?.completedWaves).toContain('spec');
      expect(checkpoint?.completedWaves).toContain('test');
      expect(checkpoint?.completedWaves).not.toContain('impl');
    }, 20_000);
  });
});
