#!/usr/bin/env node

// Kova CLI — autonomous code agent
// Usage:
//   kova fix <issue-number>         Fix a single issue
//   kova fix --all                  Fix all open issues (loop)
//   kova fix --all --filter <label> Fix labeled issues
//   kova fix 123 --repo onexos      Fix issue in named repo from repos.yaml
//   kova brainstorm                 Analyze repo, generate issue suite
//   kova auto                       Autonomous mode (all repos if config exists)

import { resolve } from 'node:path';
import { Command } from 'commander';
import { runAuto, runAutoMultiRepo } from '../pipeline/auto.js';
import { brainstorm, printBrainstormPreview } from '../pipeline/brainstorm.js';
import { fix } from '../pipeline/fix.js';
import { fixLoop } from '../pipeline/loop.js';
import { runSupervised } from '../pipeline/supervised.js';
import { approveIssues } from '../services/approval.js';
import {
  detectRepoName,
  findRepoByName,
  loadConfig,
  resolveConfigPath,
  resolveRepoConfig,
} from '../services/config.js';
import { createIssue, fetchIssue, hasExistingWork } from '../services/github.js';
import {
  exitCodeForSignal,
  getShutdownSignal,
  installSignalHandlers,
  removeSignalHandlers,
  shutdownRequested,
} from '../services/shutdown.js';
import type { KovaConfig, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';

const program = new Command();

program
  .name('kova')
  .description('Autonomous code agent — brainstorm issues, fix them, ship PRs')
  .version('0.2.75')
  .option('--config <path>', 'Path to repos.yaml config file');

/** Resolve --repo: look up by name in config, fall back to path. */
function resolveRepo(
  repoOpt: string,
  kovaConfig: KovaConfig | undefined,
): { repoPath: string; repoName: string; config: RepoConfig } {
  // If we have a global config, try name-based lookup first
  if (kovaConfig) {
    const found = findRepoByName(kovaConfig, repoOpt);
    if (found) {
      return { repoPath: found.config.path, repoName: found.name, config: found.config };
    }
  }

  // Fall back to path-based resolution
  const repoPath = resolve(repoOpt);
  const repoName = detectRepoName(repoPath);
  const config = resolveRepoConfig(repoPath);
  return { repoPath, repoName, config };
}

/** Try loading the global config. Returns undefined if not found. */
async function tryLoadConfig(configOpt?: string): Promise<KovaConfig | undefined> {
  const configPath = resolveConfigPath(configOpt);
  try {
    return await loadConfig(configPath);
  } catch {
    // Config file doesn't exist or is invalid — that's fine for single-repo mode
    return undefined;
  }
}

program
  .command('fix')
  .description('Fix GitHub issues')
  .argument('[issue]', 'Issue number to fix')
  .option('--all', 'Fix all open issues in sequence')
  .option('--filter <label>', 'Filter issues by label')
  .option('--max <n>', 'Maximum issues to fix', '10')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
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
      const kovaConfig = await tryLoadConfig(program.opts().config);
      const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);

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
  .description('Autonomous mode — iterates all repos in config, or single repo')
  .option('--filter <label>', 'Filter issues by label (overrides config)')
  .option('--max <n>', 'Maximum issues to fix per repo (overrides config)')
  .option('--force', 'Override skip — re-fix issues with existing branches/PRs')
  .option('--repo <name-or-path>', 'Single repository name or path (skip multi-repo)')
  .action(async (opts: { filter?: string; max?: string; force?: boolean; repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);

    installSignalHandlers();

    // If --repo specified or no config, run single-repo mode
    if (opts.repo || !kovaConfig) {
      const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);
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
    }

    // Multi-repo mode: iterate all repos in config order
    const result = await runAutoMultiRepo({
      config: kovaConfig,
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

program
  .command('brainstorm')
  .description('Analyze codebase and generate structured issue suite')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .option('--threshold <n>', 'Minimum confidence score (0.0-1.0)', '0.7')
  .option('--focus <areas>', 'Comma-separated focus areas (e.g., "security,performance")')
  .option('--yes', 'Auto-approve all issues (no interactive prompts)')
  .action(async (opts: { repo?: string; threshold?: string; focus?: string; yes?: boolean }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, config } = resolveRepo(opts.repo ?? '.', kovaConfig);
    const threshold = Number.parseFloat(opts.threshold ?? '0.7');
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      console.error('--threshold must be a number between 0.0 and 1.0');
      process.exit(1);
    }
    const focus = opts.focus ? opts.focus.split(',').map((s) => s.trim()) : undefined;

    log.info('Brainstorming issues...');
    const result = await brainstorm({ repoPath, config, threshold, focus });
    printBrainstormPreview(result);

    if (!result.success) {
      process.exit(1);
    }

    // Interactive approval flow
    const approval = await approveIssues(result.issues, opts.yes ? { autoApprove: true } : {});

    if (approval.approved.length === 0) {
      log.info('No issues approved — nothing to create.');
      return;
    }

    // Create approved issues on GitHub
    let created = 0;
    for (const issue of approval.approved) {
      try {
        const { number, url } = await createIssue(repoPath, issue.title, issue.body, issue.labels);
        log.info(`Created #${number}: ${url}`);
        created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to create "${issue.title}": ${message}`);
      }
    }

    log.info(
      `\nSummary: ${created} created, ${approval.rejected} rejected, ${approval.edited} edited, ${approval.skipped} skipped`,
    );
  });

program
  .command('supervised')
  .description('Supervised mode — brainstorm, approve, fix batch, review PRs')
  .option('--skip-brainstorm', 'Skip brainstorm phase and use existing issues')
  .option('--repo <path>', 'Repository path', '.')
  .option('--threshold <n>', 'Minimum confidence score for brainstorm (0.0-1.0)', '0.7')
  .option('--focus <areas>', 'Comma-separated focus areas (e.g., "security,performance")')
  .option('--yes', 'Auto-approve all issues (no interactive prompts)')
  .option('--budget <usd>', 'Maximum USD budget for fix loop')
  .option('--max <n>', 'Maximum issues to fix', '10')
  .action(
    async (opts: {
      skipBrainstorm?: boolean;
      repo?: string;
      threshold?: string;
      focus?: string;
      yes?: boolean;
      budget?: string;
      max?: string;
    }) => {
      const repoPath = resolve(opts.repo ?? '.');
      const repoName = detectRepoName(repoPath);
      const config = resolveRepoConfig(repoPath);

      const threshold = opts.threshold ? Number.parseFloat(opts.threshold) : undefined;
      const focus = opts.focus ? opts.focus.split(',').map((s) => s.trim()) : undefined;
      const budgetUsd = opts.budget ? Number.parseFloat(opts.budget) : undefined;

      installSignalHandlers();
      let success = false;
      try {
        const result = await runSupervised({
          repoPath,
          repoName,
          config,
          ...(opts.skipBrainstorm && { skipBrainstorm: true }),
          ...(threshold !== undefined && { threshold }),
          ...(focus !== undefined && { focus }),
          ...(opts.yes && { yes: true }),
          ...(budgetUsd !== undefined && { budgetUsd }),
        });
        success = result.success;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Supervised mode failed: ${message}`);
      }
      removeSignalHandlers();

      if (shutdownRequested()) {
        process.exit(exitCodeForSignal(getShutdownSignal()));
      }
      process.exit(success ? 0 : 1);
    },
  );

program.parse();
