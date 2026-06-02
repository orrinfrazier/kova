import { fetchIssues } from '../services/github.js';
import { collectChangedFilesFromPRs, reindexFiles } from '../services/reindex.js';
import type { Issue, KovaConfig, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import { buildCrossRepoTiers } from './cross-repo-scheduler.js';
import { fixLoop, type LoopResult } from './loop.js';
import { buildMultiRepoRunReport, printMultiRepoRunReport } from './run-report.js';
import { createSharedBudget, type SharedBudgetTracker } from './shared-budget.js';

export interface AutoOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  filter?: string | undefined;
  /** Milestone title — forwarded to fixLoop to scope the issue fetch + enable progress reporting. */
  milestone?: string | undefined;
  max?: number | undefined;
  force?: boolean | undefined;
  budgetTracker?: SharedBudgetTracker | undefined;
}

export interface AutoResult {
  exitCode: number;
  loopResult: LoopResult;
}

export async function runAuto(options: AutoOptions): Promise<AutoResult> {
  const { repoPath, repoName, config, filter, milestone, max, force, budgetTracker } = options;
  const autoConfig = config.auto;

  const resolvedFilter = filter ?? autoConfig?.filter;
  const resolvedMax = max ?? autoConfig?.max_per_run ?? config.rules.max_issues_per_run;

  log.info(`[auto] Starting autonomous run for ${repoName}`);
  if (resolvedFilter) {
    log.info(`[auto] Label filter: ${resolvedFilter}`);
  }
  if (milestone) {
    log.info(`[auto] Milestone filter: ${milestone}`);
  }
  log.info(`[auto] Max issues: ${resolvedMax}`);

  const loopResult = await fixLoop({
    repoPath,
    repoName,
    config,
    filter: resolvedFilter,
    ...(milestone !== undefined ? { milestone } : {}),
    maxIssues: resolvedMax,
    force,
    budgetTracker,
  });

  const exitCode = loopResult.failed > 0 ? 1 : 0;

  log.info(`[auto] Complete: ${loopResult.succeeded}/${loopResult.total} succeeded`);

  // Reindex changed files in vector DB (incremental)
  if (config.vectordb?.enabled && loopResult.succeeded > 0) {
    await reindexAfterLoop(config, repoPath, loopResult);
  }

  return { exitCode, loopResult };
}

/* ------------------------------------------------------------------ */
/*  Multi-repo auto mode                                               */
/* ------------------------------------------------------------------ */

export interface MultiRepoAutoOptions {
  config: KovaConfig;
  filter?: string | undefined;
  milestone?: string | undefined;
  max?: number | undefined;
  force?: boolean | undefined;
}

export interface MultiRepoAutoResult {
  exitCode: number;
  repoResults: Array<{ repoName: string; loopResult: LoopResult }>;
}

/** Run auto mode across all repos in a KovaConfig, in config order. */
export async function runAutoMultiRepo(options: MultiRepoAutoOptions): Promise<MultiRepoAutoResult> {
  const { config, filter, milestone, max, force } = options;
  const repoEntries = Object.entries(config.repos);

  log.info(`[auto] Multi-repo mode: ${repoEntries.length} repos`);

  const repoResults: Array<{ repoName: string; loopResult: LoopResult }> = [];
  let anyFailed = false;

  for (const [name, repoConfig] of repoEntries) {
    log.info(`\n${'─'.repeat(60)}`);
    log.info(`[auto] Repo: ${name} (${repoConfig.path})`);
    log.info('─'.repeat(60));

    const result = await runAuto({
      repoPath: repoConfig.path,
      repoName: name,
      config: repoConfig,
      filter,
      ...(milestone !== undefined ? { milestone } : {}),
      max,
      force,
    });

    repoResults.push({ repoName: name, loopResult: result.loopResult });
    if (result.exitCode !== 0) {
      anyFailed = true;
    }
  }

  const exitCode = anyFailed ? 1 : 0;
  log.info(`\n[auto] Multi-repo complete: ${repoResults.length} repos processed, exit ${exitCode}`);

  return { exitCode, repoResults };
}

