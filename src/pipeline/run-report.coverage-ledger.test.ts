/**
 * Run report surfaces the coverage ledger: counts not-attempted + reasons,
 * so no fetched issue is silently dropped (issue #288).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../types/index.js';
import type { FixResult } from './fix.js';
import type { IssueOutcome, LoopResult } from './loop.js';
import { buildRunReport, printRunReport, writeRunReport } from './run-report.js';

function makeIssue(number: number, title = `Issue ${number}`): Issue {
  return {
    number,
    title,
    body: `body for #${number}`,
    labels: [],
    url: `https://github.com/test/repo/issues/${number}`,
  };
}

function makeSuccess(issue: Issue): FixResult {
  return {
    success: true,
    prUrl: `https://github.com/test/repo/pull/${issue.number}`,
    state: {
      issue,
      repo: 'test-repo',
      repoPath: '/tmp/test',
      startedAt: '2026-04-06T10:00:00.000Z',
      completedWaves: ['assess'],
      waveResults: {
        assess: { wave: 'assess', success: true, artifact: {}, duration: 1000, cost: 0.05, turns: 2 },
      },
      status: 'completed',
    },
  };
}

function makeLoopResult(outcomes: IssueOutcome[], skippedByReason: Record<string, number>): LoopResult {
  const processed = outcomes.filter((o) => o.status === 'succeeded' || o.status === 'failed');
  const results = processed.map((o) => {
    const issue = makeIssue(o.issueNumber, o.title ?? `Issue ${o.issueNumber}`);
    return { issue, result: makeSuccess(issue) };
  });
  const skipped = outcomes.length - processed.length;
  return {
    total: processed.length,
    succeeded: results.filter((r) => r.result.success).length,
    failed: results.filter((r) => !r.result.success).length,
    skipped,
    totalCost: 0.05 * processed.length,
    totalTurns: 2 * processed.length,
    totalDuration: 1000 * processed.length,
    budgetExceeded: false,
    startedAt: '2026-04-06T10:00:00.000Z',
    results,
    outcomes,
    skippedByReason,
  };
}

describe('buildRunReport — passes coverage ledger through', () => {
  it('includes outcomes in the report', () => {
    const outcomes: IssueOutcome[] = [
      { issueNumber: 1, status: 'succeeded', title: 'a' },
      { issueNumber: 2, status: 'skipped:over-limit', title: 'b' },
    ];
    const report = buildRunReport(makeLoopResult(outcomes, { 'over-limit': 1 }));
    expect(report.outcomes).toHaveLength(2);
    expect(report.skippedByReason).toEqual({ 'over-limit': 1 });
  });

  it('keeps skipped count = sum of all skip reasons', () => {
    const outcomes: IssueOutcome[] = [
      { issueNumber: 1, status: 'succeeded' },
      { issueNumber: 2, status: 'skipped:over-limit' },
      { issueNumber: 3, status: 'skipped:budget' },
      { issueNumber: 4, status: 'skipped:shutdown' },
    ];
    const report = buildRunReport(makeLoopResult(outcomes, { 'over-limit': 1, budget: 1, shutdown: 1 }));
    expect(report.skipped).toBe(3);
  });
});

describe('writeRunReport — markdown surfaces "N not attempted" with reasons', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-coverage-ledger-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('markdown includes a "not attempted" line broken out by reason when skipped > 0', async () => {
    const outcomes: IssueOutcome[] = [
      { issueNumber: 1, status: 'succeeded' },
      { issueNumber: 2, status: 'skipped:over-limit' },
      { issueNumber: 3, status: 'skipped:over-limit' },
      { issueNumber: 4, status: 'skipped:budget' },
    ];
    const report = buildRunReport(makeLoopResult(outcomes, { 'over-limit': 2, budget: 1 }));
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).toMatch(/3 not attempted/i);
    expect(md).toMatch(/over-limit:\s*2/i);
    expect(md).toMatch(/budget:\s*1/i);
  });

  it('markdown omits the "not attempted" section when nothing was skipped', async () => {
    const outcomes: IssueOutcome[] = [
      { issueNumber: 1, status: 'succeeded' },
      { issueNumber: 2, status: 'succeeded' },
    ];
    const report = buildRunReport(makeLoopResult(outcomes, {}));
    await writeRunReport(workDir, report);
    const md = await readFile(join(workDir, '.kova', 'run-report.md'), 'utf-8');
    expect(md).not.toMatch(/not attempted/i);
  });
});

describe('printRunReport — stdout surfaces "N not attempted" with reasons', () => {
  it('prints not-attempted line broken out by reason', () => {
    const outcomes: IssueOutcome[] = [
      { issueNumber: 1, status: 'succeeded' },
      { issueNumber: 2, status: 'skipped:over-limit' },
      { issueNumber: 3, status: 'skipped:shutdown' },
    ];
    const report = buildRunReport(makeLoopResult(outcomes, { 'over-limit': 1, shutdown: 1 }));
    const spy = vi.spyOn(console, 'log');
    printRunReport(report);
    const output = spy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toMatch(/2 not attempted/i);
    expect(output).toMatch(/over-limit/);
    expect(output).toMatch(/shutdown/);
    spy.mockRestore();
  });
});
