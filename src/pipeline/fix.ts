// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship
// Each wave runs Agent SDK query() with wave-specific prompts and structured output.
// Waves are strictly sequential. Quality gates run inside the agent (self-healing).

import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeWaveWithRetry, type WaveExecutionResult } from '../ai/index.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '../services/checkpoint.js';
import { commentOnIssue, createPR, listOpenPRs } from '../services/github.js';
import {
  commitAndPush,
  createWorktree,
  worktreePath as getWorktreePath,
  removeWorktree,
  worktreeExists,
} from '../services/worktree.js';
import type { FixState, Issue, RepoConfig, WaveName, WaveResult } from '../types/index.js';
import { type AssessResult, AssessResultSchema, ReviewResultSchema, SpecResultSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { loadPrompt } from './prompts.js';

function toOutputFormat(schema: z.ZodType): JsonSchemaOutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>,
  };
}

export interface FixOptions {
  issue: Issue;
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  fresh?: boolean | undefined;
  noComment?: boolean | undefined;
}

export interface FixResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  state: FixState;
}

export async function fix(options: FixOptions): Promise<FixResult> {
  const { issue, repoPath, repoName, config, fresh, noComment } = options;

  // 1. Handle --fresh: clear existing checkpoint and worktree before starting
  if (fresh) {
    if (config.isolation === 'worktree' && (await worktreeExists(repoPath, issue.number))) {
      await removeWorktree(repoPath, getWorktreePath(repoPath, issue.number));
      log.info(`[fresh] Removed existing worktree for #${issue.number}`);
    }
  }

  // 2. Create worktree for isolation
  const worktree = config.isolation === 'worktree' ? await createWorktree(repoPath, issue.number) : undefined;
  const workDir = worktree?.path ?? repoPath;

  // Clear checkpoint after workDir is resolved (for non-worktree isolation too)
  if (fresh) {
    await clearCheckpoint(workDir);
    log.info(`[fresh] Cleared checkpoint — starting from scratch`);
  }

  // 3. Load or create state
  const existing = await loadCheckpoint(workDir);
  let state: FixState;

  if (existing && existing.completedWaves.length > 0) {
    state = existing;
    log.info(`Resuming #${issue.number} — completed waves: [${state.completedWaves.join(', ')}]`);
  } else {
    state = createInitialState(issue, repoName, repoPath, worktree?.path);
  }

  const shouldSkip = (wave: WaveName): boolean => state.completedWaves.includes(wave);

  try {
    // === ASSESS ===
    if (!shouldSkip('assess')) {
      const result = await runWave('assess', workDir, config, {
        userMessage: formatIssueContext(issue),
        outputFormat: toOutputFormat(AssessResultSchema),
      });

      state.waveResults.assess = toWaveResult('assess', result);
      state.completedWaves.push('assess');
      await saveCheckpoint(workDir, state);

      // Check if we should proceed
      const assess = result.structuredOutput as AssessResult | undefined;
      if (assess && !assess.should_proceed) {
        log.warn(`[assess] Grade ${assess.grade} — not proceeding: ${assess.reasoning}`);

        if (!noComment) {
          const comment = formatSkipComment(assess);
          await commentOnIssue(repoPath, issue.number, comment);
        }

        state.status = 'completed';
        return { success: false, error: `Issue graded ${assess.grade}, skipped`, state };
      }
    }

    // === SPEC ===
    if (!shouldSkip('spec')) {
      const assessResult = state.waveResults.assess;
      const result = await runWave('spec', workDir, config, {
        userMessage: `Issue: ${issue.title}\n${issue.body}\n\nAssessment:\n${JSON.stringify(assessResult?.artifact, null, 2)}`,
        outputFormat: toOutputFormat(SpecResultSchema),
      });

      state.waveResults.spec = toWaveResult('spec', result);
      state.completedWaves.push('spec');
      await saveCheckpoint(workDir, state);
    }

    // === TEST ===
    if (!shouldSkip('test')) {
      const specResult = state.waveResults.spec;
      const result = await runWave('test', workDir, config, {
        userMessage: `Write failing tests for this spec:\n${JSON.stringify(specResult?.artifact, null, 2)}`,
      });

      state.waveResults.test = toWaveResult('test', result);
      state.completedWaves.push('test');
      await saveCheckpoint(workDir, state);
    }

    // === IMPL ===
    if (!shouldSkip('impl')) {
      const specResult = state.waveResults.spec;
      const result = await runWave('impl', workDir, config, {
        userMessage: `Implement to pass the failing tests. Spec:\n${JSON.stringify(specResult?.artifact, null, 2)}`,
      });

      state.waveResults.impl = toWaveResult('impl', result);
      state.completedWaves.push('impl');
      await saveCheckpoint(workDir, state);
    }

    // === QUALITY ===
    if (!shouldSkip('quality')) {
      const result = await runWave('quality', workDir, config, {
        userMessage: `Run all quality gates: lint, typecheck, tests, coverage (threshold: ${config.rules.coverage}%). Fix any failures.`,
      });

      state.waveResults.quality = toWaveResult('quality', result);
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);
    }

    // === REVIEW ===
    if (!shouldSkip('review')) {
      const result = await runWave('review', workDir, config, {
        userMessage: `Review the changes for this issue. Spec:\n${JSON.stringify(state.waveResults.spec?.artifact, null, 2)}`,
        outputFormat: toOutputFormat(ReviewResultSchema),
      });

      state.waveResults.review = toWaveResult('review', result);
      state.completedWaves.push('review');
      await saveCheckpoint(workDir, state);

      // Review loop: if needs fixes, re-run impl + quality (max 1 iteration)
      const review = result.structuredOutput as { verdict: string } | undefined;
      if (review?.verdict === 'needs_fixes' && !shouldSkip('impl')) {
        log.info('[review] Findings detected — re-running impl + quality');
        // Re-run impl with review feedback
        const reimpl = await runWave('impl', workDir, config, {
          userMessage: `Fix review findings:\n${JSON.stringify(result.structuredOutput, null, 2)}`,
        });
        state.waveResults.impl = toWaveResult('impl', reimpl);

        // Re-run quality
        const requality = await runWave('quality', workDir, config, {
          userMessage: `Run all quality gates after review fixes. Coverage threshold: ${config.rules.coverage}%.`,
        });
        state.waveResults.quality = toWaveResult('quality', requality);
      }
    }

    // === SHIP ===
    if (!shouldSkip('ship')) {
      const branch = worktree?.branch ?? `kova/fix-${issue.number}`;

      // Stage, commit, and push changes
      const commitResult = await commitAndPush(workDir, branch, issue);
      if (!commitResult.committed) {
        log.warn(`[ship] No changes to commit for #${issue.number} — skipping PR`);
        state.waveResults.ship = {
          wave: 'ship',
          success: true,
          artifact: { noChanges: true },
          duration: 0,
          cost: 0,
        };
        state.completedWaves.push('ship');
        state.status = 'completed';
        await saveCheckpoint(workDir, state);
        return { success: true, state };
      }

      // Create PR after push succeeds
      const openPRs = await listOpenPRs(repoPath);
      const prTitle = `fix: ${issue.title} (#${issue.number})`;
      const prBody = [
        `## Summary`,
        `Fixes #${issue.number}`,
        ``,
        `## Context`,
        `${issue.title}`,
        ``,
        `## Open PRs (for merge ordering)`,
        ...openPRs.map((pr) => `- ${pr}`),
      ].join('\n');

      const prUrl = await createPR(workDir, branch, prTitle, prBody);

      state.waveResults.ship = {
        wave: 'ship',
        success: true,
        artifact: { prUrl, commitMessage: commitResult.commitMessage, filesStaged: commitResult.filesStaged },
        duration: 0,
        cost: 0,
      };
      state.completedWaves.push('ship');
      state.status = 'completed';
      await saveCheckpoint(workDir, state);

      log.info(`Fix complete: ${prUrl}`);
      return { success: true, prUrl, state };
    }

    state.status = 'completed';
    return { success: true, state };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Fix failed for #${issue.number}: ${msg}`);
    state.status = 'failed';
    state.error = msg;
    await saveCheckpoint(workDir, state);
    return { success: false, error: msg, state };
  } finally {
    // Cleanup worktree on success (keep on failure for debugging)
    if (worktree && state.status === 'completed') {
      await removeWorktree(repoPath, worktree.path);
    }
  }
}

