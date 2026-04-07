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
