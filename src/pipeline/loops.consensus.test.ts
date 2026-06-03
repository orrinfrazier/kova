// Tests for runReviewLoop consensus-pool routing (#261).
//
// When repoConfig.model.review is a WaveConsensusConfig, the review wave
// dispatches through spawnConsensusWave instead of dispatchExecuteWave. The
// adjudicated review verdict + findings drive the same loop control flow
// (PASS / NEEDS_FIXES handling, persona selection, prescan/baseline gates).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsensusWaveHandoff } from '../ai/parallel-executor.js';
import type { Issue, RepoConfig, WaveResult } from '../types/index.js';

vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    executeWaveWithRetry: vi.fn(),
    resolveThinkingLevel: actual.resolveThinkingLevel,
    isConsensusPool: actual.isConsensusPool,
    resolveConsensusPool: actual.resolveConsensusPool,
    getModelString: actual.getModelString,
  };
});

vi.mock('../ai/parallel-executor.js', () => ({
  spawnConsensusWave: vi.fn(),
}));

vi.mock('../services/consensus-disagreements.js', () => ({
  appendConsensusDisagreement: vi.fn(async () => undefined),
}));

vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({ language: 'typescript', testRunner: 'vitest' }),
}));

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock review prompt'),
  resolvePromptsDir: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./review-persona.js', () => ({
  selectReviewerPersona: vi.fn(() => 'generalist'),
  loadReviewPersonaPrompt: vi.fn(async () => 'mock review persona prompt'),
}));

vi.mock('../services/review-prescan.js', () => ({
  scanDiffForBlockingFindings: vi.fn(async () => ({ findings: [], blocking: false, summary: '' })),
}));

vi.mock('../services/baseline-failures.js', () => ({
  compareBaselineFailures: vi.fn(() => ({ newRegressions: [], preexisting: [], blocking: false, summary: '' })),
}));

const { runReviewLoop } = await import('./loops.js');
const { spawnConsensusWave } = await import('../ai/parallel-executor.js');
const { executeWaveWithRetry } = await import('../ai/index.js');

function makeIssue(): Issue {
  return { number: 1, title: 'consensus review', body: 'body', labels: [], url: 'https://x' };
}

function makeConfigWithReviewPool(): RepoConfig {
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
      review: {
        pool: [
          { provider: 'anthropic', model: 'claude-opus-4-6' },
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'google', model: 'gemini-2.5-pro' },
        ],
        adjudicator: 'large',
      },
      brainstorm: 'large',
    },
    isolation: 'none',
    runtime: 'pi',
  } as unknown as RepoConfig;
}

function makeReviewConsensusHandoff(verdict: 'pass' | 'needs_fixes' = 'pass'): ConsensusWaveHandoff<unknown> {
  return {
    wave: 'review',
    timestamp: new Date().toISOString(),
    model: 'anthropic:claude-opus-4-6',
    cost: 0.6,
    turns: 4,
    confidence: 'high',
    artifact: {
      verdict,
      findings: [],
      summary: `Adjudicated review: ${verdict}`,
    },
    approach_notes: 'consensus reached',
    consensus: {
      pool_results: [
        { model: 'anthropic:claude-opus-4-6', cost: 0.2, status: 'success' as const },
        { model: 'openai:gpt-4o', cost: 0.25, status: 'success' as const },
        { model: 'google:gemini-2.5-pro', cost: 0.15, status: 'success' as const },
      ],
      adjudicator_model: 'anthropic:claude-opus-4-6',
      degraded: false,
      agreement: 'unanimous',
    },
  };
}

describe('runReviewLoop — consensus pool routing (#261)', () => {
  beforeEach(() => {
    vi.mocked(spawnConsensusWave).mockReset();
    vi.mocked(executeWaveWithRetry).mockReset();
  });

  it('dispatches review wave through spawnConsensusWave when config.model.review is a pool', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeReviewConsensusHandoff('pass'));

    await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfigWithReviewPool(),
      waveResults: {} as Record<string, WaveResult>,
    });

    expect(spawnConsensusWave).toHaveBeenCalled();
    // Critically, the single-model executor MUST NOT be called for the review wave.
    const reviewExecuteCalls = vi.mocked(executeWaveWithRetry).mock.calls.filter((c) => c[0]?.wave === 'review');
    expect(reviewExecuteCalls).toHaveLength(0);
  });

  it('passes the resolved review pool members to spawnConsensusWave', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeReviewConsensusHandoff('pass'));

    await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfigWithReviewPool(),
      waveResults: {} as Record<string, WaveResult>,
    });

    const call = vi.mocked(spawnConsensusWave).mock.calls[0]?.[0];
    expect(call?.wave).toBe('review');
    expect(call?.poolModels).toHaveLength(3);
    // Adjudicator defaults to large tier (resolveConsensusPool default).
    expect(call?.adjudicatorModel).toBeDefined();
  });

  it('propagates verdict from consensus handoff into the loop', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeReviewConsensusHandoff('pass'));

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfigWithReviewPool(),
      waveResults: {} as Record<string, WaveResult>,
    });

    // Pass verdict → loop exits after iteration 1, no impl wave dispatched.
    expect(result.iterations).toBe(1);
  });

  it('exposes consensus metadata on the review WaveResult (telemetry)', async () => {
    vi.mocked(spawnConsensusWave).mockResolvedValueOnce(makeReviewConsensusHandoff('pass'));

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfigWithReviewPool(),
      waveResults: {} as Record<string, WaveResult>,
    });

    // WaveResult.consensus is the projection the disagreement log + downstream
    // consumers (run-report, telemetry) key off (#262). Without this the review
    // pool would run but its multi-model audit trail would be lost.
    expect(result.reviewWaveResult.consensus).toBeDefined();
    expect(result.reviewWaveResult.consensus?.pool).toEqual([
      'anthropic:claude-opus-4-6',
      'openai:gpt-4o',
      'google:gemini-2.5-pro',
    ]);
  });
});
