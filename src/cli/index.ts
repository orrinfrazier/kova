#!/usr/bin/env node

// Kova CLI — autonomous code agent
// Usage:
//   kova fix <issue-number>         Fix a single issue
//   kova fix --all                  Fix all open issues (loop)
//   kova fix --all --filter <label> Fix labeled issues
//   kova auto                       Autonomous mode (overnight)

import { resolve } from 'node:path';
import { Command } from 'commander';
import { runAuto } from '../pipeline/auto.js';
import { fix } from '../pipeline/fix.js';
import { fixLoop } from '../pipeline/loop.js';
import { detectRepoName, resolveRepoConfig } from '../services/config.js';
import { fetchIssue, hasExistingWork } from '../services/github.js';
import {
  exitCodeForSignal,
  getShutdownSignal,
  installSignalHandlers,
  removeSignalHandlers,
  shutdownRequested,
} from '../services/shutdown.js';
import { log } from '../utils/logger.js';

const program = new Command();

program.name('kova').description('Autonomous code agent — brainstorm issues, fix them, ship PRs').version('0.1.0');

program
  .command('fix')
  .description('Fix GitHub issues')
  .argument('[issue]', 'Issue number to fix')
  .option('--all', 'Fix all open issues in sequence')
  .option('--filter <label>', 'Filter issues by label')
  .option('--max <n>', 'Maximum issues to fix', '10')
  .option('--repo <path>', 'Repository path', '.')
  .option('--fresh', 'Force restart — delete checkpoint and worktree')
  .option('--force', 'Override skip — re-fix issues with existing branches/PRs')
  .option('--budget <usd>', 'Maximum USD budget for fix loop')
  .option('--no-comment', 'Suppress GitHub comment on grade D/F skip')
  .action(
    async (
      issueArg: string | undefined,
      opts: {
        all?: boolean;
        filter?: string;
        max?: string;
        budget?: string;
        repo?: string;
        fresh?: boolean;
        force?: boolean;
        comment?: boolean;
      },
    ) => {
      const repoPath = resolve(opts.repo ?? '.');
      const repoName = detectRepoName(repoPath);
      const config = resolveRepoConfig(repoPath);

      if (opts.all) {
        // Loop mode: fix all open issues
        installSignalHandlers();
        log.info(`Starting fix loop for ${repoName}`);
        const result = await fixLoop({
          repoPath,
          repoName,
          config,
          filter: opts.filter,
          maxIssues: Number.parseInt(opts.max ?? '10', 10),
          budgetUsd: opts.budget ? Number.parseFloat(opts.budget) : undefined,
          force: opts.force,
        });
        removeSignalHandlers();

        log.info(`\nResults: ${result.succeeded}/${result.total} succeeded`);
        if (shutdownRequested()) {
          process.exit(exitCodeForSignal(getShutdownSignal()));
        }
        process.exit(result.failed > 0 ? 1 : 0);
      }

      if (!issueArg) {
        console.error('Provide an issue number or use --all');
        process.exit(1);
      }

      // Single issue mode
      const issueNumber = Number.parseInt(issueArg.replace('#', ''), 10);
      if (Number.isNaN(issueNumber)) {
        console.error(`Invalid issue number: ${issueArg}`);
        process.exit(1);
      }

      log.info(`Fixing issue #${issueNumber} in ${repoName}`);

      if (!opts.force) {
        const existing = await hasExistingWork(repoPath, issueNumber);
        if (existing) {
          log.info(`Skipping #${issueNumber}: ${existing.reason}`);
          return;
        }
      }

      const issue = await fetchIssue(repoPath, issueNumber);
      const result = await fix({
        issue,
        repoPath,
        repoName,
        config,
        fresh: opts.fresh,
        noComment: opts.comment === false,
      });

      if (result.success) {
        log.info(`Done! PR: ${result.prUrl}`);
      } else {
        log.error(`Failed: ${result.error}`);
        process.exit(1);
      }
    },
  );

program
  .command('auto')
  .description('Autonomous mode — fetch open issues, prioritize, fix sequentially')
  .option('--filter <label>', 'Filter issues by label (overrides config)')
  .option('--max <n>', 'Maximum issues to fix (overrides config)')
  .option('--force', 'Override skip — re-fix issues with existing branches/PRs')
  .option('--repo <path>', 'Repository path', '.')
  .action(async (opts: { filter?: string; max?: string; force?: boolean; repo?: string }) => {
    const repoPath = resolve(opts.repo ?? '.');
    const repoName = detectRepoName(repoPath);
    const config = resolveRepoConfig(repoPath);

    installSignalHandlers();
    const result = await runAuto({
      repoPath,
      repoName,
      config,
      filter: opts.filter,
      max: opts.max ? Number.parseInt(opts.max, 10) : undefined,
      force: opts.force,
    });
    removeSignalHandlers();

    if (shutdownRequested()) {
      process.exit(exitCodeForSignal(getShutdownSignal()));
    }
    process.exit(result.exitCode);
  });

program.parse();
