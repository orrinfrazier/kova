// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship
// Uses spawnWaveAgent() for standalone waves, runTILoop() for test+impl,
// and runReviewLoop() for review. Handoffs persist after every wave.

import { z } from 'zod';
import {
  type FixAIWaveName,
  getApiFallbackModelString,
  getWaveTools,
  isLocalModel,
  type OutputFormat,
  resolveThinkingLevel,
  resolveWaveModel,
  spawnWaveAgentWithFallback,
} from '../ai/index.js';
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
  Issue,
  RepoConfig,
  SpecResult,
  WaveHandoff,
  WaveModelConfig,
  WaveName,
  WaveResult,
} from '../types/index.js';
import {
  type AssessResult,
  AssessResultSchema,
  loadAllHandoffs,
  SpecResultSchema,
  saveHandoff,
} from '../types/index.js';
import { log } from '../utils/logger.js';
import { buildWaveContext } from './context.js';
import { buildCostReport, printRunSummary, writeCostReport } from './cost-report.js';
import { runParallelPieceTILoop, runReviewLoop, type TestRunner } from './loops.js';
import { loadPrompt } from './prompts.js';
import { validatePieceFileOwnership } from './spec-validator.js';

function toOutputFormat(schema: z.ZodType): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: schema,
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
  testRunner?: TestRunner | undefined;
}

export interface FixResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  state: FixState;
}

// --- Helpers ---

/** Extract provider name from a wave's model config. */
function waveProvider(config: RepoConfig, wave: FixAIWaveName): string {
  const waveModel = config.model[wave];
  if (typeof waveModel !== 'string') return waveModel.provider;
  return resolveWaveModel(waveModel).provider;
}

/** Determine the API fallback model string for a wave config, if applicable. */
function waveFallbackModel(waveConfig: WaveModelConfig, modelString: string): string | undefined {
  if (!isLocalModel(modelString)) return undefined;
  // If the wave config is a tier string, use that tier for the fallback
  if (typeof waveConfig === 'string') return getApiFallbackModelString(waveConfig);
  // Object override with a local provider — fall back to medium tier
  return getApiFallbackModelString('medium');
}

/** Spawn a wave agent with automatic local-to-API fallback. */
async function spawnWave<T>(
  wave: FixAIWaveName,
  workDir: string,
  config: RepoConfig,
  userMessage: string,
  outputFormat?: OutputFormat,
): Promise<WaveHandoff<T>> {
  const model = resolveWaveModel(config.model[wave]);
  const tools = getWaveTools(wave, workDir);
  const systemPrompt = await loadPrompt(wave);
  const thinkingLevel = resolveThinkingLevel(config, wave);
  const modelString = model.id;
  const fallbackModel = waveFallbackModel(config.model[wave], modelString);
  return spawnWaveAgentWithFallback<T>({
    wave,
    model: modelString,
    tools,
    systemPrompt,
    handoffContext: '',
    userMessage,
    cwd: workDir,
    thinkingLevel,
    fallbackModel,
    ...(outputFormat != null && { outputFormat }),
  });
}

/** Convert a WaveHandoff to WaveResult for checkpoint/cost-report compatibility. */
function handoffToResult(handoff: WaveHandoff, provider?: string): WaveResult {
  return {
    wave: handoff.wave,
    success: true,
    artifact: handoff.artifact,
    duration: 0,
    cost: handoff.cost,
    turns: handoff.turns,
    model: handoff.model,
    provider,
    fallback_used: handoff.fallback_used || undefined,
    local_attempt_cost: handoff.local_attempt_cost,
  };
}

/** Convert a WaveResult to WaveHandoff for persistence. */
function waveResultToHandoff(result: WaveResult): WaveHandoff {
  return {
    wave: result.wave,
    timestamp: new Date().toISOString(),
    model: result.model ?? 'unknown',
    cost: result.cost,
    turns: result.turns,
    confidence: 'medium',
    artifact: result.artifact,
    approach_notes: '',
  };
}

