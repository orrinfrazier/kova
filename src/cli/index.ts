#!/usr/bin/env node

// Kova CLI — autonomous code agent
// Usage:
//   kova fix <issue-number>         Fix a single issue
//   kova fix --all                  Fix all open issues (loop)
//   kova fix --all --filter <label> Fix labeled issues
//   kova fix 123 --repo onexos      Fix issue in named repo from repos.yaml
//   kova brainstorm                 Analyze repo, generate issue suite
//   kova auto                       Autonomous mode (all repos if config exists)
//   kova status                     Dashboard across configured repos

import { resolve } from 'node:path';
import { Command } from 'commander';
import { validateModelConfig } from '../ai/index.js';
import { runAuto, runAutoMultiRepo, runAutoMultiRepoParallel } from '../pipeline/auto.js';
import { runBabysit } from '../pipeline/babysit.js';
import { makeRunReviewLoopDispatch, previewDispatch } from '../pipeline/babysit-dispatch.js';
import { brainstorm, printBrainstormPreview } from '../pipeline/brainstorm.js';
import { fix } from '../pipeline/fix.js';
import { indexCodebase } from '../pipeline/index-codebase.js';
import { fixLoop } from '../pipeline/loop.js';
import { runMerge } from '../pipeline/merge.js';
import { exportPrompts } from '../pipeline/prompts.js';
import { gatherStatus, printStatusDashboard } from '../pipeline/status.js';
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
import { computeStats, formatHistoryTable, formatStatsTable, readHistory } from '../services/history.js';
import { initMetrics, shutdownMetrics } from '../services/metrics.js';
import { collectChangedFiles, reindexFiles } from '../services/reindex.js';
import { buildSandboxImage } from '../services/sandbox.js';
import {
  exitCodeForSignal,
  getShutdownSignal,
  installSignalHandlers,
  removeSignalHandlers,
  shutdownRequested,
} from '../services/shutdown.js';
import { createWebhookServer } from '../services/webhook-server.js';
import type { KovaConfig, RepoConfig } from '../types/index.js';
import { log, setLevel } from '../utils/logger.js';
import { registerOllamaProvidersFromConfig } from './ollama-wiring.js';

const program = new Command();

