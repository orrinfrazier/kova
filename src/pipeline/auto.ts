import { collectChangedFilesFromPRs, reindexFiles } from '../services/reindex.js';
import type { KovaConfig, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import { fixLoop, type LoopResult } from './loop.js';

export interface AutoOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  filter?: string | undefined;
  max?: number | undefined;
  force?: boolean | undefined;
}

export interface AutoResult {
  exitCode: number;
  loopResult: LoopResult;
}

export async function runAuto(options: AutoOptions): Promise<AutoResult> {
  const { repoPath, repoName, config, filter, max, force } = options;
  const autoConfig = config.auto;

  const resolvedFilter = filter ?? autoConfig?.filter;
  const resolvedMax = max ?? autoConfig?.max_per_run ?? config.rules.max_issues_per_run;

  log.info(`[auto] Starting autonomous run for ${repoName}`);
  if (resolvedFilter) {
    log.info(`[auto] Label filter: ${resolvedFilter}`);
  }
  log.info(`[auto] Max issues: ${resolvedMax}`);

  const loopResult = await fixLoop({
    repoPath,
    repoName,
    config,
    filter: resolvedFilter,
    maxIssues: resolvedMax,
    force,
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
  max?: number | undefined;
  force?: boolean | undefined;
}

export interface MultiRepoAutoResult {
  exitCode: number;
  repoResults: Array<{ repoName: string; loopResult: LoopResult }>;
}

/** Run auto mode across all repos in a KovaConfig, in config order. */
export async function runAutoMultiRepo(options: MultiRepoAutoOptions): Promise<MultiRepoAutoResult> {
  const { config, filter, max, force } = options;
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