/* ------------------------------------------------------------------ */
/*  Multi-repo parallel auto mode                                      */
/* ------------------------------------------------------------------ */

export interface MultiRepoParallelOptions {
  config: KovaConfig;
  filter?: string | undefined;
  milestone?: string | undefined;
  max?: number | undefined;
  force?: boolean | undefined;
  budgetUsd?: number | undefined;
}

interface ParallelRepoResult {
  repoName: string;
  loopResult: LoopResult;
  error?: string | undefined;
}

export interface MultiRepoParallelResult {
  exitCode: number;
  repoResults: ParallelRepoResult[];
  aggregated: {
    totalCost: number;
    succeeded: number;
    failed: number;
  };
}

/**
 * Run auto mode across all repos. Repos with no cross-repo blockers run
 * concurrently; repos blocked by another configured repo defer until the
 * blocker repo completes (issue #287).
 *
 * Each repo still gets its own sequential fix queue inside `runAuto` /
 * `fixLoop`. Cross-repo gating is layered on top via repo tiers built from
 * `parseCrossRepoDependencies` over pre-fetched issue bodies. When no
 * `slug` is configured on any repo (or no cross-repo edges resolve), the
 * tier graph collapses to a single tier and behavior is identical to the
 * pre-#287 fully-parallel implementation.
 */