async function runWave(
  wave: WaveName,
  workDir: string,
  config: RepoConfig,
  opts: { userMessage: string; outputFormat?: JsonSchemaOutputFormat },
): Promise<WaveExecutionResult> {
  const systemPrompt = await loadPrompt(wave);

  return executeWaveWithRetry({
    wave,
    systemPrompt,
    userMessage: opts.userMessage,
    cwd: workDir,
    modelTier: wave === 'ship' ? 'small' : config.model[wave],
    ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
  });
}

function toWaveResult(wave: WaveName, result: WaveExecutionResult): WaveResult {
  return {
    wave,
    success: result.success,
    artifact: result.structuredOutput ?? result.result,
    duration: result.duration,
    cost: result.cost,
    model: result.model,
  };
}

function createInitialState(issue: Issue, repo: string, repoPath: string, worktree?: string): FixState {
  return {
    issue,
    repo,
    repoPath,
    worktree,
    startedAt: new Date().toISOString(),
    completedWaves: [],
    waveResults: {},
    status: 'running',
  };
}

function formatIssueContext(issue: Issue): string {
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body,
    ``,
    `Labels: ${issue.labels.join(', ') || 'none'}`,
  ].join('\n');
}

function formatSkipComment(assess: AssessResult): string {
  const files = assess.surface_area.files.length > 0 ? assess.surface_area.files.join(', ') : 'N/A';
  const recommendation =
    assess.grade === 'F'
      ? 'Break this issue into smaller, independently fixable pieces.'
      : 'Consider rescoping this issue to reduce surface area.';

  return [
    '## Kova Assessment — Skipped',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Grade** | ${assess.grade} |`,
    `| **Risk** | ${assess.risk} |`,
    `| **Estimated lines** | ${assess.surface_area.estimated_lines} |`,
    `| **Files** | ${files} |`,
    `| **Modules** | ${assess.surface_area.modules_affected.join(', ') || 'N/A'} |`,
    '',
    '### Reasoning',
    assess.reasoning,
    '',
    '### Recommendation',
    recommendation,
  ].join('\n');
}
