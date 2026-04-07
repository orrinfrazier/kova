// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship
// Each wave runs pi-mono agent sessions with wave-specific prompts and structured output.
// Waves are strictly sequential. Quality gates run inside the agent (self-healing).

import { z } from 'zod';
import { executeWaveWithRetry, type OutputFormat, type WaveExecutionResult } from '../ai/index.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '../services/checkpoint.js';
import { commentOnIssue, createPR, listOpenPRs } from '../services/github.js';
import { formatPRContext, type OpenPR } from '../services/pr-context.js';
import { shutdownRequested } from '../services/shutdown.js';
import {
  commitAndPush,
  createWorktree,
  worktreePath as getWorktreePath,
  removeWorktree,
  worktreeExists,
} from '../services/worktree.js';
import type {
  FailedPiece,
  FixState,
  ImplDiagnosis,
  ImplResult,
  Issue,
  RepoConfig,
  WaveName,
  WaveResult,
} from '../types/index.js';
import {
  type AssessResult,
  AssessResultSchema,
  ImplResultSchema,
  ReviewResultSchema,
  SpecResultSchema,
} from '../types/index.js';
import { log } from '../utils/logger.js';
import { buildWaveContext } from './context.js';
import { buildCostReport, printRunSummary, writeCostReport } from './cost-report.js';
import { loadPrompt } from './prompts.js';

function toOutputFormat(schema: z.ZodType): OutputFormat {
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
  pendingPRs?: OpenPR[] | undefined;
}

export interface FixResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  state: FixState;
}