export async function runAutoMultiRepoParallel(options: MultiRepoParallelOptions): Promise<MultiRepoParallelResult> {
  const { config, filter, milestone, max, force, budgetUsd } = options;
  const repoEntries = Object.entries(config.repos);

  log.info(`[auto] Multi-repo parallel mode: ${repoEntries.length} repos`);

  const budgetTracker = budgetUsd !== undefined ? createSharedBudget(budgetUsd) : undefined;
  if (budgetTracker) {
    log.info(`[auto] Shared budget cap: $${budgetTracker.limitUsd.toFixed(2)}`);
  }

  // ---- Cross-repo dependency awareness (issue #287) ----
  //
  // Pre-fetch issues for slug-bearing repos so we can build the cross-repo
  // dependency graph BEFORE dispatching any runAuto. Repos without a slug
  // can't be targeted by `owner/name#N` references, so we skip the fetch
  // for them and treat them as having no incoming cross-repo edges.
  //
  // Pre-fetch failures degrade gracefully — the repo just shows up with no
  // pre-fetched issues, which means no cross-repo edges resolve through it.
  // The actual fixLoop call still runs and does its own fetch.
  const slugByName = new Map<string, string>();
  for (const [name, repoConfig] of repoEntries) {
    if (repoConfig.slug !== undefined) slugByName.set(name, repoConfig.slug);
  }

  const reposByName = new Map<string, Issue[]>();
  if (slugByName.size > 0) {
    await Promise.allSettled(
      repoEntries.map(async ([name, repoConfig]) => {
        try {
          const issues = await fetchIssues(repoConfig.path, filter ?? repoConfig.auto?.filter);
          reposByName.set(name, issues);
        } catch (err) {
          log.warn(
            `[auto] Pre-fetch for cross-repo dep graph failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          reposByName.set(name, []);
        }
      }),
    );
  } else {
    for (const [name] of repoEntries) reposByName.set(name, []);
  }

  const repoTiers = buildCrossRepoTiers({ reposByName, slugByName });
  if (repoTiers.length > 1) {
    log.info(`[auto] Cross-repo dep graph: ${repoTiers.length} tier(s) of repos`);
  }

  const settled: PromiseSettledResult<ParallelRepoResult>[] = [];
  const settledByName = new Map<string, PromiseSettledResult<ParallelRepoResult>>();

  const dispatchRepo = async (name: string): Promise<ParallelRepoResult> => {
    const repoConfig = config.repos[name];
    if (!repoConfig) throw new Error(`repo ${name} not in config`);
    log.info(`[auto] Starting repo: ${name} (${repoConfig.path})`);
    const result = await runAuto({
      repoPath: repoConfig.path,
      repoName: name,
      config: repoConfig,
      filter,
      ...(milestone !== undefined ? { milestone } : {}),
      max,
      force,
      budgetTracker,
    });
    return { repoName: name, loopResult: result.loopResult };
  };

  for (const tier of repoTiers) {
    const tierSettled = await Promise.allSettled(tier.map((entry) => dispatchRepo(entry.repoName)));
    for (let i = 0; i < tier.length; i++) {
      const entry = tier[i];
      const result = tierSettled[i];
      if (entry === undefined || result === undefined) continue;
      settledByName.set(entry.repoName, result);
    }
  }

  // Preserve original config order in the results array for stable downstream
  // reporting (run-report, aggregation, regression tests).
  for (const [name] of repoEntries) {
    const result = settledByName.get(name);
    if (result !== undefined) settled.push(result);
  }

  const repoResults: ParallelRepoResult[] = settled.map((s, i) => {
    const repoName = repoEntries[i]?.[0] ?? 'unknown';
    if (s.status === 'fulfilled') {
      return s.value;
    }
    const errorMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
    log.error(`[auto] Repo ${repoName} failed: ${errorMsg}`);
    return {
      repoName,
      loopResult: emptyLoopResult(),
      error: errorMsg,
    };
  });

  const anyFailed = repoResults.some((r) => r.error !== undefined || r.loopResult.failed > 0);
  const exitCode = anyFailed ? 1 : 0;

  const aggregated = {
    totalCost: repoResults.reduce((sum, r) => sum + r.loopResult.totalCost, 0),
    succeeded: repoResults.reduce((sum, r) => sum + r.loopResult.succeeded, 0),
    failed: repoResults.reduce((sum, r) => sum + r.loopResult.failed, 0),
  };

  // Print aggregated report
  const validResults = repoResults
    .filter((r) => r.error === undefined)
    .map((r) => ({ repoName: r.repoName, loopResult: r.loopResult }));
  if (validResults.length > 0) {
    const report = buildMultiRepoRunReport(validResults);
    printMultiRepoRunReport(report);
  }

  log.info(
    `\n[auto] Multi-repo parallel complete: ${repoResults.length} repos, ` +
      `${aggregated.succeeded} succeeded, ${aggregated.failed} failed, ` +
      `$${aggregated.totalCost.toFixed(2)} total cost`,
  );

  return { exitCode, repoResults, aggregated };
}

function emptyLoopResult(): LoopResult {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    totalCost: 0,
    totalTurns: 0,
    totalDuration: 0,
    budgetExceeded: false,
    startedAt: new Date().toISOString(),
    results: [],
    outcomes: [],
    skippedByReason: {},
  };
}

/* ------------------------------------------------------------------ */
/*  Post-loop reindex                                                  */
/* ------------------------------------------------------------------ */

async function reindexAfterLoop(config: RepoConfig, repoPath: string, loopResult: LoopResult): Promise<void> {
  const vectordb = config.vectordb;
  if (!vectordb) return;

  const prUrls = loopResult.results
    .filter((r) => r.result.success && r.result.prUrl)
    .map((r) => r.result.prUrl as string);

  if (prUrls.length === 0) return;

  log.info(`[auto] Collecting changed files from ${prUrls.length} PRs for reindex...`);
  const files = await collectChangedFilesFromPRs(repoPath, prUrls);

  if (files.length === 0) {
    log.info('[auto] No changed files detected — skipping reindex');
    return;
  }

  log.info(`[auto] Reindexing ${files.length} changed files...`);
  const result = await reindexFiles(vectordb, repoPath, files);

  if (result.success) {
    log.info(
      `[auto] Reindex complete: ${result.filesSubmitted} files, ${result.apiCalls} API calls (${result.duration}ms)`,
    );
  } else {
    log.warn(`[auto] Reindex failed: ${result.error}`);
  }
}