// --- Main ---

export async function fix(options: FixOptions): Promise<FixResult> {
  const { issue, repoPath, repoName, config, fresh, noComment, pendingPRs, testRunner } = options;

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
    // Restore waveResults from handoff files for any missing entries
    const handoffs = await loadAllHandoffs(workDir);
    for (const handoff of handoffs) {
      if (!state.waveResults[handoff.wave]) {
        state.waveResults[handoff.wave] = handoffToResult(handoff);
      }
    }
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
    // WAVE A: Assess
    if (!shouldSkip('assess')) {
      const handoff = await spawnWave<AssessResult>(
        'assess',
        workDir,
        config,
        formatIssueContext(issue),
        toOutputFormat(AssessResultSchema),
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.assess = handoffToResult(handoff, waveProvider(config, 'assess'));
      state.completedWaves.push('assess');
      await saveCheckpoint(workDir, state);

      // Gate: only check when structured output parsed successfully
      if (handoff.confidence === 'high') {
        const assess = handoff.artifact;
        if (!assess.should_proceed) {
          log.warn(`[assess] Grade ${assess.grade} — not proceeding: ${assess.reasoning}`);
          if (!noComment) {
            await commentOnIssue(repoPath, issue.number, formatSkipComment(assess, issue));
          }
          state.status = 'completed';
          return { success: false, error: `Issue graded ${assess.grade}, skipped`, state };
        }
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE S: Spec
    if (!shouldSkip('spec')) {
      const handoff = await spawnWave(
        'spec',
        workDir,
        config,
        buildWaveContext('spec', issue, state.waveResults, { prContext }),
        toOutputFormat(SpecResultSchema),
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.spec = handoffToResult(handoff, waveProvider(config, 'spec'));
      state.completedWaves.push('spec');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // Gate: validate spec pieces have no overlapping files before fan-out
    const specArtifact = state.waveResults.spec?.artifact as SpecResult | undefined;
    if (specArtifact?.pieces && specArtifact.pieces.length > 1) {
      const validation = validatePieceFileOwnership(specArtifact.pieces, specArtifact.dependency_order);
      if (!validation.valid) {
        specArtifact.pieces = validation.pieces;
        specArtifact.dependency_order = validation.dependencyOrder;
        // Persist the corrected spec
        if (state.waveResults.spec) {
          state.waveResults.spec.artifact = specArtifact;
          await saveHandoff(workDir, waveResultToHandoff(state.waveResults.spec));
          await saveCheckpoint(workDir, state);
        }
      }
    }

    // WAVE T + I: Parallel Piece TI Loop (fan-out per piece, backward compat for 1 piece)
    if (!(shouldSkip('test') && shouldSkip('impl'))) {
      const tiResult = await runParallelPieceTILoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        prContext,
        ...(testRunner != null && { testRunner }),
      });

      // Save handoffs for test and impl
      await saveHandoff(workDir, waveResultToHandoff(tiResult.testWaveResult));
      state.waveResults.test = tiResult.testWaveResult;

      const implHandoff: WaveHandoff = {
        ...waveResultToHandoff(tiResult.implWaveResult),
        confidence: tiResult.testsPassing ? 'high' : 'low',
        approach_notes: tiResult.diagnosis ? `diagnosis: ${tiResult.diagnosis}` : '',
      };
      await saveHandoff(workDir, implHandoff);
      state.waveResults.impl = tiResult.implWaveResult;

      if (!state.completedWaves.includes('test')) state.completedWaves.push('test');
      if (!state.completedWaves.includes('impl')) state.completedWaves.push('impl');
      await saveCheckpoint(workDir, state);

      // Escalation: SPEC_WRONG → re-run spec + TI loop
      if (!tiResult.testsPassing && tiResult.diagnosis === 'SPEC_WRONG') {
        log.info('[escalation] SPEC_WRONG — re-running spec then TI loop');
        const specHandoff = await spawnWave(
          'spec',
          workDir,
          config,
          buildWaveContext('spec', issue, state.waveResults, { prContext }),
          toOutputFormat(SpecResultSchema),
        );
        await saveHandoff(workDir, specHandoff);
        state.waveResults.spec = handoffToResult(specHandoff, waveProvider(config, 'spec'));

        const retryTI = await runParallelPieceTILoop({
          issue,
          workDir,
          repoConfig: config,
          waveResults: state.waveResults,
          prContext,
          ...(testRunner != null && { testRunner }),
        });
        state.waveResults.test = retryTI.testWaveResult;
        state.waveResults.impl = retryTI.implWaveResult;
        await saveCheckpoint(workDir, state);

        if (!retryTI.testsPassing) {
          trackFailedPiece(state, retryTI.diagnosis);
        }
      } else if (!tiResult.testsPassing) {
        trackFailedPiece(state, tiResult.diagnosis);
      }

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE Q: Quality
    if (!shouldSkip('quality')) {
      const handoff = await spawnWave(
        'quality',
        workDir,
        config,
        buildWaveContext('quality', issue, state.waveResults, {
          coverageThreshold: config.rules.coverage,
        }),
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.quality = handoffToResult(handoff, waveProvider(config, 'quality'));
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE R: Review Loop
    if (!shouldSkip('review')) {
      const reviewLoopResult = await runReviewLoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        prContext,
        ...(testRunner != null && { testRunner }),
      });

      // Save review handoff
      await saveHandoff(workDir, {
        wave: 'review' as WaveName,
        timestamp: new Date().toISOString(),
        model: reviewLoopResult.reviewWaveResult.model ?? 'unknown',
        cost: reviewLoopResult.totalCost,
        turns: reviewLoopResult.reviewWaveResult.turns,
        confidence: reviewLoopResult.knownIssues.length === 0 ? 'high' : 'medium',
        artifact: reviewLoopResult.reviewWaveResult.artifact,
        approach_notes: `${reviewLoopResult.iterations} iteration(s)`,
      });

      state.waveResults.review = reviewLoopResult.reviewWaveResult;
      if (reviewLoopResult.qualityWaveResult) {
        state.waveResults.quality = reviewLoopResult.qualityWaveResult;
      }
      state.completedWaves.push('review');
      await saveCheckpoint(workDir, state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;

      // Thread known issues to PR body
      if (reviewLoopResult.knownIssues.length > 0) {
        state.reviewKnownIssues = reviewLoopResult.knownIssues.map((f) => ({
          category: f.category,
          file: f.file,
          description: f.description,
          severity: f.severity,
        }));
      }
    }

    // Ship — no AI wave, just git operations
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
      const prSections = [
        `## Summary`,
        `Fixes #${issue.number}`,
        ``,
        `## Context`,
        `${issue.title}`,
        ``,
        `## Open PRs (for merge ordering)`,
        ...openPRs.map((pr) => `- ${pr}`),
      ];

      if (state.reviewKnownIssues && state.reviewKnownIssues.length > 0) {
        prSections.push(
          ``,
          `## Known Issues`,
          `The following issues were identified during review but could not be resolved within the iteration limit:`,
          ``,
          ...state.reviewKnownIssues.map((i) => `- [${i.severity}] \`${i.file}\`: ${i.description}`),
        );
      }

      const prBody = prSections.join('\n');
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

function trackFailedPiece(state: FixState, diagnosis?: string): void {
  const piece: FailedPiece = {
    pieceName: 'impl',
    diagnosis: {
      category: diagnosis ?? 'STUCK',
      theory: 'TI loop exhausted all retries',
      tests_still_failing: [],
    },
  };
  state.failedPieces = [...(state.failedPieces ?? []), piece];
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
