import { describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig } from '../types/index.js';

// Capture the ConcurrencyOptions passed to runFixesWithConcurrency so we can
// assert that fixLoop / fixByNumbers build a per-issue footprint map.
const capturedOptions: Array<{ options: { footprints?: Map<number, string[]> } }> = [];

vi.mock('./run-report.js', () => ({
  buildRunReport: vi.fn().mockReturnValue({}),
  printRunReport: vi.fn(),
  writeRunReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/github.js', () => ({
  fetchIssues: vi.fn().mockResolvedValue([
    {
      number: 100,
      title: 'Issue 100',
      body: 'Touches src/pipeline/loop.ts and src/services/conflict-check.ts',
      labels: [],
      url: 'https://example.com/100',
    },
    {
      number: 200,
      title: 'Issue 200',
      body: 'Touches src/pipeline/loop.ts only',
      labels: [],
      url: 'https://example.com/200',
    },
  ]),
  fetchIssue: vi.fn().mockImplementation((_repoPath: string, num: number) => ({
    number: num,
    title: `Issue ${num}`,
    body: num === 100 ? 'Touches src/services/conflict-check.ts' : 'Touches src/pipeline/loop.ts',
    labels: [],
    url: `https://example.com/${num}`,
  })),
  listOpenPRs: vi.fn().mockResolvedValue([]),
  createPR: vi.fn(),
}));

vi.mock('../services/pr-context.js', () => ({
  fetchOpenPRsDetailed: vi.fn().mockResolvedValue([]),
  extractPRFromResult: vi.fn().mockReturnValue(null),
}));

vi.mock('./fix.js', () => ({
  fix: vi.fn().mockImplementation(({ issue }: { issue: Issue }) => ({
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: {
      issue,
      repo: 'test-repo',
      repoPath: '/tmp/test',
      startedAt: '2026-04-06T10:00:00.000Z',
      completedWaves: [],
      waveResults: {},
      status: 'completed',
    },
  })),
}));

vi.mock('./issue-scheduler.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./issue-scheduler.js')>();
  return {
    ...orig,
    runFixesWithConcurrency: vi.fn().mockImplementation(async (issues, _tiers, executor, options) => {
      capturedOptions.push({ options });
      for (const issue of issues) {
        await executor(issue);
      }
      return issues.map((i: Issue) => ({ issueNumber: i.number, success: true }));
    }),
  };
});

const { fixLoop, fixByNumbers } = await import('./loop.js');

function makeConfig(concurrency: number): RepoConfig {
  return {
    path: '/tmp/test',
    rules: {
      coverage: 80,
      auto_merge: false,
      max_issues_per_run: 10,
      ci_merge: 'require' as const,
      review_merge: 'require' as const,
      concurrency,
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
    isolation: 'none',
    runtime: 'pi',
  };
}

describe('fixLoop — passes file footprints to scheduler', () => {
  it('builds a footprints map keyed by issue number from issue bodies', async () => {
    capturedOptions.length = 0;
    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(2),
    });

    expect(capturedOptions.length).toBeGreaterThan(0);
    const lastCall = capturedOptions[capturedOptions.length - 1];
    expect(lastCall).toBeDefined();
    const footprints = lastCall?.options.footprints;
    expect(footprints).toBeInstanceOf(Map);

    // Issue 100 mentions both loop.ts and conflict-check.ts
    const fp100 = footprints?.get(100) ?? [];
    expect(fp100).toContain('src/pipeline/loop.ts');
    expect(fp100).toContain('src/services/conflict-check.ts');

    // Issue 200 mentions only loop.ts
    const fp200 = footprints?.get(200) ?? [];
    expect(fp200).toContain('src/pipeline/loop.ts');
    expect(fp200).not.toContain('src/services/conflict-check.ts');
  });

  it('still passes a footprints map when concurrency=1 (no behavioral effect)', async () => {
    capturedOptions.length = 0;
    await fixLoop({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(1),
    });

    const lastCall = capturedOptions[capturedOptions.length - 1];
    expect(lastCall?.options.footprints).toBeInstanceOf(Map);
  });
});

describe('fixByNumbers — passes file footprints to scheduler', () => {
  it('builds a footprints map for issues fetched by number', async () => {
    capturedOptions.length = 0;
    await fixByNumbers({
      repoPath: '/tmp/test',
      repoName: 'test-repo',
      config: makeConfig(2),
      issueNumbers: [100, 200],
    });

    const lastCall = capturedOptions[capturedOptions.length - 1];
    const footprints = lastCall?.options.footprints;
    expect(footprints).toBeInstanceOf(Map);

    expect(footprints?.get(100) ?? []).toContain('src/services/conflict-check.ts');
    expect(footprints?.get(200) ?? []).toContain('src/pipeline/loop.ts');
  });
});
