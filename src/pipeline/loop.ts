import { $ } from 'zx';
import type { RuntimeKind } from '../ai/runtime/index.js';
import { type EventBus, getDefaultEventBus } from '../services/event-bus/index.js';
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
  /**
   * Override for `gh issue list --limit`. Issue #288 — decoupled from the
   * processing cap (`maxIssues` / `max_issues_per_run`) so the loop can fetch
   * a wider window and record every fetched issue in the coverage ledger.
   * Falls back to `config.rules.gh_fetch_limit`, then to the github.ts default.
   */
  fetchLimit?: number | undefined;
  budgetUsd?: number | undefined;
  force?: boolean | undefined;
  budgetTracker?: SharedBudgetTracker | undefined;
  /**
   * Optional shared `EventBus` so every concurrent fix in this loop publishes
   * to one event stream (issue #340). When omitted, the loop resolves to the
   * process-singleton `getDefaultEventBus()` — keeping behavior identical for
   * existing callers (CLI runs, tests) while enabling future daemon callers
   * (#291) to inject their own bus per run.
   */
  eventBus?: EventBus | undefined;
  /**
   * Per-invocation runtime selector (issue #407). Forwarded verbatim to each
   * `fix()` call in the loop. Overrides `config.runtime`. Undefined → fix()
   * falls back to `config.runtime` (default `'pi'`).
   */
  runtime?: RuntimeKind | undefined;
}

/**
 * Per-issue outcome record — the "coverage ledger" entry (issue #288).
 * Every issue returned from `fetchIssues` produces one of these so nothing
 * can be silently dropped between fetch and run-report.
 */
export type IssueOutcomeStatus = 'succeeded' | 'failed' | 'skipped:over-limit' | 'skipped:budget' | 'skipped:shutdown';

export interface IssueOutcome {
  issueNumber: number;
  title?: string;
  status: IssueOutcomeStatus;
  /** Optional human-readable note (e.g. failure error message). */
  reason?: string;
}

/** Skip-reason key for the run report breakdown. */
export type SkipReasonKey = 'over-limit' | 'budget' | 'shutdown';

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
  /**
   * Coverage ledger (issue #288): one entry per FETCHED issue, regardless of
   * whether it was processed, skipped over-limit, skipped on budget, or skipped
   * on shutdown. `results` only carries the processed subset; `outcomes` is the
   * full accounting that proves no targeted issue was silently dropped.
   */
  outcomes: IssueOutcome[];
  /**
   * Per-reason counts derived from `outcomes`. `skipped` equals the sum of
   * these values.
   */
  skippedByReason: Partial<Record<SkipReasonKey, number>>;
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
    outcomes: [],
    skippedByReason: {},
  };
}

/**
 * Map a scheduler "skipped: …" error to the canonical ledger status. Returns
 * undefined if the error is not a recognized skip reason (i.e. it's a real fix
 * failure). Issue #288.
 */
function classifyScheduledSkip(error: string | undefined): IssueOutcomeStatus | undefined {
  if (!error) return undefined;
  if (error.includes('budget exceeded')) return 'skipped:budget';
  if (error.includes('shutdown requested')) return 'skipped:shutdown';
  return undefined;
}

