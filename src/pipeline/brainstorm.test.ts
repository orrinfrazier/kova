import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstormHistory, DiminishingReturnsReport } from '../services/brainstorm-history.js';
import type { RepoConfig, WaveHandoff } from '../types/index.js';

// --- Mock spawnWaveAgent ---

const mockSpawnWaveAgent = vi.fn();
vi.mock('../ai/index.js', () => ({
  resolveWaveModel: vi.fn().mockReturnValue({ id: 'test-model', provider: 'anthropic' }),
  spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
  getWaveTools: vi.fn().mockReturnValue([]),
  resolveThinkingLevel: vi.fn().mockReturnValue('medium'),
  getModelString: (model: { provider: string; id: string }) => `${model.provider}:${model.id}`,
}));

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('You are brainstorming issues.'),
  resolvePromptsDir: vi.fn().mockReturnValue(undefined),
}));

// --- Mock cross-repo issues ---

const mockFetchCrossRepoIssues = vi.fn();
const mockFormatCrossRepoContext = vi.fn();
vi.mock('../services/cross-repo-issues.js', () => ({
  fetchCrossRepoIssues: (...args: unknown[]) => mockFetchCrossRepoIssues(...args),
  formatCrossRepoContext: (...args: unknown[]) => mockFormatCrossRepoContext(...args),
}));

// --- Mock brainstorm history ---

const mockLoadHistory = vi.fn();
const mockAppendCycle = vi.fn();
const mockDetectDiminishingReturns = vi.fn();
vi.mock('../services/brainstorm-history.js', () => ({
  loadHistory: (...args: unknown[]) => mockLoadHistory(...args),
  appendCycle: (...args: unknown[]) => mockAppendCycle(...args),
  detectDiminishingReturns: (...args: unknown[]) => mockDetectDiminishingReturns(...args),
}));

// Dynamic import after mocks are set up
const { brainstorm } = await import('./brainstorm.js');

const DEFAULT_CONFIG: RepoConfig = {
  path: '/tmp/repo',
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
};

const SAMPLE_ISSUES = [
  {
    title: 'Add input validation to API endpoints',
    body: 'Several endpoints accept user input without validation.',
    labels: ['bug', 'security'],
    priority: 'high' as const,
    category: 'security' as const,
    confidence: 0.9,
  },
  {
    title: 'Refactor duplicated error handling',
    body: 'Error handling is copy-pasted across 5 service files.',
    labels: ['tech-debt'],
    priority: 'medium' as const,
    category: 'tech-debt' as const,
    confidence: 0.5,
  },
];

function makeBrainstormHandoff(issues: unknown[]): WaveHandoff {
  return {
    wave: 'brainstorm',
    timestamp: new Date().toISOString(),
    model: 'test-model',
    cost: 0.05,
    turns: 10,
    confidence: 'high',
    artifact: { issues, summary: 'Found improvements' },
    approach_notes: '',
  };
}

const EMPTY_HISTORY: BrainstormHistory = { cycles: [] };

const NO_OVERLAP_REPORT: DiminishingReturnsReport = {
  overlapPercent: 0,
  novelCount: 2,
  isStale: false,
  shouldStop: false,
  novelIssues: ['Add input validation to API endpoints', 'Refactor duplicated error handling'],
  duplicateIssues: [],
};

