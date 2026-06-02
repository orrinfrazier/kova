import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../types/index.js';
import type { FixResult } from './fix.js';
import type { LoopResult } from './loop.js';
import { buildRunReport, printRunReport, type RunReport, writeRunReport } from './run-report.js';

function makeIssue(number: number, title: string): Issue {
  return {
    number,
    title,
    body: `body for #${number}`,
    labels: [],
    url: `https://github.com/test/repo/issues/${number}`,
  };
}

function makeSuccessResult(issue: Issue): FixResult {
  return {
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: makeState(issue),
  };
}

function makeFailureResult(issue: Issue, error: string): FixResult {
  return {
    success: false,
    error,
    state: makeState(issue),
  };
}

function makeState(issue: Issue): FixResult['state'] {
  return {
    issue,
    repo: 'test-repo',
    repoPath: '/tmp/test',
    startedAt: '2026-04-06T10:00:00.000Z',
    completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
    waveResults: {
      assess: { wave: 'assess', success: true, artifact: {}, duration: 3000, cost: 0.1, turns: 5 },
      spec: { wave: 'spec', success: true, artifact: {}, duration: 2000, cost: 0.08, turns: 3 },
      test: { wave: 'test', success: true, artifact: {}, duration: 5000, cost: 0.12, turns: 10 },
      impl: { wave: 'impl', success: true, artifact: {}, duration: 8000, cost: 0.18, turns: 15 },
      quality: { wave: 'quality', success: true, artifact: {}, duration: 1500, cost: 0.02, turns: 4 },
      review: { wave: 'review', success: true, artifact: {}, duration: 4000, cost: 0.08, turns: 6 },
      ship: { wave: 'ship', success: true, artifact: {}, duration: 500, cost: 0, turns: 0 },
    },
    status: 'completed',
  };
}

function makeLoopResult(overrides?: Partial<LoopResult>): LoopResult {
  const issue1 = makeIssue(1, 'Fix login bug');
  const issue2 = makeIssue(2, 'Add dark mode');
  const issue3 = makeIssue(3, 'Broken API endpoint');
  return {
    total: 3,
    succeeded: 2,
    failed: 1,
    skipped: 0,
    totalCost: 1.74,
    totalTurns: 129,
    totalDuration: 72000,
    budgetExceeded: false,
    startedAt: '2026-04-06T10:00:00.000Z',
    results: [
      { issue: issue1, result: makeSuccessResult(issue1) },
      { issue: issue2, result: makeSuccessResult(issue2) },
      { issue: issue3, result: makeFailureResult(issue3, 'Quality gates failed after 3 retries') },
    ],
    ...overrides,
  };
}

describe('buildRunReport', () => {
  it('includes summary counts: total, succeeded, failed, skipped', () => {
    const report = buildRunReport(makeLoopResult());
    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it('includes aggregate cost, turns, duration', () => {
    const report = buildRunReport(makeLoopResult());
    expect(report.totalCost).toBeCloseTo(1.74, 2);
    expect(report.totalTurns).toBe(129);
    expect(report.totalDuration).toBe(72000);
  });

  it('includes per-issue breakdown', () => {
    const report = buildRunReport(makeLoopResult());
    expect(report.issues).toHaveLength(3);
    const first = report.issues.find((i) => i.number === 1);
    expect(first?.number).toBe(1);
    expect(first?.title).toBe('Fix login bug');
    expect(first?.success).toBe(true);
    expect(first?.prUrl).toBe('https://github.com/test/repo/pull/1');
    expect(first?.cost).toBeGreaterThan(0);
    expect(first?.duration).toBeGreaterThan(0);
    expect(first?.turns).toBeGreaterThan(0);
  });

  it('includes failure reason for failed issues', () => {
    const report = buildRunReport(makeLoopResult());
    const failed = report.issues.find((i) => i.number === 3);
    expect(failed?.success).toBe(false);
    expect(failed?.error).toBe('Quality gates failed after 3 retries');
    expect(failed?.prUrl).toBeUndefined();
  });

  it('uses startedAt from loop result and sets completedAt', () => {
    const report = buildRunReport(makeLoopResult());
    expect(report.startedAt).toBe('2026-04-06T10:00:00.000Z');
    expect(report.completedAt).toBeDefined();
    expect(new Date(report.completedAt).getTime()).toBeGreaterThan(0);
    expect(report.startedAt).not.toBe(report.completedAt);
  });

  it('handles empty loop (no issues)', () => {
    const report = buildRunReport(
      makeLoopResult({
        total: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        totalCost: 0,
        totalTurns: 0,
        totalDuration: 0,
        results: [],
      }),
    );
    expect(report.total).toBe(0);
    expect(report.issues).toHaveLength(0);
    expect(report.totalCost).toBe(0);
  });

  it('computes per-issue cost from wave results', () => {
    const report = buildRunReport(makeLoopResult());
    const first = report.issues.find((i) => i.number === 1);
    expect(first?.cost).toBeCloseTo(0.58, 2);
  });

  it('passes through budgetExceeded from loop result', () => {
    const report = buildRunReport(makeLoopResult({ budgetExceeded: true }));
    expect(report.budgetExceeded).toBe(true);
  });
});

describe('writeRunReport', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-run-report-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes run-report.json to .kova directory', async () => {
    const report = buildRunReport(makeLoopResult());
    await writeRunReport(workDir, report);
    const json = JSON.parse(await readFile(join(workDir, '.kova', 'run-report.json'), 'utf-8')) as RunReport;
    expect(json.total).toBe(3);
    expect(json.succeeded).toBe(2);
    expect(json.issues).toHaveLength(3);
  });

  it('writes run-report.md to .kova directory', async () => {
    const report = buildRunReport(makeLoopResult());
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).toContain('# Kova Run Report');
    expect(md).toContain('2/3 succeeded');
    expect(md).toContain('#1');
    expect(md).toContain('#2');
    expect(md).toContain('#3');
    expect(md).toContain('Fix login bug');
    expect(md).toContain('Quality gates failed after 3 retries');
  });

  it('markdown includes cost and duration totals', async () => {
    const report = buildRunReport(makeLoopResult());
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).toContain('$1.74');
    expect(md).toContain('1m 12s');
  });

  it('escapes pipe characters in issue titles', async () => {
    const issue = makeIssue(99, 'Fix A | B regression');
    const report = buildRunReport(
      makeLoopResult({
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [{ issue, result: makeSuccessResult(issue) }],
      }),
    );
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).toContain('Fix A \\| B regression');
  });
});

