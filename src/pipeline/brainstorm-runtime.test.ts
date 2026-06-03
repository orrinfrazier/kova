import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, WaveHandoff } from '../types/index.js';
import type { BrainstormHistory, DiminishingReturnsReport } from './brainstorm-history.js';

// --- Capturing mock for spawnWaveAgent (issue #407) ---

const mockSpawnWaveAgent = vi.fn();
// Partial mock so runtime helpers used by ./runtime-select.js stay real —
// only the wave-spawn surface is faked. (See vitest "partial mock" pattern.)
vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveWaveModel: vi.fn().mockReturnValue({ id: 'test-model', provider: 'anthropic' }),
    spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
    getWaveTools: vi.fn().mockReturnValue([]),
    resolveThinkingLevel: vi.fn().mockReturnValue('medium'),
    getModelString: (model: { provider: string; id: string }) => `${model.provider}:${model.id}`,
  };
});

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('You are brainstorming issues.'),
  resolvePromptsDir: vi.fn().mockReturnValue(undefined),
}));

const mockFetchCrossRepoIssues = vi.fn();
const mockFormatCrossRepoContext = vi.fn();
const mockFetchSameRepoIssues = vi.fn();
const mockFormatSameRepoContext = vi.fn();
const mockClassifyProposalsAgainstOpenIssues = vi.fn();
vi.mock('./cross-repo-issues.js', () => ({
  fetchCrossRepoIssues: (...args: unknown[]) => mockFetchCrossRepoIssues(...args),
  formatCrossRepoContext: (...args: unknown[]) => mockFormatCrossRepoContext(...args),
  fetchSameRepoIssues: (...args: unknown[]) => mockFetchSameRepoIssues(...args),
  formatSameRepoContext: (...args: unknown[]) => mockFormatSameRepoContext(...args),
  classifyProposalsAgainstOpenIssues: (...args: unknown[]) => mockClassifyProposalsAgainstOpenIssues(...args),
}));

const mockLoadHistory = vi.fn();
const mockAppendCycle = vi.fn();
const mockDetectDiminishingReturns = vi.fn();
vi.mock('./brainstorm-history.js', () => ({
  loadHistory: (...args: unknown[]) => mockLoadHistory(...args),
  appendCycle: (...args: unknown[]) => mockAppendCycle(...args),
  detectDiminishingReturns: (...args: unknown[]) => mockDetectDiminishingReturns(...args),
}));

const { brainstorm } = await import('./brainstorm.js');
const { defaultAgentRuntimeFactory, claudeCliRuntimeFactory } = await import('../ai/runtime/index.js');

const DEFAULT_CONFIG: RepoConfig = {
  path: '/tmp/repo',
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
  isolation: 'worktree',
  runtime: 'pi',
};

function makeHandoff(): WaveHandoff {
  return {
    wave: 'brainstorm',
    timestamp: new Date().toISOString(),
    model: 'test-model',
    cost: 0.05,
    turns: 10,
    confidence: 'high',
    artifact: { issues: [], summary: 'ok', coverage: [] },
    approach_notes: '',
  };
}

const EMPTY_HISTORY: BrainstormHistory = { cycles: [] };
const NO_OVERLAP: DiminishingReturnsReport = {
  overlapPercent: 0,
  novelCount: 0,
  isStale: false,
  shouldStop: false,
  novelIssues: [],
  duplicateIssues: [],
};

describe('brainstorm runtime selection (issue #407)', () => {
  beforeEach(() => {
    mockSpawnWaveAgent.mockReset();
    mockSpawnWaveAgent.mockResolvedValue(makeHandoff());
    mockFetchCrossRepoIssues.mockResolvedValue([]);
    mockFormatCrossRepoContext.mockReturnValue('');
    mockFetchSameRepoIssues.mockResolvedValue([]);
    mockFormatSameRepoContext.mockReturnValue('');
    mockClassifyProposalsAgainstOpenIssues.mockReturnValue({ kept: [], skipped: [] });
    mockLoadHistory.mockResolvedValue(EMPTY_HISTORY);
    mockAppendCycle.mockResolvedValue(undefined);
    mockDetectDiminishingReturns.mockReturnValue(NO_OVERLAP);
  });

  it('passes defaultAgentRuntimeFactory when config.runtime: "pi" (default schema)', async () => {
    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBe(defaultAgentRuntimeFactory);
  });

  it('passes defaultAgentRuntimeFactory when runtime: "pi" (explicit option)', async () => {
    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, runtime: 'pi' });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBe(defaultAgentRuntimeFactory);
  });

  it('omits runtimeFactory when neither option nor config.runtime is set (legacy fixtures)', async () => {
    // Some test fixtures don't include the new `runtime` field. We treat that
    // as "use spawnWaveAgent's own default" — same effective behavior, but the
    // field stays out of the wire payload to make the no-op explicit.
    const legacy = { ...DEFAULT_CONFIG } as unknown as RepoConfig;
    (legacy as { runtime?: unknown }).runtime = undefined;
    await brainstorm({ repoPath: '/tmp/repo', config: legacy });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBeUndefined();
  });

  it('passes claudeCliRuntimeFactory when runtime: "claude-cli"', async () => {
    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, runtime: 'claude-cli' });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBe(claudeCliRuntimeFactory);
  });

  it('option override beats config.runtime', async () => {
    await brainstorm({
      repoPath: '/tmp/repo',
      config: { ...DEFAULT_CONFIG, runtime: 'claude-cli' },
      runtime: 'pi',
    });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBe(defaultAgentRuntimeFactory);
  });

  it('config.runtime applies when option is omitted', async () => {
    await brainstorm({
      repoPath: '/tmp/repo',
      config: { ...DEFAULT_CONFIG, runtime: 'claude-cli' },
    });
    const call = mockSpawnWaveAgent.mock.calls[0]?.[0] as { runtimeFactory?: unknown };
    expect(call.runtimeFactory).toBe(claudeCliRuntimeFactory);
  });
});
