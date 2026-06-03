import { describe, expect, it } from 'vitest';
import type { CustomTool, RepoConfig, WaveName } from '../types/index.js';
import {
  createCustomTools,
  DEFAULT_THINKING_LEVELS,
  getWaveTools,
  PIECE_SCOPE_WAVES,
  resolveThinkingLevel,
  WAVE_TOOLS,
} from './wave-tools.js';

describe('WAVE_TOOLS', () => {
  it('defines tool sets for all six AI waves (ship excluded — orchestrator-only)', () => {
    const aiWaves: Array<keyof typeof WAVE_TOOLS> = ['assess', 'spec', 'test', 'impl', 'quality', 'review'];
    for (const wave of aiWaves) {
      expect(WAVE_TOOLS[wave]).toBeDefined();
      expect(WAVE_TOOLS[wave].length).toBeGreaterThan(0);
    }
    expect('ship' in WAVE_TOOLS).toBe(false);
  });

  it('assess wave has read-only tools: read, find, grep', () => {
    expect(WAVE_TOOLS.assess).toEqual(['read', 'find', 'grep']);
  });

  it('spec wave has read-only tools: read, find, grep', () => {
    expect(WAVE_TOOLS.spec).toEqual(['read', 'find', 'grep']);
  });

  it('test wave has coding tools: read, write, edit, bash', () => {
    expect(WAVE_TOOLS.test).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('impl wave has coding tools: read, write, edit, bash', () => {
    expect(WAVE_TOOLS.impl).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('quality wave has bash and read', () => {
    expect(WAVE_TOOLS.quality).toEqual(['bash', 'read']);
  });

  it('review wave has read-only subset: read, grep', () => {
    expect(WAVE_TOOLS.review).toEqual(['read', 'grep']);
  });

  it('read-only waves do not include write, edit, or bash', () => {
    const readOnlyWaves: Array<keyof typeof WAVE_TOOLS> = ['assess', 'spec', 'review'];
    const writeTools = ['write', 'edit', 'bash'];
    for (const wave of readOnlyWaves) {
      for (const tool of writeTools) {
        expect(WAVE_TOOLS[wave]).not.toContain(tool);
      }
    }
  });
});

describe('getWaveTools', () => {
  it('returns an array of Tool objects for a given wave', () => {
    const tools = getWaveTools('assess', '/tmp');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(WAVE_TOOLS.assess.length);
  });

  it('returns tools with correct names matching the wave config', () => {
    const tools = getWaveTools('test', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.test);
  });

  it('returns different tool sets for different waves', () => {
    const assessTools = getWaveTools('assess', '/tmp');
    const implTools = getWaveTools('impl', '/tmp');
    const assessNames = assessTools.map((t) => t.name);
    const implNames = implTools.map((t) => t.name);
    expect(assessNames).not.toEqual(implNames);
  });

  it('assess tools cannot write or execute', () => {
    const tools = getWaveTools('assess', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('bash');
  });

  it('review tools cannot write or execute', () => {
    const tools = getWaveTools('review', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('bash');
  });
});

describe('createCustomTools', () => {
  const sampleTools: CustomTool[] = [
    { name: 'run-migrations', description: 'Run database migrations', command: 'npm run db:migrate' },
    { name: 'seed-data', description: 'Seed test database', command: 'npm run db:seed' },
  ];

  it('creates an AgentTool for each custom tool definition', () => {
    const tools = createCustomTools(sampleTools, '/tmp');
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('run-migrations');
    expect(tools[1]?.name).toBe('seed-data');
  });

  it('sets label equal to name', () => {
    const tools = createCustomTools(sampleTools, '/tmp');
    expect(tools[0]?.label).toBe('run-migrations');
  });

  it('sets description from tool definition', () => {
    const tools = createCustomTools(sampleTools, '/tmp');
    expect(tools[0]?.description).toBe('Run database migrations');
  });

  it('returns empty array for empty input', () => {
    const tools = createCustomTools([], '/tmp');
    expect(tools).toEqual([]);
  });

  it('execute returns content with command output on success', async () => {
    const tools = createCustomTools([{ name: 'echo-test', description: 'Echo', command: 'echo hello' }], '/tmp');
    // biome-ignore lint/style/noNonNullAssertion: test — we know tools[0] exists
    const result = await tools[0]!.execute('call-1', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello\n' });
  });

  it('execute returns error content on command failure', async () => {
    const tools = createCustomTools([{ name: 'fail', description: 'Fail', command: 'exit 42' }], '/tmp');
    // biome-ignore lint/style/noNonNullAssertion: test — we know tools[0] exists
    const result = await tools[0]!.execute('call-1', {});
    const firstContent = result.content[0];
    expect(firstContent?.type === 'text' && firstContent.text).toContain('Command failed');
  });
});

describe('getWaveTools with custom tools', () => {
  const customTools: CustomTool[] = [
    { name: 'run-migrations', description: 'Run DB migrations', command: 'npm run db:migrate' },
  ];

  it('appends custom tools to impl wave', () => {
    const tools = getWaveTools('impl', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).toContain('run-migrations');
    // Still has standard tools
    expect(names).toContain('read');
    expect(names).toContain('bash');
  });

  it('appends custom tools to quality wave', () => {
    const tools = getWaveTools('quality', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).toContain('run-migrations');
    expect(names).toContain('bash');
  });

  it('does NOT append custom tools to assess wave', () => {
    const tools = getWaveTools('assess', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('run-migrations');
  });

  it('does NOT append custom tools to spec wave', () => {
    const tools = getWaveTools('spec', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('run-migrations');
  });

  it('does NOT append custom tools to review wave', () => {
    const tools = getWaveTools('review', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('run-migrations');
  });

  it('does NOT append custom tools to test wave', () => {
    const tools = getWaveTools('test', '/tmp', { customTools });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('run-migrations');
  });

  it('works without custom tools (backward compat)', () => {
    const tools = getWaveTools('impl', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.impl);
  });

  it('works with undefined custom tools', () => {
    const tools = getWaveTools('impl', '/tmp', undefined);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.impl);
  });

  it('works with empty custom tools array', () => {
    const tools = getWaveTools('impl', '/tmp', { customTools: [] });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.impl);
  });
});

describe('DEFAULT_THINKING_LEVELS', () => {
  it('defines thinking levels for all seven waves', () => {
    const waves: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];
    for (const wave of waves) {
      expect(DEFAULT_THINKING_LEVELS[wave]).toBeDefined();
    }
  });

  it('reasoning waves use medium thinking', () => {
    expect(DEFAULT_THINKING_LEVELS.assess).toBe('medium');
    expect(DEFAULT_THINKING_LEVELS.spec).toBe('medium');
    expect(DEFAULT_THINKING_LEVELS.review).toBe('medium');
  });

  it('coding waves use off thinking', () => {
    expect(DEFAULT_THINKING_LEVELS.test).toBe('off');
    expect(DEFAULT_THINKING_LEVELS.impl).toBe('off');
    expect(DEFAULT_THINKING_LEVELS.quality).toBe('off');
  });

  it('ship wave uses off thinking', () => {
    expect(DEFAULT_THINKING_LEVELS.ship).toBe('off');
  });
});

describe('resolveThinkingLevel', () => {
  const baseConfig: RepoConfig = {
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

  it('returns default thinking level when no thinking config is set', () => {
    expect(resolveThinkingLevel(baseConfig, 'assess')).toBe('medium');
    expect(resolveThinkingLevel(baseConfig, 'spec')).toBe('medium');
    expect(resolveThinkingLevel(baseConfig, 'review')).toBe('medium');
    expect(resolveThinkingLevel(baseConfig, 'brainstorm')).toBe('medium');
    expect(resolveThinkingLevel(baseConfig, 'test')).toBe('off');
    expect(resolveThinkingLevel(baseConfig, 'impl')).toBe('off');
    expect(resolveThinkingLevel(baseConfig, 'quality')).toBe('off');
  });

  it('returns override when thinking config specifies a wave', () => {
    const config: RepoConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        thinking: { spec: 'high', review: 'high' },
      },
    };
    expect(resolveThinkingLevel(config, 'spec')).toBe('high');
    expect(resolveThinkingLevel(config, 'review')).toBe('high');
  });

  it('returns default for waves not specified in thinking config', () => {
    const config: RepoConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        thinking: { review: 'high' },
      },
    };
    expect(resolveThinkingLevel(config, 'assess')).toBe('medium');
    expect(resolveThinkingLevel(config, 'test')).toBe('off');
  });

  it('allows setting thinking level to off for reasoning waves', () => {
    const config: RepoConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        thinking: { assess: 'off' },
      },
    };
    expect(resolveThinkingLevel(config, 'assess')).toBe('off');
  });

  it('allows setting thinking level to high for coding waves', () => {
    const config: RepoConfig = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        thinking: { impl: 'high' },
      },
    };
    expect(resolveThinkingLevel(config, 'impl')).toBe('high');
  });
});