describe('buildRunReport — milestone progress', () => {
  it('attaches milestoneProgress when milestone context is provided', () => {
    const report = buildRunReport(makeLoopResult(), {
      milestone: 'v0.35',
      openCount: 7,
      closedCount: 12,
    });
    expect(report.milestoneProgress).toBeDefined();
    expect(report.milestoneProgress).toEqual({
      milestone: 'v0.35',
      open: 7,
      closed: 12,
      attempted: 3,
    });
  });

  it('attempted reflects loop.total when milestone context is provided', () => {
    const report = buildRunReport(makeLoopResult({ total: 2 }), {
      milestone: 'v0.35',
      openCount: 5,
      closedCount: 1,
    });
    expect(report.milestoneProgress?.attempted).toBe(2);
  });

  it('omits milestoneProgress when no milestone context provided', () => {
    const report = buildRunReport(makeLoopResult());
    expect(report.milestoneProgress).toBeUndefined();
  });
});

describe('writeRunReport — milestone section', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-run-report-milestone-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('renders Milestone progress section in markdown when populated', async () => {
    const report = buildRunReport(makeLoopResult(), {
      milestone: 'v0.35',
      openCount: 7,
      closedCount: 12,
    });
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).toContain('Milestone');
    expect(md).toContain('v0.35');
    expect(md).toContain('7'); // open
    expect(md).toContain('12'); // closed
  });

  it('omits Milestone section when no milestoneProgress on report', async () => {
    const report = buildRunReport(makeLoopResult());
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).not.toMatch(/##\s*Milestone/);
  });
});

describe('printRunReport — milestone line', () => {
  it('prints a milestone progress line when milestoneProgress is present', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const report = buildRunReport(makeLoopResult(), {
      milestone: 'v0.35',
      openCount: 7,
      closedCount: 12,
    });
    printRunReport(report);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toMatch(/[Mm]ilestone/);
    expect(output).toContain('v0.35');
    consoleSpy.mockRestore();
  });

  it('does not print milestone line when milestoneProgress missing', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    printRunReport(buildRunReport(makeLoopResult()));
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).not.toMatch(/Milestone progress/);
    consoleSpy.mockRestore();
  });
});

describe('printRunReport', () => {
  it('prints issues attempted, PRs created, and failures to stdout', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const report = buildRunReport(makeLoopResult());
    printRunReport(report);
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('2 succeeded');
    expect(output).toContain('1 failed');
    expect(output).toContain('pull/1');
    expect(output).toContain('pull/2');
    expect(output).toContain('Quality gates failed after 3 retries');
    expect(output).toContain('$1.74');
    consoleSpy.mockRestore();
  });

  it('prints per-issue cost breakdown', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    printRunReport(buildRunReport(makeLoopResult()));
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('#1');
    expect(output).toContain('#2');
    expect(output).toContain('#3');
    consoleSpy.mockRestore();
  });
});