describe('brainstorm', () => {
  beforeEach(() => {
    mockSpawnWaveAgent.mockReset();
    mockLoadHistory.mockReset();
    mockAppendCycle.mockReset();
    mockDetectDiminishingReturns.mockReset();
    mockFetchCrossRepoIssues.mockReset();
    mockFormatCrossRepoContext.mockReset();
    // Default: empty history, no overlap
    mockLoadHistory.mockResolvedValue(EMPTY_HISTORY);
    mockAppendCycle.mockResolvedValue(undefined);
    mockDetectDiminishingReturns.mockReturnValue(NO_OVERLAP_REPORT);
    // Default: no cross-repo issues
    mockFetchCrossRepoIssues.mockResolvedValue([]);
    mockFormatCrossRepoContext.mockReturnValue('');
  });

  it('spawns a single agent wave with opus (large) model', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(mockSpawnWaveAgent).toHaveBeenCalledOnce();
    const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callConfig.wave).toBe('brainstorm');
  });

  it('returns structured BrainstormResult with issues array', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, threshold: 0 });

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.title).toBe('Add input validation to API endpoints');
  });

  it('each issue has title, body, labels, priority, and category', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    for (const issue of result.issues) {
      expect(issue).toHaveProperty('title');
      expect(issue).toHaveProperty('body');
      expect(issue).toHaveProperty('labels');
      expect(issue).toHaveProperty('priority');
      expect(issue).toHaveProperty('category');
    }
  });

  it('uses the repoPath as cwd for the agent', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    await brainstorm({ repoPath: '/tmp/my-repo', config: DEFAULT_CONFIG });

    const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callConfig.cwd).toBe('/tmp/my-repo');
  });

  it('returns cost and model information', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.cost).toBe(0.05);
    expect(result.model).toBe('test-model');
  });

  it('returns success false when agent fails', async () => {
    mockSpawnWaveAgent.mockRejectedValueOnce(new Error('Agent failed'));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(0);
    expect(result.error).toContain('Agent failed');
  });

  it('returns empty issues when agent returns low confidence', async () => {
    const handoff = makeBrainstormHandoff(SAMPLE_ISSUES);
    handoff.confidence = 'low';
    handoff.artifact = 'unparseable text';
    mockSpawnWaveAgent.mockResolvedValueOnce(handoff);

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it('filters issues below default threshold of 0.7', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.success).toBe(true);
    // confidence 0.9 passes, confidence 0.5 filtered
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.title).toBe('Add input validation to API endpoints');
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.title).toBe('Refactor duplicated error handling');
  });

  it('uses custom threshold when provided', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, threshold: 0.4 });

    expect(result.success).toBe(true);
    // Both pass at threshold 0.4
    expect(result.issues).toHaveLength(2);
    expect(result.filtered).toHaveLength(0);
  });

  it('filters all issues when threshold is 1.0', async () => {
    const highConfidenceIssues = SAMPLE_ISSUES.map((i) => ({ ...i, confidence: 0.99 }));
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(highConfidenceIssues));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, threshold: 1.0 });

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.filtered).toHaveLength(2);
  });

  it('returns empty filtered array on failure', async () => {
    mockSpawnWaveAgent.mockRejectedValueOnce(new Error('Agent failed'));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.success).toBe(false);
    expect(result.filtered).toHaveLength(0);
  });

  describe('focus areas', () => {
    it('injects CLI focus areas into the agent user message', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      await brainstorm({
        repoPath: '/tmp/repo',
        config: DEFAULT_CONFIG,
        focus: ['security', 'performance'],
      });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).toContain('security');
      expect(userMessage).toContain('performance');
    });

    it('falls back to config.rules.focus when no CLI focus provided', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      const configWithFocus: RepoConfig = {
        ...DEFAULT_CONFIG,
        rules: { ...DEFAULT_CONFIG.rules, focus: ['bugs', 'tech-debt'] },
      };

      await brainstorm({ repoPath: '/tmp/repo', config: configWithFocus });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).toContain('bugs');
      expect(userMessage).toContain('tech-debt');
    });

    it('CLI focus overrides config.rules.focus', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      const configWithFocus: RepoConfig = {
        ...DEFAULT_CONFIG,
        rules: { ...DEFAULT_CONFIG.rules, focus: ['bugs'] },
      };

      await brainstorm({
        repoPath: '/tmp/repo',
        config: configWithFocus,
        focus: ['security'],
      });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).toContain('security');
      expect(userMessage).not.toContain('ONLY generate issues within these focus areas: bugs');
    });

    it('does not inject focus when neither CLI nor config provides it', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).not.toContain('focus areas');
    });
  });

  // --- Diminishing returns integration ---

  it('loads history and runs diminishing returns check on success', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(mockLoadHistory).toHaveBeenCalledWith('/tmp/repo');
    expect(mockDetectDiminishingReturns).toHaveBeenCalledOnce();
    expect(result.diminishingReturns).toBeDefined();
  });

  it('appends new cycle to history after successful brainstorm', async () => {
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(mockAppendCycle).toHaveBeenCalledWith(
      '/tmp/repo',
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ title: 'Add input validation to API endpoints' })]),
      }),
    );
  });

  it('returns diminishing returns report in result', async () => {
    const staleReport: DiminishingReturnsReport = {
      overlapPercent: 75,
      novelCount: 1,
      isStale: true,
      shouldStop: true,
      novelIssues: ['New thing'],
      duplicateIssues: ['Old thing A', 'Old thing B', 'Old thing C'],
    };
    mockDetectDiminishingReturns.mockReturnValue(staleReport);
    mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(result.diminishingReturns).toEqual(staleReport);
    expect(result.diminishingReturns?.isStale).toBe(true);
    expect(result.diminishingReturns?.shouldStop).toBe(true);
  });

  it('does not check history when brainstorm fails', async () => {
    mockSpawnWaveAgent.mockRejectedValueOnce(new Error('Agent failed'));

    await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

    expect(mockLoadHistory).not.toHaveBeenCalled();
    expect(mockAppendCycle).not.toHaveBeenCalled();
  });

  // --- Cross-repo issue awareness ---

  describe('cross-repo issue awareness', () => {
    const MULTI_REPO_CONFIG = {
      repos: {
        current: { path: '/tmp/repo' },
        sibling: { path: '/tmp/sibling' },
      },
    };

    it('fetches cross-repo issues when kovaConfig is provided', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));
      mockFetchCrossRepoIssues.mockResolvedValue([]);
      mockFormatCrossRepoContext.mockReturnValue('');

      await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, kovaConfig: MULTI_REPO_CONFIG });

      expect(mockFetchCrossRepoIssues).toHaveBeenCalledWith('/tmp/repo', MULTI_REPO_CONFIG);
    });

    it('injects cross-repo context into the agent user message', async () => {
      const crossRepoContext = '\n\nThese issues already exist in related repos:\n- repo-b: Fix auth bug [bug]';
      mockFormatCrossRepoContext.mockReturnValue(crossRepoContext);
      mockFetchCrossRepoIssues.mockResolvedValue([
        { repo: 'repo-b', issues: [{ title: 'Fix auth bug', labels: ['bug'] }] },
      ]);
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, kovaConfig: MULTI_REPO_CONFIG });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).toContain('already exist in related repos');
      expect(userMessage).toContain('Fix auth bug');
    });

    it('does not inject context when there are no cross-repo issues', async () => {
      mockFetchCrossRepoIssues.mockResolvedValue([]);
      mockFormatCrossRepoContext.mockReturnValue('');
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, kovaConfig: MULTI_REPO_CONFIG });

      const callConfig = mockSpawnWaveAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      const userMessage = callConfig.userMessage as string;
      expect(userMessage).not.toContain('already exist in related repos');
    });

    it('does not fetch cross-repo issues when no kovaConfig provided', async () => {
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

      expect(mockFetchCrossRepoIssues).not.toHaveBeenCalled();
    });

    it('still succeeds when cross-repo fetch fails', async () => {
      mockFetchCrossRepoIssues.mockRejectedValue(new Error('network error'));
      mockSpawnWaveAgent.mockResolvedValueOnce(makeBrainstormHandoff(SAMPLE_ISSUES));

      const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG, kovaConfig: MULTI_REPO_CONFIG });

      expect(result.success).toBe(true);
      expect(result.issues).toHaveLength(1);
    });
  });
});
