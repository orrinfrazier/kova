import { $ } from 'zx';
import { fetchIssue, fetchIssues, fetchMilestoneCounts } from '../services/github.js';
import * as metrics from '../services/metrics.js';
import { extractPRFromResult, fetchOpenPRsDetailed, type OpenPR } from '../services/pr-context.js';
import { prioritizeIssues } from '../services/prioritize.js';
import { shutdownRequested } from '../services/shutdown.js';
import type { Issue, RepoConfig, WaveResult } from '../types/index.js';
import { log } from '../utils/logger.js';
import { CostAccumulator } from './cost-accumulator.js';
import { extractFootprint } from './file-footprint.js';
import { type FixResult, fix } from './fix.js';
import { buildDependencyTiers, type FixExecutor, runFixesWithConcurrency } from './issue-scheduler.js';
import { buildRunReport, printRunReport, writeRunReport } from './run-report.js';
import type { SharedBudgetTracker } from './shared-budget.js';

$.verbose = false;

export interface LoopOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  filter?: string | undefined;
  /**
   * Milestone title — scopes the issue fetch (via `gh --milestone`) and triggers
   * milestone progress reporting in the run report.
   */
  milestone?: string | undefined;
  maxIssues?: number | undefined;
  budgetUsd?: number | undefined;
  force?: boolean | undefined;
  budgetTracker?: SharedBudgetTracker | undefined;
}

export interface LoopResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalCost: number;
  totalTurns: number;
  totalDuration: number;
  budgetExceeded: boolean;
  startedAt: string;
  results: Array<{ issue: Issue; result: FixResult }>;
}

function aggregateWaveCosts(waveResults: Partial<Record<string, WaveResult>>): {
  cost: number;
  turns: number;
  duration: number;
} {
  let cost = 0;
  let turns = 0;
  let duration = 0;
  for (const result of Object.values(waveResults)) {
    if (result) {
      cost += result.cost;
      turns += result.turns;
      duration += result.duration;
    }
  }
  return { cost, turns, duration };
}

function emptyResult(startedAt: string): LoopResult {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    totalCost: 0,
    totalTurns: 0,
    totalDuration: 0,
    budgetExceeded: false,
    startedAt,
    results: [],
  };
}

