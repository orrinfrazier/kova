import type { RepoConfig } from '../types/index.js';
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
