// Fix loop — iterate through issues in priority order, fixing each one.

import { fetchIssues } from '../services/github.js';
import type { Issue, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import { type FixResult, fix } from './fix.js';

export interface LoopOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  filter?: string | undefined;
  maxIssues?: number | undefined;
}

export interface LoopResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{ issue: Issue; result: FixResult }>;
}

export async function fixLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoPath, repoName, config, filter, maxIssues } = options;
  const limit = maxIssues ?? config.auto?.max_per_run ?? config.rules.max_issues_per_run;

  // 1. Fetch open issues
  log.info(`Fetching open issues for ${repoName}...`);
  const issues = await fetchIssues(repoPath, filter);

  if (issues.length === 0) {
    log.info('No open issues found.');
    return { total: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
  }

  log.info(`Found ${issues.length} issues, processing up to ${limit}`);

  // 2. TODO: prioritize/sort by dependency (for now, use issue order)
  const toFix = issues.slice(0, limit);

  // 3. Fix each issue sequentially
  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;
  const skipped = 0;

  for (const issue of toFix) {
    log.info(`\n${'='.repeat(60)}`);
    log.info(`Fixing #${issue.number}: ${issue.title}`);
    log.info(`${'='.repeat(60)}`);

    const result = await fix({ issue, repoPath, repoName, config });
    results.push({ issue, result });

    if (result.success) {
      succeeded++;
      log.info(`#${issue.number} — PR created: ${result.prUrl}`);
    } else {
      failed++;
      log.error(`#${issue.number} — Failed: ${result.error}`);
    }
  }

  // 4. Summary
  log.info(`\n${'='.repeat(60)}`);
  log.info(
    `Loop complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (${results.length}/${issues.length} total)`,
  );

  return { total: results.length, succeeded, failed, skipped, results };
}
