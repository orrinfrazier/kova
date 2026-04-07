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
  },
  {
    title: 'Refactor duplicated error handling',
    body: 'Error handling is copy-pasted across 5 service files.',
    labels: ['tech-debt'],
    priority: 'medium' as const,
    category: 'tech-debt' as const,
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

    const result = await brainstorm({ repoPath: '/tmp/repo', config: DEFAULT_CONFIG });

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
});