program
  .name('kova')
  .description('Autonomous code agent — brainstorm issues, fix them, ship PRs')
  .version('0.2.75')
  .option('--config <path>', 'Path to repos.yaml config file')
  .option('--router [url]', 'Route all LLM requests through claude-code-router proxy')
  .option('--verbose', 'Enable debug output')
  .hook('preAction', () => {
    const opts = program.opts();
    if (opts.verbose) {
      setLevel('debug');
    }
    if (opts.router) {
      process.env.ANTHROPIC_BASE_URL = typeof opts.router === 'string' ? opts.router : 'http://localhost:4141';
      log.info(`Router mode enabled: ${process.env.ANTHROPIC_BASE_URL}`);
    }
  });

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
  .option('--milestone <title>', 'Scope the issue set to a milestone (loop mode)')
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
        milestone?: string;
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
      initMetrics(config.metrics);
      registerOllamaProvidersFromConfig(config);

      if (opts.all) {
        // Loop mode: fix all open issues
        installSignalHandlers();
        log.info(`Starting fix loop for ${repoName}`);
        const result = await fixLoop({
          repoPath,
          repoName,
          config,
          filter: opts.filter,
          ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
          maxIssues: Number.parseInt(opts.max ?? '10', 10),
          budgetUsd: opts.budget ? Number.parseFloat(opts.budget) : undefined,
          force: opts.force,
        });
        shutdownMetrics();
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

      // Validate configured models and API keys before starting
      validateModelConfig(config);

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

      shutdownMetrics();
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
  .option('--milestone <title>', 'Scope the issue set to a milestone (forwarded to every repo)')
  .option('--max <n>', 'Maximum issues to fix per repo (overrides config)')
  .option('--force', 'Override skip — re-fix issues with existing branches/PRs')
  .option('--repo <name-or-path>', 'Single repository name or path (skip multi-repo)')
  .option('--parallel-repos', 'Process repos concurrently (default: sequential)')
  .option('--budget <usd>', 'Shared budget cap across all repos (USD)')
  .action(
    async (opts: {
      filter?: string;
      milestone?: string;
      max?: string;
      force?: boolean;
      repo?: string;
      parallelRepos?: boolean;
      budget?: string;
    }) => {
      const kovaConfig = await tryLoadConfig(program.opts().config);

      installSignalHandlers();

      // If --repo specified or no config, run single-repo mode
      if (opts.repo || !kovaConfig) {
        const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);
        initMetrics(config.metrics);
        registerOllamaProvidersFromConfig(config);
        const result = await runAuto({
          repoPath,
          repoName,
          config,
          filter: opts.filter,
          ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
          max: opts.max ? Number.parseInt(opts.max, 10) : undefined,
          force: opts.force,
        });
        shutdownMetrics();
        removeSignalHandlers();

        if (shutdownRequested()) {
          process.exit(exitCodeForSignal(getShutdownSignal()));
        }
        process.exit(result.exitCode);
      }

      // Multi-repo mode: init metrics from first repo with metrics enabled
      const firstRepoConfig = Object.values(kovaConfig.repos).find((r) => r.metrics?.enabled);
      initMetrics(firstRepoConfig?.metrics);

      // Register Ollama providers from every configured repo so the model
      // registry has every id available before any wave runs.
      for (const repoConfig of Object.values(kovaConfig.repos)) {
        registerOllamaProvidersFromConfig(repoConfig);
      }

      // Multi-repo mode: parallel or sequential
      if (opts.parallelRepos) {
        const result = await runAutoMultiRepoParallel({
          config: kovaConfig,
          filter: opts.filter,
          ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
          max: opts.max ? Number.parseInt(opts.max, 10) : undefined,
          force: opts.force,
          budgetUsd: opts.budget ? Number.parseFloat(opts.budget) : undefined,
        });
        shutdownMetrics();
        removeSignalHandlers();

        if (shutdownRequested()) {
          process.exit(exitCodeForSignal(getShutdownSignal()));
        }
        process.exit(result.exitCode);
      }

      // Sequential multi-repo mode (default)
      const result = await runAutoMultiRepo({
        config: kovaConfig,
        filter: opts.filter,
        ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
        max: opts.max ? Number.parseInt(opts.max, 10) : undefined,
        force: opts.force,
      });
      shutdownMetrics();
      removeSignalHandlers();

      if (shutdownRequested()) {
        process.exit(exitCodeForSignal(getShutdownSignal()));
      }
      process.exit(result.exitCode);
    },
  );

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
    registerOllamaProvidersFromConfig(config);
    const threshold = Number.parseFloat(opts.threshold ?? '0.7');
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      console.error('--threshold must be a number between 0.0 and 1.0');
      process.exit(1);
    }
    const focus = opts.focus ? opts.focus.split(',').map((s) => s.trim()) : undefined;

    log.info('Brainstorming issues...');
    const result = await brainstorm({ repoPath, config, threshold, focus, kovaConfig });
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
      initMetrics(config.metrics);
      registerOllamaProvidersFromConfig(config);

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
      shutdownMetrics();
      removeSignalHandlers();

      if (shutdownRequested()) {
        process.exit(exitCodeForSignal(getShutdownSignal()));
      }
      process.exit(success ? 0 : 1);
    },
  );

program
  .command('status')
  .description('Dashboard — open issues, pending PRs, spend across repos')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const configPath = resolveConfigPath(program.opts().config);
    const config = await loadConfig(configPath);

    log.info('Gathering status...');
    const result = await gatherStatus(config);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printStatusDashboard(result);
    }
  });

program
  .command('reindex')
  .description('Re-embed changed files in the vector DB')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .option('--base <branch>', 'Base branch for diff', 'main')
  .option('--full', 'Reindex all tracked files (not just changed)')
  .action(async (opts: { repo?: string; base?: string; full?: boolean }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);

    if (!config.vectordb?.enabled) {
      console.error(`Vector DB not enabled for ${repoName}. Set vectordb.enabled: true in repos.yaml`);
      process.exit(1);
    }

    let files: string[];
    if (opts.full) {
      log.info(`[reindex] Full reindex for ${repoName} — collecting all tracked files...`);
      const { $ } = await import('zx');
      $.verbose = false;
      const result = await $`git -C ${repoPath} ls-files`;
      files = result.stdout.trim().split('\n').filter(Boolean);
    } else {
      log.info(`[reindex] Incremental reindex for ${repoName} — diffing against ${opts.base}...`);
      files = await collectChangedFiles(repoPath, opts.base);
    }

    if (files.length === 0) {
      log.info('No files to reindex.');
      return;
    }

    log.info(`Reindexing ${files.length} files...`);
    const result = await reindexFiles(config.vectordb, repoPath, files);

    if (result.success) {
      log.info(`Reindex complete: ${result.filesSubmitted} files, ${result.apiCalls} API calls (${result.duration}ms)`);
    } else {
      log.error(`Reindex failed: ${result.error}`);
      process.exit(1);
    }
  });

