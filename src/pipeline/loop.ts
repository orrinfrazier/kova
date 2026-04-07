import { fetchIssues } from '../services/github.js';
import type { Issue, RepoConfig, WaveResult } from '../types/index.js';
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
  totalCost: number;
  totalTurns: number;
  totalDuration: number;
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
  const { repoPath, repoName, config, filter, maxIssues } = options;
  const limit = maxIssues ?? config.auto?.max_per_run ?? config.rules.max_issues_per_run;
  log.info('Fetching open issues for ' + repoName + '...');
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
      results: [],
    };
  }
  log.info('Found ' + issues.length + ' issues, processing up to ' + limit);
  const toFix = issues.slice(0, limit);
  const results: Array<{ issue: Issue; result: FixResult }> = [];
  let succeeded = 0;
  let failed = 0;
  const skipped = 0;
  let totalCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  for (const issue of toFix) {
    log.info('\n' + '='.repeat(60));
    log.info('Fixing #' + issue.number + ': ' + issue.title);
    log.info('='.repeat(60));
    const result = await fix({ issue, repoPath, repoName, config });
    results.push({ issue, result });
    const waveCosts = aggregateWaveCosts(result.state.waveResults);
    totalCost += waveCosts.cost;
    totalTurns += waveCosts.turns;
    totalDuration += waveCosts.duration;
    if (result.success) {
      succeeded++;
      log.info('#' + issue.number + ' — PR created: ' + result.prUrl);
    } else {
      failed++;
      log.error('#' + issue.number + ' — Failed: ' + result.error);
    }
  }
  log.info('\n' + '='.repeat(60));
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
  return { total: results.length, succeeded, failed, skipped, totalCost, totalTurns, totalDuration, results };
}