export async function fix(options: FixOptions): Promise<FixResult> {
  const { issue, repoPath, repoName, config, fresh, noComment, pendingPRs } = options;

  if (fresh) {
    if (config.isolation === 'worktree' && (await worktreeExists(repoPath, issue.number))) {
      await removeWorktree(repoPath, getWorktreePath(repoPath, issue.number));
      log.info(`[fresh] Removed existing worktree for #${issue.number}`);
    }
  }

  const worktree = config.isolation === 'worktree' ? await createWorktree(repoPath, issue.number) : undefined;
  const workDir = worktree?.path ?? repoPath;

  if (fresh) {
    await clearCheckpoint(workDir);
    log.info(`[fresh] Cleared checkpoint — starting from scratch`);
  }

  const existing = await loadCheckpoint(workDir);
  let state: FixState;

  if (existing && existing.completedWaves.length > 0) {
    state = existing;
    log.info(`Resuming #${issue.number} — completed waves: [${state.completedWaves.join(', ')}]`);
  } else {
    state = createInitialState(issue, repoName, repoPath, worktree?.path);
  }

  const shouldSkip = (wave: WaveName): boolean => state.completedWaves.includes(wave);
  const prContext = formatPRContext(pendingPRs ?? []);

  const interruptIfShutdown = async (): Promise<FixResult | undefined> => {
    if (!shutdownRequested()) return undefined;
    log.info(`[shutdown] Interrupted after wave [${state.completedWaves.at(-1) ?? 'none'}] for #${issue.number}`);
    state.status = 'interrupted';
    await saveCheckpoint(workDir, state);
    return { success: false, error: 'Interrupted by signal', state };
  };

  try {
    if (!shouldSkip('assess')) {
      const result = await runWave('assess', workDir, config, {
        userMessage: formatIssueContext(issue),
        outputFormat: toOutputFormat(AssessResultSchema),
      });
      state.waveResults.assess = toWaveResult('assess', result);
      state.completedWaves.push('assess');
      await saveCheckpoint(workDir, state);

      const assess = result.structuredOutput as AssessResult | undefined;
      if (assess && !assess.should_proceed) {
        log.warn(`[assess] Grade ${assess.grade} — not proceeding: ${assess.reasoning}`);
        if (!noComment) {
          const comment = formatSkipComment(assess, issue);
          await commentOnIssue(repoPath, issue.number, comment);
        }
        state.status = 'completed';
        return { success: false, error: `Issue graded ${assess.grade}, skipped`, state };
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('spec')) {
      const result = await runWave('spec', workDir, config, {
        userMessage: buildWaveContext('spec', issue, state.waveResults, { prContext }),
        outputFormat: toOutputFormat(SpecResultSchema),
      });
      state.waveResults.spec = toWaveResult('spec', result);
      state.completedWaves.push('spec');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('test')) {
      const result = await runWave('test', workDir, config, {
        userMessage: buildWaveContext('test', issue, state.waveResults),
      });
      state.waveResults.test = toWaveResult('test', result);
      state.completedWaves.push('test');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('impl')) {
      await runImplWithEscalation(workDir, config, issue, state, prContext);
      state.completedWaves.push('impl');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('quality')) {
      const result = await runWave('quality', workDir, config, {
        userMessage: buildWaveContext('quality', issue, state.waveResults, {
          coverageThreshold: config.rules.coverage,
        }),
      });
      state.waveResults.quality = toWaveResult('quality', result);
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('review')) {
      const result = await runWave('review', workDir, config, {
        userMessage: buildWaveContext('review', issue, state.waveResults),
        outputFormat: toOutputFormat(ReviewResultSchema),
      });
      state.waveResults.review = toWaveResult('review', result);
      state.completedWaves.push('review');
      await saveCheckpoint(workDir, state);

      const review = result.structuredOutput as { verdict: string } | undefined;
      if (review?.verdict === 'needs_fixes') {
        log.info('[review] Findings detected — re-running impl + quality');
        state.waveResults.review = toWaveResult('review', result);
        const reimpl = await runWave('impl', workDir, config, {
          userMessage: buildWaveContext('impl', issue, state.waveResults, { isReimpl: true, prContext }),
        });
        state.waveResults.impl = toWaveResult('impl', reimpl);
        const requality = await runWave('quality', workDir, config, {
          userMessage: buildWaveContext('quality', issue, state.waveResults, {
            coverageThreshold: config.rules.coverage,
          }),
        });
        state.waveResults.quality = toWaveResult('quality', requality);
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    if (!shouldSkip('ship')) {
      const branch = worktree?.branch ?? `kova/fix-${issue.number}`;
      const commitResult = await commitAndPush(workDir, branch, issue);
      if (!commitResult.committed) {
        log.warn(`[ship] No changes to commit for #${issue.number} — skipping PR`);
        state.waveResults.ship = {
          wave: 'ship',
          success: true,
          artifact: { noChanges: true },
          duration: 0,
          cost: 0,
          turns: 0,
        };
        state.completedWaves.push('ship');
        state.status = 'completed';
        await saveCheckpoint(workDir, state);
        return { success: true, state };
      }

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
        turns: 0,
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
    const costReport = buildCostReport(state);
    printRunSummary(costReport);
    await writeCostReport(workDir, costReport).catch((err) => {
      log.warn(`Failed to write cost report: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (worktree && state.status === 'completed') {
      await removeWorktree(repoPath, worktree.path);
    }
  }
}

const MAX_IMPL_RETRIES = 3;

async function runImplWithEscalation(
  workDir: string,
  config: RepoConfig,
  issue: Issue,
  state: FixState,
  prContext: string,
): Promise<void> {
  let lastDiagnosis: ImplDiagnosis | undefined;

  for (let attempt = 1; attempt <= MAX_IMPL_RETRIES; attempt++) {
    const result = await runWave('impl', workDir, config, {
      userMessage: buildWaveContext('impl', issue, state.waveResults, { prContext }),
      outputFormat: toOutputFormat(ImplResultSchema),
    });
    state.waveResults.impl = toWaveResult('impl', result);

    const implResult = result.structuredOutput as ImplResult | undefined;

    if (implResult?.tests_passing) {
      return;
    }

    lastDiagnosis = implResult?.diagnosis;

    if (attempt < MAX_IMPL_RETRIES) {
      log.warn(`[impl] Attempt ${attempt}/${MAX_IMPL_RETRIES} — tests failing, retrying...`);
    }
  }

  // All retries exhausted — escalate based on diagnosis
  log.warn('[impl] All retries exhausted — escalating');
  await handleEscalation(lastDiagnosis, workDir, config, issue, state, prContext);
}

async function handleEscalation(
  diagnosis: ImplDiagnosis | undefined,
  workDir: string,
  config: RepoConfig,
  issue: Issue,
  state: FixState,
  prContext: string,
): Promise<void> {
  const category = diagnosis?.category ?? 'STUCK';

  if (category === 'SPEC_WRONG') {
    log.info('[escalation] SPEC_WRONG — re-running spec then T→I');
    const specResult = await runWave('spec', workDir, config, {
      userMessage: buildWaveContext('spec', issue, state.waveResults, { prContext }),
      outputFormat: toOutputFormat(SpecResultSchema),
    });
    state.waveResults.spec = toWaveResult('spec', specResult);

    const testResult = await runWave('test', workDir, config, {
      userMessage: buildWaveContext('test', issue, state.waveResults),
    });
    state.waveResults.test = toWaveResult('test', testResult);

    const implResult = await runWave('impl', workDir, config, {
      userMessage: buildWaveContext('impl', issue, state.waveResults, { prContext }),
      outputFormat: toOutputFormat(ImplResultSchema),
    });
    state.waveResults.impl = toWaveResult('impl', implResult);

    const impl = implResult.structuredOutput as ImplResult | undefined;
    if (!impl?.tests_passing) {
      trackFailedPiece(state, diagnosis);
    }
    return;
  }

  if (category === 'APPROACH_WRONG') {
    log.info('[escalation] APPROACH_WRONG — re-running impl with approach hint');
    const hint = `Previous approach failed. Diagnosis: ${diagnosis?.theory ?? 'unknown'}. Try a fundamentally different algorithm, pattern, or architecture.`;
    const result = await runWave('impl', workDir, config, {
      userMessage: buildWaveContext('impl', issue, state.waveResults, { prContext, escalationHint: hint }),
      outputFormat: toOutputFormat(ImplResultSchema),
    });
    state.waveResults.impl = toWaveResult('impl', result);

    const impl = result.structuredOutput as ImplResult | undefined;
    if (!impl?.tests_passing) {
      trackFailedPiece(state, diagnosis);
    }
    return;
  }

  if (category === 'MISSING_CONTEXT') {
    log.info('[escalation] MISSING_CONTEXT — re-running impl with additional context');
    const hint = `Missing context detected: ${diagnosis?.theory ?? 'unknown'}. Read additional source files, dependencies, and type definitions before implementing.`;
    const result = await runWave('impl', workDir, config, {
      userMessage: buildWaveContext('impl', issue, state.waveResults, { prContext, escalationHint: hint }),
      outputFormat: toOutputFormat(ImplResultSchema),
    });
    state.waveResults.impl = toWaveResult('impl', result);

    const impl = result.structuredOutput as ImplResult | undefined;
    if (!impl?.tests_passing) {
      trackFailedPiece(state, diagnosis);
    }
    return;
  }

  // STUCK or unknown — mark failed, continue
  log.info('[escalation] STUCK — marking piece as failed');
  trackFailedPiece(state, diagnosis);
}

function trackFailedPiece(state: FixState, diagnosis: ImplDiagnosis | undefined): void {
  const piece: FailedPiece = {
    pieceName: 'impl',
    diagnosis: {
      category: diagnosis?.category ?? 'STUCK',
      theory: diagnosis?.theory ?? 'No diagnosis provided',
      tests_still_failing: diagnosis?.tests_still_failing ?? [],
    },
  };
  state.failedPieces = [...(state.failedPieces ?? []), piece];
}

async function runWave(
  wave: WaveName,
  workDir: string,
  config: RepoConfig,
  opts: { userMessage: string; outputFormat?: OutputFormat },
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
    turns: result.turns,
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

function formatSkipComment(assess: AssessResult, _issue: Issue): string {
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
