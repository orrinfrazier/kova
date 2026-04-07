import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, WaveHandoff } from '../types/index.js';

// --- Mock spawnWaveAgent ---

const mockSpawnWaveAgent = vi.fn();
vi.mock('../ai/index.js', () => ({
  resolveModel: vi.fn().mockReturnValue({ id: 'test-model' }),
  spawnWaveAgent: (...args: unknown[]) => mockSpawnWaveAgent(...args),
  getWaveTools: vi.fn().mockReturnValue([]),
  resolveThinkingLevel: vi.fn().mockReturnValue('medium'),
}));

vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('You are brainstorming issues.'),
}));

// Dynamic import after mocks are set up
const { brainstorm } = await import('./brainstorm.js');

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

describe('brainstorm', () => {
  beforeEach(() => {
    mockSpawnWaveAgent.mockReset();
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
});
