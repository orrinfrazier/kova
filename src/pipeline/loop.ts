import { $ } from 'zx';
import { fetchIssue, fetchIssues } from '../services/github.js';
import * as metrics from '../services/metrics.js';
import { extractPRFromResult, fetchOpenPRsDetailed, type OpenPR } from '../services/pr-context.js';
import { prioritizeIssues } from '../services/prioritize.js';
import { shutdownRequested } from '../services/shutdown.js';
import type { Issue, RepoConfig, WaveResult } from '../types/index.js';
import { log } from '../utils/logger.js';
import { type FixResult, fix } from './fix.js';
import { buildRunReport, printRunReport, writeRunReport } from './run-report.js';
import type { SharedBudgetTracker } from './shared-budget.js';

$.verbose = false;

export interface LoopOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  filter?: string | undefined;
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

export async function fixLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, filter, maxIssues, budgetUsd, budgetTracker } = options;
  const startedAt = new Date().toISOString();
  const limit = maxIssues ?? config.auto?.max_per_run ?? config.rules.max_issues_per_run;
  const budget = budgetTracker ? undefined : (budgetUsd ?? config.rules.budget_usd);
  log.info(`Fetching open issues for ${repoName}...`);
  if (budgetTracker) {
    log.info(`Shared budget cap: $${budgetTracker.limitUsd.toFixed(2)}`);
  } else if (budget !== undefined) {
    log.info(`Budget cap: $${budget.toFixed(2)}`);
  }
  const issues = await fetchIssues(repoPath, filter);
  if (issues.length === 0) {
    log.info('No open issues found.');
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
  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;
  const skipped = 0;
  let totalCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  let budgetExceeded = false;
  for (const issue of toFix) {
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

    const result = await fix({ issue, repoPath, repoName, config, pendingPRs });
    results.push({ issue, result });
    const waveCosts = aggregateWaveCosts(result.state.waveResults);
    totalCost += waveCosts.cost;
    totalTurns += waveCosts.turns;
    totalDuration += waveCosts.duration;
    metrics.setCurrentCostUsd(totalCost);
    if (result.success) {
      succeeded++;
      log.info(`#${issue.number} — PR created: ${result.prUrl}`);
      const newPR = extractPRFromResult(issue, result);
      if (newPR) {
        pendingPRs.push(newPR);
      }
    } else {
      failed++;
      log.error(`#${issue.number} — Failed: ${result.error}`);
    }
    if (budgetTracker) {
      budgetTracker.addCost(waveCosts.cost);
      if (budgetTracker.isExceeded()) {
        budgetExceeded = true;
        log.info(
          `Shared budget exceeded: $${budgetTracker.totalSpent().toFixed(2)} spent of $${budgetTracker.limitUsd.toFixed(2)} budget — stopping loop`,
        );
        break;
      }
    } else if (budget !== undefined && totalCost >= budget) {
      budgetExceeded = true;
      log.info(`Budget exceeded: $${totalCost.toFixed(2)} spent of $${budget.toFixed(2)} budget — stopping loop`);
      break;
    }
    if (shutdownRequested()) {
      log.info(`Shutdown requested — stopping loop after #${issue.number}`);
      break;
    }
  }
  log.info(`\n${'='.repeat(60)}`);
  log.info(
    'Loop complete: ' +
      succeeded +
      ' succeeded, ' +
      failed +
      ' failed, ' +
      skipped +
      ' skipped (' +
      results.length +
      '/' +
      issues.length +
      ' total)',
  );
  log.info(
    'Cumulative cost: $' +
      totalCost.toFixed(2) +
      ' | ' +
      totalTurns +
      ' turns | ' +
      Math.floor(totalDuration / 1000) +
      's',
  );
  const loopResult: LoopResult = {
    total: results.length,
    succeeded,
    failed,
    skipped,
    totalCost,
    totalTurns,
    totalDuration,
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

  if (budget !== undefined) {
    log.info(`Budget cap: $${budget.toFixed(2)}`);
  }

  if (issueNumbers.length === 0) {
    log.info('No issue numbers provided.');
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

  log.info(`Processing ${issueNumbers.length} issues by number`);

  const initialPRs: OpenPR[] = await fetchOpenPRsDetailed(repoPath).catch((err) => {
    log.warn(`Failed to fetch open PRs for context: ${err instanceof Error ? err.message : String(err)}`);
    return [] as OpenPR[];
  });
  const pendingPRs: OpenPR[] = [...initialPRs];
  if (pendingPRs.length > 0) {
    log.info(`Loaded ${pendingPRs.length} open PRs for conflict awareness`);
  }

  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;
  const skipped = 0;
  let totalCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  let budgetExceeded = false;

  for (const issueNumber of issueNumbers) {
    if (shutdownRequested()) {
      log.info(`Shutdown requested — stopping loop before #${issueNumber}`);
      break;
    }

    log.info(`\n${'='.repeat(60)}`);
    log.info(`Fetching issue #${issueNumber}...`);

    let issue: Issue;
    try {
      issue = await fetchIssue(repoPath, issueNumber);
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
      continue;
    }

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
    results.push({ issue, result });
    const waveCosts = aggregateWaveCosts(result.state.waveResults);
    totalCost += waveCosts.cost;
    totalTurns += waveCosts.turns;
    totalDuration += waveCosts.duration;
    metrics.setCurrentCostUsd(totalCost);

    if (result.success) {
      succeeded++;
      log.info(`#${issue.number} — PR created: ${result.prUrl}`);
      const newPR = extractPRFromResult(issue, result);
      if (newPR) {
        pendingPRs.push(newPR);
      }
    } else {
      failed++;
      log.error(`#${issue.number} — Failed: ${result.error}`);
    }

    if (budget !== undefined && totalCost >= budget) {
      budgetExceeded = true;
      log.info(`Budget exceeded: $${totalCost.toFixed(2)} spent of $${budget.toFixed(2)} budget — stopping loop`);
      break;
    }
  }

  log.info(`\n${'='.repeat(60)}`);
  log.info(
    'Loop complete: ' +
      succeeded +
      ' succeeded, ' +
      failed +
      ' failed, ' +
      skipped +
      ' skipped (' +
      results.length +
      '/' +
      issueNumbers.length +
      ' total)',
  );
  log.info(
    'Cumulative cost: $' +
      totalCost.toFixed(2) +
      ' | ' +
      totalTurns +
      ' turns | ' +
      Math.floor(totalDuration / 1000) +
      's',
  );

  const loopResult: LoopResult = {
    total: results.length,
    succeeded,
    failed,
    skipped,
    totalCost,
    totalTurns,
    totalDuration,
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