export async function fixLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, filter, milestone, maxIssues, budgetUsd, budgetTracker } = options;
  const startedAt = new Date().toISOString();
  const limit = maxIssues ?? config.auto?.max_per_run ?? config.rules.max_issues_per_run;
  const budget = budgetTracker ? undefined : (budgetUsd ?? config.rules.budget_usd);
  const concurrency = config.rules.concurrency ?? 1;
  log.info(`Fetching open issues for ${repoName}...`);
  if (milestone) {
    log.info(`[loop] Milestone filter: ${milestone}`);
  }
  if (budgetTracker) {
    log.info(`Shared budget cap: $${budgetTracker.limitUsd.toFixed(2)}`);
  } else if (budget !== undefined) {
    log.info(`Budget cap: $${budget.toFixed(2)}`);
  }
  const issues = await fetchIssues(repoPath, filter, { milestone });
  if (issues.length === 0) {
    log.info('No open issues found.');
    return emptyResult(startedAt);
  }
  log.info(`Found ${issues.length} issues, prioritizing...`);
  const prioritized = prioritizeIssues(issues);
  const toFix = prioritized.slice(0, limit).map((p) => p.issue);
  log.info(`Processing ${toFix.length} issues (prioritized by score + dependencies)`);

  const pendingPRs: OpenPR[] = await fetchOpenPRsDetailed(repoPath).catch((err) => {
    log.warn(`Failed to fetch open PRs for context: ${err instanceof Error ? err.message : String(err)}`);
    return [] as OpenPR[];
  });
  if (pendingPRs.length > 0) {
    log.info(`Loaded ${pendingPRs.length} open PRs for conflict awareness`);
  }

  // Build dependency tiers from prioritization
  const deps = prioritized.slice(0, limit).map((p) => ({
    issueNumber: p.issue.number,
    blockedBy: p.blockedBy ?? [],
  }));
  const tiers = buildDependencyTiers(toFix, deps);

  // Shared state across concurrent fixes
  const accumulator = new CostAccumulator({
    onCostUpdate: (total) => {
      metrics.setCurrentCostUsd(total);
      if (budgetTracker) budgetTracker.addCost(0); // sync check only; real cost added below
    },
  });
  const fixResultsMap = new Map<number, { issue: Issue; result: FixResult }>();

  // pendingPRs is shared across concurrent executors. Each executor snapshots
  // it at call time, so concurrent siblings may or may not see each other's PRs.
  // This is acceptable — PR conflict awareness is best-effort.
  const executor: FixExecutor = async (issue) => {
    log.info(`\n${'='.repeat(60)}`);
    log.info(`Fixing #${issue.number}: ${issue.title}`);
    log.info('='.repeat(60));

    // Pull latest before each fix to stay current with default branch
    try {
      await $`git -C ${repoPath} fetch origin`;
      log.debug('Fetched latest from origin before fix');
    } catch (err) {
      log.warn(`Failed to fetch origin: ${err instanceof Error ? err.message : String(err)}`);
    }

    const result = await fix({ issue, repoPath, repoName, config, pendingPRs: [...pendingPRs] });

    const waveCosts = aggregateWaveCosts(result.state.waveResults);
    accumulator.add(waveCosts.cost);
    accumulator.addTurns(waveCosts.turns);
    accumulator.addDuration(waveCosts.duration);
    if (budgetTracker) budgetTracker.addCost(waveCosts.cost);

    if (result.success) {
      log.info(`#${issue.number} — PR created: ${result.prUrl}`);
      const newPR = extractPRFromResult(issue, result);
      if (newPR) pendingPRs.push(newPR);
    } else {
      log.error(`#${issue.number} — Failed: ${result.error}`);
    }

    fixResultsMap.set(issue.number, { issue, result });
    return { success: result.success };
  };

  // Determine effective budget: use shared tracker if available, otherwise local budget
  const effectiveBudgetExceeded = budgetTracker ? () => budgetTracker.isExceeded() : undefined;

  // Predict each issue's file footprint from its body text so the scheduler
  // can serialize footprint-overlapping siblings when concurrency > 1.
  // Build the map unconditionally — the scheduler ignores it when
  // concurrency === 1 and the cost is negligible (one regex pass per issue).
  const footprints = new Map<number, string[]>();
  for (const issue of toFix) {
    footprints.set(issue.number, extractFootprint(issue));
  }

  await runFixesWithConcurrency(toFix, tiers, executor, {
    concurrency,
    ...(budget !== undefined ? { budget } : {}),
    costAccumulator: accumulator,
    footprints,
    shutdownRequested: () => {
      if (effectiveBudgetExceeded?.()) return true;
      return shutdownRequested();
    },
  });

  // Build LoopResult from executed fixes (preserve issue order)
  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const issue of toFix) {
    const fr = fixResultsMap.get(issue.number);
    if (fr) {
      results.push(fr);
      if (fr.result.success) succeeded++;
      else failed++;
    }
  }

  const budgetExceeded = budgetTracker
    ? budgetTracker.isExceeded()
    : budget !== undefined && accumulator.exceedsBudget(budget);

  if (budgetExceeded) {
    if (budgetTracker) {
      log.info(
        `Shared budget exceeded: $${budgetTracker.totalSpent().toFixed(2)} spent of $${budgetTracker.limitUsd.toFixed(2)} budget — stopping loop`,
      );
    } else {
      log.info(
        `Budget exceeded: $${accumulator.get().toFixed(2)} spent of $${budget?.toFixed(2)} budget — stopping loop`,
      );
    }
  }

  log.info(`\n${'='.repeat(60)}`);
  log.info(
    'Loop complete: ' +
      succeeded +
      ' succeeded, ' +
      failed +
      ' failed, ' +
      '0 skipped (' +
      results.length +
      '/' +
      issues.length +
      ' total)',
  );
  log.info(
    'Cumulative cost: $' +
      accumulator.get().toFixed(2) +
      ' | ' +
      accumulator.getTurns() +
      ' turns | ' +
      Math.floor(accumulator.getDuration() / 1000) +
      's',
  );
  const loopResult: LoopResult = {
    total: results.length,
    succeeded,
    failed,
    skipped: 0,
    totalCost: accumulator.get(),
    totalTurns: accumulator.getTurns(),
    totalDuration: accumulator.getDuration(),
    budgetExceeded,
    startedAt,
    results,
  };

  let milestoneInput: { milestone: string; openCount: number; closedCount: number } | undefined;
  if (milestone) {
    const counts = await fetchMilestoneCounts(repoPath, milestone);
    milestoneInput = { milestone, openCount: counts.open, closedCount: counts.closed };
  }
  const runReport = buildRunReport(loopResult, milestoneInput);
  printRunReport(runReport);
  await writeRunReport(repoPath, runReport).catch((err) => {
    log.warn(`Failed to write run report: ${err instanceof Error ? err.message : String(err)}`);
  });

  return loopResult;
}