describe('getWaveTools with pipelineTool config (issue #300)', () => {
  it('appends execute_pipeline to impl wave when enabled', () => {
    const tools = getWaveTools('impl', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain('execute_pipeline');
    // Standard impl tools still present
    expect(names).toContain('read');
    expect(names).toContain('bash');
  });

  it('appends execute_pipeline to quality wave when enabled', () => {
    const tools = getWaveTools('quality', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain('execute_pipeline');
    expect(names).toContain('bash');
    expect(names).toContain('read');
  });

  it('does NOT append execute_pipeline to assess wave when enabled', () => {
    const tools = getWaveTools('assess', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('does NOT append execute_pipeline to spec wave when enabled', () => {
    const tools = getWaveTools('spec', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('does NOT append execute_pipeline to test wave when enabled', () => {
    const tools = getWaveTools('test', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('does NOT append execute_pipeline to review wave when enabled', () => {
    const tools = getWaveTools('review', '/tmp', { pipelineTool: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('default (no flag) does NOT include execute_pipeline (backward compat)', () => {
    const tools = getWaveTools('impl', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('disabled flag does NOT include execute_pipeline', () => {
    const tools = getWaveTools('impl', '/tmp', { pipelineTool: { enabled: false } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('execute_pipeline');
  });

  it('pipelineTool composes with customTools on impl wave', () => {
    const customTools: CustomTool[] = [
      { name: 'run-migrations', description: 'Run DB migrations', command: 'npm run db:migrate' },
    ];
    const tools = getWaveTools('impl', '/tmp', {
      customTools,
      pipelineTool: { enabled: true },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('run-migrations');
    expect(names).toContain('execute_pipeline');
  });
});

describe('getWaveTools with playwright config', () => {
  it('review wave includes bash when playwright is enabled', () => {
    const tools = getWaveTools('review', '/tmp', { playwright: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read');
    expect(names).toContain('grep');
  });

  it('review wave stays read-only when no playwright arg', () => {
    const tools = getWaveTools('review', '/tmp');
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).toEqual(['read', 'grep']);
  });

  it('review wave stays read-only when playwright is disabled', () => {
    const tools = getWaveTools('review', '/tmp', { playwright: { enabled: false } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('bash');
  });

  it('non-review waves ignore playwright config (assess)', () => {
    const tools = getWaveTools('assess', '/tmp', { playwright: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).toEqual(['read', 'find', 'grep']);
  });

  it('non-review waves ignore playwright config (impl)', () => {
    const tools = getWaveTools('impl', '/tmp', { playwright: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.impl);
  });

  it('non-review waves ignore playwright config (spec)', () => {
    const tools = getWaveTools('spec', '/tmp', { playwright: { enabled: true } });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.spec);
  });
});

describe('PIECE_SCOPE_WAVES (issue #250)', () => {
  it('includes impl wave', () => {
    expect(PIECE_SCOPE_WAVES.has('impl')).toBe(true);
  });

  it('does NOT include test wave (test needs to create new test files)', () => {
    expect(PIECE_SCOPE_WAVES.has('test')).toBe(false);
  });

  it('does NOT include quality wave (quality needs to fix lint/type errors anywhere)', () => {
    expect(PIECE_SCOPE_WAVES.has('quality')).toBe(false);
  });

  it('does NOT include read-only waves', () => {
    expect(PIECE_SCOPE_WAVES.has('assess')).toBe(false);
    expect(PIECE_SCOPE_WAVES.has('spec')).toBe(false);
    expect(PIECE_SCOPE_WAVES.has('review')).toBe(false);
  });
});

describe('getWaveTools with pieceFiles option (issue #250)', () => {
  // The pieceFiles option is consumed by spawnWaveAgent (via a beforeToolCall hook),
  // not by getWaveTools itself — getWaveTools must remain a pure tool-set selector.
  // These tests pin that contract.

  it('returns the same tool set for impl regardless of pieceFiles', () => {
    const without = getWaveTools('impl', '/tmp').map((t) => t.name);
    const withFiles = getWaveTools('impl', '/tmp', { pieceFiles: ['a.ts'] }).map((t) => t.name);
    expect(withFiles).toEqual(without);
  });

  it('returns the same tool set for test regardless of pieceFiles', () => {
    const without = getWaveTools('test', '/tmp').map((t) => t.name);
    const withFiles = getWaveTools('test', '/tmp', { pieceFiles: ['a.ts'] }).map((t) => t.name);
    expect(withFiles).toEqual(without);
  });

  it('accepts an empty pieceFiles list without changing tool set', () => {
    const tools = getWaveTools('impl', '/tmp', { pieceFiles: [] });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(WAVE_TOOLS.impl);
  });

  it('composes with customTools and pipelineTool', () => {
    const customTools: CustomTool[] = [
      { name: 'run-migrations', description: 'Run DB migrations', command: 'npm run db:migrate' },
    ];
    const tools = getWaveTools('impl', '/tmp', {
      customTools,
      pieceFiles: ['src/a.ts'],
      pipelineTool: { enabled: true },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('run-migrations');
    expect(names).toContain('execute_pipeline');
  });
});