program
  .command('index')
  .description('Index codebase into vectordb for semantic search')
  .option('--full', 'Full re-index (ignore incremental SHA tracking)')
  .option('--connection <url>', 'VectorDB connection URL')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .action(async (opts: { full?: boolean; connection?: string; repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, config } = resolveRepo(opts.repo ?? '.', kovaConfig);

    log.info('Indexing codebase...');
    const result = await indexCodebase({
      repoPath,
      full: opts.full ?? false,
      connectionUrl: opts.connection,
      vectordb: config.vectordb,
    });

    log.info(
      `Done: ${result.filesIndexed} file(s) indexed, ${result.chunksUpserted} chunk(s) upserted in ${result.duration}ms (${result.incremental ? 'incremental' : 'full'})`,
    );
  });

program
  .command('serve')
  .description('Start webhook listener for GitHub events')
  .option('--port <number>', 'Port to listen on', '3000')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .action(async (opts: { port?: string; repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);
    initMetrics(config.metrics);
    registerOllamaProvidersFromConfig(config);

    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error('GITHUB_WEBHOOK_SECRET environment variable is required');
      process.exit(1);
    }

    const port = Number.parseInt(opts.port ?? '3000', 10);

    // Build the fix queue + server
    const { createFixQueue } = await import('../services/fix-queue.js');
    const queue = createFixQueue(async (request) => {
      try {
        const issue = await fetchIssue(repoPath, request.issueNumber);
        const result = await fix({
          issue,
          repoPath,
          repoName,
          config,
        });
        if (result.success) {
          log.info(`Webhook fix complete: PR ${result.prUrl}`);
        } else {
          log.error(`Webhook fix failed for #${request.issueNumber}: ${result.error}`);
        }
      } finally {
        pendingIssues.delete(request.issueNumber);
      }
    });

    // Deduplicate: track pending issue numbers
    const pendingIssues = new Set<number>();
    const enqueue = (issueNumber: number): boolean => {
      if (pendingIssues.has(issueNumber)) return false;
      pendingIssues.add(issueNumber);
      queue.enqueue({
        issueNumber,
        repoPath,
        repoName,
      });
      return true;
    };

    const server = createWebhookServer({
      secret,
      port,
      enqueue,
      queue,
    });

    installSignalHandlers();

    await server.start();
    log.info(`Webhook server started on port ${server.port} for ${repoName}`);

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (shutdownRequested()) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    log.info('Shutting down — draining queue...');
    queue.shutdown();
    await queue.drain();
    await server.stop();
    shutdownMetrics();
    removeSignalHandlers();

    log.info('Webhook server stopped.');
    process.exit(exitCodeForSignal(getShutdownSignal()));
  });

program
  .command('merge')
  .description('Merge kova PRs in dependency order')
  .option('--pr <number>', 'Merge a specific PR')
  .option('--dry-run', 'Preview merge order without merging')
  .option('--ci <policy>', 'CI check policy: require or warn (overrides config)')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .action(async (opts: { pr?: string; dryRun?: boolean; ci?: string; repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const prNumber = opts.pr ? Number.parseInt(opts.pr, 10) : undefined;
    if (opts.pr && (prNumber === undefined || Number.isNaN(prNumber))) {
      console.error(`Invalid PR number: ${opts.pr}`);
      process.exit(1);
    }

    const ciOverride = opts.ci === 'require' || opts.ci === 'warn' ? opts.ci : undefined;
    if (opts.ci && !ciOverride) {
      console.error(`Invalid CI policy: ${opts.ci}. Must be 'require' or 'warn'.`);
      process.exit(1);
    }

    log.info(`Merging PRs for ${repoName}${opts.dryRun ? ' (dry run)' : ''}`);

    const result = await runMerge({
      repoPath,
      repoName,
      config,
      prNumber,
      dryRun: opts.dryRun,
      ciOverride,
    });

    if (result.merged.length > 0) {
      log.info(`Merged: ${result.merged.map((n) => `#${n}`).join(', ')}`);
    }
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        log.error(`Failed #${f.number}: ${f.reason}`);
      }
    }
    if (result.merged.length === 0 && result.failed.length === 0) {
      log.info('No kova PRs to merge.');
    }

    process.exit(result.failed.length > 0 ? 1 : 0);
  });