export interface FixByNumbersOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  issueNumbers: number[];
  budgetUsd?: number | undefined;
  force?: boolean | undefined;
}

export async function fixByNumbers(options: FixByNumbersOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, issueNumbers, budgetUsd } = options;
  const startedAt = new Date().toISOString();
  const budget = budgetUsd;
  const concurrency = config.rules.concurrency ?? 1;

  if (budget !== undefined) {
    log.info(`Budget cap: $${budget.toFixed(2)}`);
  }

  if (issueNumbers.length === 0) {
    log.info('No issue numbers provided.');
    return emptyResult(startedAt);
  }

  log.info(`Processing ${issueNumbers.length} issues by number`);

  const initialPRs: OpenPR[] = await fetchOpenPRsDetailed(repoPath).catch((err) => {
    log.warn(`Failed to fetch open PRs for context: ${err instanceof Error ? err.message : String(err)}`);
    return [] as OpenPR[];
  });
  const pendingPRs: OpenPR[] = [...initialPRs];
  if (pendingPRs.length > 0) {
    log.info(`Loaded ${pendingPRs.length} open PRs for conflict awareness`);
  }

  // Fetch all issues, tracking failures
  const fetchedIssues: Issue[] = [];
  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const issueNumber of issueNumbers) {
    log.info(`\n${'='.repeat(60)}`);
    log.info(`Fetching issue #${issueNumber}...`);

    try {
      const issue = await fetchIssue(repoPath, issueNumber);
      fetchedIssues.push(issue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`#${issueNumber} — Failed to fetch: ${msg}`);
      failed++;
      results.push({
        issue: { number: issueNumber, title: `(unfetchable #${issueNumber})`, body: '', labels: [], url: '' },
        result: {
          success: false,
          error: msg,
          state: {
            issue: { number: issueNumber, title: '', body: '', labels: [], url: '' },
            repo: repoName,
            repoPath,
            startedAt: new Date().toISOString(),
            completedWaves: [],
            waveResults: {},
            status: 'failed',
          },
        },
      });
    }
  }

  if (fetchedIssues.length > 0) {
    // Single tier — no dependency info for explicit issue numbers
    const tiers: number[][] = [fetchedIssues.map((_, i) => i)];

    const accumulator = new CostAccumulator({
      onCostUpdate: (total) => metrics.setCurrentCostUsd(total),
    });
    const fixResultsMap = new Map<number, { issue: Issue; result: FixResult }>();

    // pendingPRs is shared across concurrent executors. Each executor snapshots
    // it at call time, so concurrent siblings may or may not see each other's PRs.
    // This is acceptable — PR conflict awareness is best-effort.
    const executor: FixExecutor = async (issue) => {
      log.info(`Fixing #${issue.number}: ${issue.title}`);
      log.info('='.repeat(60));

      // Pull latest before each fix to stay current with default branch
      try {
        await $`git -C ${repoPath} fetch origin`;
        log.debug('Fetched latest from origin before fix');
      } catch (err) {
        log.warn(`Failed to fetch origin: ${err instanceof Error ? err.message : String(err)}`);
      }

      const result = await fix({ issue, repoPath, repoName, config, pendingPRs: [...pendingPRs] });

      const waveCosts = aggregateWaveCosts(result.state.waveResults);
      accumulator.add(waveCosts.cost);
      accumulator.addTurns(waveCosts.turns);
      accumulator.addDuration(waveCosts.duration);

      if (result.success) {
        log.info(`#${issue.number} — PR created: ${result.prUrl}`);
        const newPR = extractPRFromResult(issue, result);
        if (newPR) pendingPRs.push(newPR);
      } else {
        log.error(`#${issue.number} — Failed: ${result.error}`);
      }

      fixResultsMap.set(issue.number, { issue, result });
      return { success: result.success };
    };

    // Predict each issue's file footprint so the scheduler can serialize
    // footprint-overlapping siblings when concurrency > 1. The map is cheap
    // and ignored by the scheduler when concurrency === 1.
    const footprints = new Map<number, string[]>();
    for (const issue of fetchedIssues) {
      footprints.set(issue.number, extractFootprint(issue));
    }

    await runFixesWithConcurrency(fetchedIssues, tiers, executor, {
      concurrency,
      ...(budget !== undefined ? { budget } : {}),
      costAccumulator: accumulator,
      footprints,
      shutdownRequested,
    });

    // Collect results preserving issue order
    for (const issue of fetchedIssues) {
      const fr = fixResultsMap.get(issue.number);
      if (fr) {
        results.push(fr);
        if (fr.result.success) succeeded++;
        else failed++;
      }
    }

    const budgetExceeded = budget !== undefined && accumulator.exceedsBudget(budget);

    if (budgetExceeded) {
      log.info(
        `Budget exceeded: $${accumulator.get().toFixed(2)} spent of $${budget?.toFixed(2)} budget — stopping loop`,
      );
    }

    log.info(`\n${'='.repeat(60)}`);
    log.info(
      'Loop complete: ' +
        succeeded +
        ' succeeded, ' +
        failed +
        ' failed, ' +
        '0 skipped (' +
        results.length +
        '/' +
        issueNumbers.length +
        ' total)',
    );
    log.info(
      'Cumulative cost: $' +
        accumulator.get().toFixed(2) +
        ' | ' +
        accumulator.getTurns() +
        ' turns | ' +
        Math.floor(accumulator.getDuration() / 1000) +
        's',
    );

    const loopResult: LoopResult = {
      total: results.length,
      succeeded,
      failed,
      skipped: 0,
      totalCost: accumulator.get(),
      totalTurns: accumulator.getTurns(),
      totalDuration: accumulator.getDuration(),
      budgetExceeded,
      startedAt,
      results,
    };

    const runReport = buildRunReport(loopResult);
    printRunReport(runReport);
    await writeRunReport(repoPath, runReport).catch((err) => {
      log.warn(`Failed to write run report: ${err instanceof Error ? err.message : String(err)}`);
    });

    return loopResult;
  }

  // All fetches failed — no fixes to run
  log.info(`\n${'='.repeat(60)}`);
  log.info(
    'Loop complete: 0 succeeded, ' +
      failed +
      ' failed, 0 skipped (' +
      results.length +
      '/' +
      issueNumbers.length +
      ' total)',
  );
  log.info('Cumulative cost: $0.00 | 0 turns | 0s');

  const loopResult: LoopResult = {
    total: results.length,
    succeeded: 0,
    failed,
    skipped: 0,
    totalCost: 0,
    totalTurns: 0,
    totalDuration: 0,
    budgetExceeded: false,
    startedAt,
    results,
  };

  const runReport = buildRunReport(loopResult);
  printRunReport(runReport);
  await writeRunReport(repoPath, runReport).catch((err) => {
    log.warn(`Failed to write run report: ${err instanceof Error ? err.message : String(err)}`);
  });

  return loopResult;
}