export async function fixLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, filter, milestone, maxIssues, fetchLimit, budgetUsd, budgetTracker } = options;
  // Issue #340: every concurrent fix in this loop shares one EventBus so an
  // external SSE/daemon subscriber sees a single event stream. Explicit
  // caller bus wins; otherwise fall back to the process singleton.
  const sharedEventBus = options.eventBus ?? getDefaultEventBus();
  const startedAt = new Date().toISOString();
  const limit = maxIssues ?? config.auto?.max_per_run ?? config.rules.max_issues_per_run;
  const effectiveFetchLimit = fetchLimit ?? config.rules.gh_fetch_limit;
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
  const issues = await fetchIssues(repoPath, filter, {
    ...(milestone !== undefined ? { milestone } : {}),
    ...(effectiveFetchLimit !== undefined ? { fetchLimit: effectiveFetchLimit } : {}),
  });
  if (issues.length === 0) {
    log.info('No open issues found.');
    return emptyResult(startedAt);
  }
  log.info(`Found ${issues.length} issues, prioritizing...`);
  const prioritized = prioritizeIssues(issues);
  const toFix = prioritized.slice(0, limit).map((p) => p.issue);
  const overLimit = prioritized.slice(limit).map((p) => p.issue);
  if (overLimit.length > 0) {
    log.info(`Over-limit: ${overLimit.length} fetched issues will not be attempted (max_issues_per_run=${limit})`);
  }
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

    const result = await fix({
      issue,
      repoPath,
      repoName,
      config,
      pendingPRs: [...pendingPRs],
      eventBus: sharedEventBus,
      ...(options.runtime != null ? { runtime: options.runtime } : {}),
    });

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

  const schedulerResults = await runFixesWithConcurrency(toFix, tiers, executor, {
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

  // Coverage ledger (issue #288): one IssueOutcome per FETCHED issue so no
  // targeted issue is silently dropped. Processed → succeeded/failed; not
  // processed → skipped:over-limit / skipped:budget / skipped:shutdown.
  const outcomes: IssueOutcome[] = [];
  const skippedByReason: Partial<Record<SkipReasonKey, number>> = {};
  const bumpReason = (key: SkipReasonKey): void => {
    skippedByReason[key] = (skippedByReason[key] ?? 0) + 1;
  };

  const schedulerByIssue = new Map(schedulerResults.map((r) => [r.issueNumber, r]));
  for (const issue of toFix) {
    const fr = fixResultsMap.get(issue.number);
    if (fr) {
      outcomes.push({
        issueNumber: issue.number,
        title: issue.title,
        status: fr.result.success ? 'succeeded' : 'failed',
        ...(fr.result.error !== undefined ? { reason: fr.result.error } : {}),
      });
      continue;
    }
    // Not in fixResultsMap → scheduler skipped it (budget or shutdown).
    const sched = schedulerByIssue.get(issue.number);
    const skipStatus = classifyScheduledSkip(sched?.error) ?? 'skipped:budget';
    outcomes.push({
      issueNumber: issue.number,
      title: issue.title,
      status: skipStatus,
      ...(sched?.error ? { reason: sched.error } : {}),
    });
    if (skipStatus === 'skipped:budget') bumpReason('budget');
    else if (skipStatus === 'skipped:shutdown') bumpReason('shutdown');
  }
  for (const issue of overLimit) {
    outcomes.push({
      issueNumber: issue.number,
      title: issue.title,
      status: 'skipped:over-limit',
      reason: `processing cap (max_issues_per_run=${limit})`,
    });
    bumpReason('over-limit');
  }

  const skippedTotal = outcomes.filter((o) => o.status.startsWith('skipped:')).length;

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
      skippedTotal +
      ' skipped (' +
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
    skipped: skippedTotal,
    totalCost: accumulator.get(),
    totalTurns: accumulator.getTurns(),
    totalDuration: accumulator.getDuration(),
    budgetExceeded,
    startedAt,
    results,
    outcomes,
    skippedByReason,
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
  /**
   * Optional shared `EventBus`. Same contract as `LoopOptions.eventBus`
   * (issue #340) — defaults to the process-singleton when omitted so existing
   * callers see no behavior change.
   */
  eventBus?: EventBus | undefined;
  /** Issue #407 — per-invocation runtime selector. Forwarded to fix(). */
  runtime?: RuntimeKind | undefined;
}

export async function fixByNumbers(options: FixByNumbersOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, issueNumbers, budgetUsd } = options;
  // Issue #340: share one EventBus across all fix() calls in this batch.
  const sharedEventBus = options.eventBus ?? getDefaultEventBus();
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

      const result = await fix({
        issue,
        repoPath,
        repoName,
        config,
        pendingPRs: [...pendingPRs],
        eventBus: sharedEventBus,
        ...(options.runtime != null ? { runtime: options.runtime } : {}),
      });

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

    // Coverage ledger for fixByNumbers — each requested number gets an outcome.
    const outcomes: IssueOutcome[] = results.map(({ issue, result }) => ({
      issueNumber: issue.number,
      title: issue.title,
      status: result.success ? ('succeeded' as const) : ('failed' as const),
      ...(result.error !== undefined ? { reason: result.error } : {}),
    }));

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
      outcomes,
      skippedByReason: {},
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

  const fallbackOutcomes: IssueOutcome[] = results.map(({ issue, result }) => ({
    issueNumber: issue.number,
    title: issue.title,
    status: result.success ? ('succeeded' as const) : ('failed' as const),
    ...(result.error !== undefined ? { reason: result.error } : {}),
  }));

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
    outcomes: fallbackOutcomes,
    skippedByReason: {},
  };

  const runReport = buildRunReport(loopResult);
  printRunReport(runReport);
  await writeRunReport(repoPath, runReport).catch((err) => {
    log.warn(`Failed to write run report: ${err instanceof Error ? err.message : String(err)}`);
  });

  return loopResult;
}