program
  .command('babysit')
  .description('Act on human review comments on open kova PRs — fix, push, reply')
  .option('--pr <number>', 'Process a single PR instead of every open kova PR')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .option('--preview', 'Do not dispatch real edits — log threads only')
  .option('--max-iterations <n>', 'Max edit-dispatch attempts per PR', '2')
  .action(async (opts: { pr?: string; repo?: string; preview?: boolean; maxIterations?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);
    initMetrics(config.metrics);
    registerOllamaProvidersFromConfig(config);

    const prNumber = opts.pr ? Number.parseInt(opts.pr, 10) : undefined;
    if (opts.pr && (prNumber === undefined || Number.isNaN(prNumber))) {
      console.error(`Invalid PR number: ${opts.pr}`);
      process.exit(1);
    }

    const maxIterations = Number.parseInt(opts.maxIterations ?? '2', 10);

    const dispatchEdits = opts.preview
      ? previewDispatch
      : makeRunReviewLoopDispatch({ config, worktreePath: repoPath });

    log.info(`Babysitting kova PRs in ${repoName}${opts.preview ? ' (preview)' : ''}`);
    const result = await runBabysit({
      repoPath,
      repoName,
      config,
      dispatchEdits,
      ...(prNumber !== undefined && { prNumber }),
      maxIterations,
    });

    log.info(
      `Done — ${result.prsProcessed} PR(s) processed, ${result.totalResolved} thread(s) resolved, ${result.totalNonActionable} non-actionable, ${result.totalErrors} error(s)`,
    );
    for (const pr of result.perPR) {
      if (
        pr.result.threadsResolved.length === 0 &&
        pr.result.nonActionable.length === 0 &&
        pr.result.errors.length === 0
      ) {
        continue;
      }
      log.info(
        `  PR #${pr.prNumber}: resolved=${pr.result.threadsResolved.length} nonActionable=${pr.result.nonActionable.length} errors=${pr.result.errors.length}`,
      );
    }
    for (const err of result.errors) {
      log.error(`  PR #${err.prNumber}: ${err.message}`);
    }

    shutdownMetrics();
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

const sandbox = program.command('sandbox').description('Manage sandbox Docker images');

sandbox
  .command('build')
  .description('Build the sandbox Docker image for a repository')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .action(async (opts: { repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoName, config } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const result = await buildSandboxImage({
      repoName,
      config: config.sandbox,
    });

    if (result.success) {
      log.info(`Sandbox image ready: ${result.tag} (${result.duration}ms)`);
    } else {
      log.error(`Sandbox build failed: ${result.error}`);
      process.exit(1);
    }
  });

program
  .command('history')
  .description('Show run history and analytics')
  .option('--stats', 'Show aggregate statistics')
  .option('--repo <name-or-path>', 'Filter by repository name or path', '.')
  .option('--limit <n>', 'Maximum entries to show', '20')
  .action(async (opts: { stats?: boolean; repo?: string; limit?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);
    const limit = Number.parseInt(opts.limit ?? '20', 10);

    const entries = await readHistory(repoPath);

    if (opts.stats) {
      const stats = computeStats(entries);
      // Pass entries so structured-output metrics (issue #247) can be aggregated
      // and rendered alongside the standard stats.
      console.log(formatStatsTable(stats, entries));
    } else {
      const recent = entries.slice(-limit);
      console.log(formatHistoryTable(recent));
    }
  });

program
  .command('reflect')
  .description('Cross-run telemetry analysis — surface patterns, stalls, gate failures, A/B leaders')
  .option('--repo <name-or-path>', 'Repository name (from config) or path', '.')
  .option('--since <duration>', 'Only include runs newer than N (e.g. 7d, 24h, 2w, or ISO date)')
  .option('--json', 'Emit a single JSON object instead of a text report')
  .action(async (opts: { repo?: string; since?: string; json?: boolean }) => {
    const { analyzeReflect, formatReflectReport, parseSinceFlag } = await import('../services/reflect.js');

    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const since = parseSinceFlag(opts.since);
    if (opts.since && !since) {
      log.error(`Invalid --since value: ${opts.since} (expected Nd / Nh / Nw or ISO date)`);
      process.exit(1);
    }

    const entries = await readHistory(repoPath);
    const report = analyzeReflect(entries, since ? { since } : undefined);

    if (opts.json) {
      console.log(JSON.stringify(report));
    } else {
      console.log(formatReflectReport(report, { path: repoPath }));
    }
  });

const prompts = program.command('prompts').description('Manage wave prompts');

prompts
  .command('export')
  .description('Export default prompts to a directory for customization')
  .option('--output <dir>', 'Output directory', './kova-prompts/')
  .option('--force', 'Overwrite existing files')
  .action(async (opts: { output?: string; force?: boolean }) => {
    const outputDir = resolve(opts.output ?? './kova-prompts/');

    log.info(`Exporting prompts to ${outputDir}...`);
    const result = await exportPrompts(outputDir, opts.force);

    if (result.exported.length > 0) {
      log.info(`Exported: ${result.exported.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      log.info(`Skipped (already exist): ${result.skipped.join(', ')}`);
    }
    log.info(`\nTo extend a default prompt, use {{DEFAULT_PROMPT}} in your custom file.`);
    log.info('Then set prompts_dir in repos.yaml to point to your custom prompts directory.');
  });

prompts
  .command('list')
  .description('List recorded prompt versions')
  .option('--wave <name>', 'Filter by wave name')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .action(async (opts: { wave?: string; repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const { getVersionHistory } = await import('../services/prompt-versions.js');
    const { formatPromptHistory } = await import('../services/prompt-versions-display.js');
    const versions = await getVersionHistory(repoPath, opts.wave);
    console.log(formatPromptHistory(versions));
  });

prompts
  .command('diff <hash1> <hash2>')
  .description('Compare two prompt versions')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .action(async (hash1: string, hash2: string, opts: { repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const { diffVersions } = await import('../services/prompt-versions.js');
    const diff = await diffVersions(repoPath, hash1, hash2);

    if (diff === null) {
      console.error('One or both prompt versions not found.');
      process.exit(1);
    }

    if (diff === '') {
      console.log('Prompt versions are identical.');
    } else {
      console.log(diff);
    }
  });

prompts
  .command('correlate')
  .description('Correlate prompt versions with success rates')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .action(async (opts: { repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const { readHistory } = await import('../services/history.js');
    const { correlateByPromptVersion } = await import('../services/prompt-correlation.js');
    const { formatPromptCorrelation } = await import('../services/prompt-versions-display.js');

    const entries = await readHistory(repoPath);
    const stats = correlateByPromptVersion(entries);
    console.log(formatPromptCorrelation(stats));
  });

prompts
  .command('stats')
  .description('Show A/B test variant success rates')
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .action(async (opts: { repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const { readHistory } = await import('../services/history.js');
    const { correlateByABTestVariant } = await import('../services/prompt-correlation.js');
    const { formatABTestStats } = await import('../services/prompt-versions-display.js');

    const entries = await readHistory(repoPath);
    const stats = correlateByABTestVariant(entries);
    console.log(formatABTestStats(stats));
  });

// Issue #278: retrieval-quality eval harness.
// `kova eval context` compares context-on vs context-off runs and reports the
// tool-call / Read / first-pass-pass-rate deltas, gated by AB_TEST_MIN_RUNS.
const evalCmd = program.command('eval').description('Run kova eval harnesses');

evalCmd
  .command('context')
  .description("Retrieval-quality eval: does injected context reduce the agent's own tool calls?")
  .option('--repo <name-or-path>', 'Repository name or path', '.')
  .action(async (opts: { repo?: string }) => {
    const kovaConfig = await tryLoadConfig(program.opts().config);
    const { repoPath, repoName } = resolveRepo(opts.repo ?? '.', kovaConfig);

    const { readHistory } = await import('../services/history.js');
    const { computeContextArmDelta, formatContextArmDelta, groupEntriesByContextArm } = await import(
      '../services/eval-context-arm.js'
    );

    const entries = await readHistory(repoPath, { repo: repoName });
    const grouped = groupEntriesByContextArm(entries);
    const delta = computeContextArmDelta(grouped.on, grouped.off);
    console.log(formatContextArmDelta(delta));
  });

program.parse();
