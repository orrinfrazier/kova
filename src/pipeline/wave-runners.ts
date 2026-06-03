// Wave-runner helpers — extracted from fix.ts (issue #435).
//
// Each helper hosts the "between engine" orchestration for one wave: the
// metrics emission, checkpoint persistence, FixState merge, and the small
// post-engine branches that adapt the engine's discriminated-union result
// back into the orchestrator's flat FixState. Engines own the actual work.
//
// Helpers are pure-async — they take everything they need by parameter and
// return either a FixResult (when the wave returns early) or void (when
// the orchestrator should continue).

import { saveCheckpoint } from '../services/checkpoint.js';
import * as metrics from '../services/metrics.js';
import type { ProgressTracker } from '../services/progress.js';
import type { FixState, Issue, RepoConfig, SpecResult, WaveResult } from '../types/index.js';
import { saveHandoff } from '../types/index.js';
import type { Logger } from '../utils/logger.js';
import { probeShipPreflightOverlaps } from './codegraph-checks.js';
import type { TIEngineType } from './engines/index.js';
import { applyEngineStateDelta, createShipEngine, type EngineContext } from './engines/index.js';
import type { FixResult } from './fix.js';

/** Inputs for `runShipWave` — kept lean by taking the orchestrator slots by ref. */
export interface RunShipWaveInput {
  issue: Issue;
  state: FixState;
  config: RepoConfig;
  workDir: string;
  repoPath: string;
  worktreeBranch: string | undefined;
  prContext: string | undefined;
  codebaseContext: string | undefined;
  codegraphContext: string | undefined;
  callPathContext: string | undefined;
  testRunner: import('./loops.js').TestRunner | undefined;
  skipTestPhase: boolean;
  skipImplPhase: boolean;
  extraImplAttempts: number;
  tiEngine: TIEngineType;
  buildEngineContext: () => EngineContext;
  progress: ProgressTracker | undefined;
  logger: Logger;
}

/**
 * Discriminated-result of `runShipWave` so the caller can branch without
 * inspecting FixState. `early_return` carries a fully-formed `FixResult`
 * — the orchestrator returns it directly. `proceed` means the ship wave
 * completed successfully and the orchestrator should fall through to the
 * default "fix complete" exit.
 */
export type RunShipWaveResult =
  | { kind: 'early_return'; result: FixResult }
  | { kind: 'proceed'; updatedState: FixState };

/**
 * Run the WAVE Ship block. Encapsulates pre-flight codegraph warning,
 * ShipEngine dispatch + retryParallelTILoop callback, metrics emission,
 * and the no_changes / failed / shipped result mapping.
 */
export async function runShipWave(input: RunShipWaveInput): Promise<RunShipWaveResult> {
  const {
    issue,
    state: stateIn,
    config,
    workDir,
    repoPath,
    worktreeBranch,
    prContext,
    codebaseContext,
    codegraphContext,
    callPathContext,
    testRunner,
    skipTestPhase,
    skipImplPhase,
    extraImplAttempts,
    tiEngine,
    buildEngineContext,
    progress,
    logger,
  } = input;
  const state = stateIn;
  const shipStart = Date.now();
  const branch = worktreeBranch ?? `kova/fix-${issue.number}`;

  const specArtifactForShip = state.waveResults.spec?.artifact as SpecResult | undefined;
  const specFiles = specArtifactForShip?.pieces?.flatMap((p) => p.files) ?? [];

  // Codegraph-aware dependency-overlap pre-flight WARNING (#276).
  await probeShipPreflightOverlaps({ workDir, repoPath, specFiles, logger });

  metrics.recordRebaseAttempt();
  const shipEngine = createShipEngine();
  const shipResult = await shipEngine.run(
    { workDir, repoPath, config },
    {
      issue,
      branch,
      specFiles,
      openPRs: [], // engine fetches via listOpenPRs internally
      ...(state.mergeDependencies &&
        state.mergeDependencies.length > 0 && { mergeDependencies: state.mergeDependencies }),
      ...(state.reviewKnownIssues &&
        state.reviewKnownIssues.length > 0 && {
          reviewKnownIssues: state.reviewKnownIssues.map(
            (i) =>
              ({
                category: i.category,
                file: i.file,
                description: i.description,
                severity: i.severity,
              }) as import('../types/index.js').ReviewFinding,
          ),
        }),
      retryParallelTILoop: async (retryInput) => {
        metrics.recordConflictDetected();
        const conflictTIResult = await tiEngine.run(buildEngineContext(), {
          issue,
          waveResults: state.waveResults,
          ...(prContext != null && { prContext }),
          codebaseContext: [codebaseContext, retryInput.codebaseContext].filter(Boolean).join('\n\n'),
          ...(codegraphContext != null && { codegraphContext }),
          ...(callPathContext != null && { callPathContext }),
          ...(testRunner != null && { testRunner }),
          ...(skipTestPhase && { skipTestPhase: true }),
          ...(skipImplPhase && { skipImplPhase: true }),
          ...(extraImplAttempts > 0 && { extraImplAttempts }),
        });
        const retryTI = conflictTIResult.handoff.artifact;
        state.waveResults.test = retryTI.testWaveResult;
        state.waveResults.impl = retryTI.implWaveResult;
        await saveCheckpoint(workDir, state);
        return { testsPassing: retryTI.testsPassing };
      },
    },
  );

  if (shipResult.status === 'failed') {
    if (shipResult.reason === 'rebase') metrics.recordConflictFailed();
    state.status = 'failed';
    state.error = shipResult.error;
    await saveCheckpoint(workDir, state);
    metrics.recordIssueFailed();
    return { kind: 'early_return', result: { success: false, error: state.error, state } };
  }

  if (shipResult.status === 'no_changes') {
    logger.child({ wave: 'ship' }).warn('No changes to commit — skipping PR');
    state.waveResults.ship = {
      wave: 'ship',
      success: true,
      artifact: { noChanges: true },
      duration: 0,
      cost: 0,
      turns: 0,
    } satisfies WaveResult;
    state.completedWaves.push('ship');
    state.status = 'completed';
    await saveCheckpoint(workDir, state);
    metrics.recordWaveCompleted('ship');
    metrics.recordWaveDuration('ship', Date.now() - shipStart);
    metrics.recordIssueFixed();
    return { kind: 'early_return', result: { success: true, state } };
  }

  // shipResult.status === 'shipped' — record PR + metrics.
  state.waveResults.ship = {
    wave: 'ship',
    success: true,
    artifact: {
      prUrl: shipResult.prUrl,
      ...(shipResult.commitMessage != null && { commitMessage: shipResult.commitMessage }),
      filesStaged: shipResult.filesStaged,
    },
    duration: 0,
    cost: 0,
    turns: 0,
  } satisfies WaveResult;
  state.completedWaves.push('ship');
  state.status = 'completed';
  await saveCheckpoint(workDir, state);
  await progress?.complete(shipResult.prUrl);
  metrics.recordWaveCompleted('ship');
  metrics.recordWaveDuration('ship', Date.now() - shipStart);
  metrics.recordPRCreated();
  metrics.recordIssueFixed();
  logger.info(`Fix complete: ${shipResult.prUrl}`);
  // Make sure to write back the prUrl to FixResult.
  return { kind: 'early_return', result: { success: true, prUrl: shipResult.prUrl, state } };
}

// --- WAVE T+I runner (parallel piece + shouldRespec escalation) ---

import { z as Z2 } from 'zod';
import type { OutputFormat as _OF } from '../ai/index.js';
import { getCurrentHeadSha } from '../services/git-diff.js';
import { type WaveHandoff as _WaveHandoff, SpecResultSchema } from '../types/index.js';
import { refreshCodebaseContext } from './context-refresh.js';
import { SpecEngine, type SpecEngineInput } from './engines/index.js';
import { waveResultToHandoff } from './result.js';
import { appendFailedPiece } from './state-helpers.js';

function specOutputFormat(): _OF {
  return {
    type: 'json_schema',
    schema: Z2.toJSONSchema(SpecResultSchema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: SpecResultSchema,
  };
}

export interface RunTIWaveInput {
  issue: Issue;
  state: FixState;
  config: RepoConfig;
  workDir: string;
  prContext: string | undefined;
  codebaseContext: string | undefined;
  codegraphContext: string | undefined;
  callPathContext: string | undefined;
  failedEpisodicContext: string | undefined;
  repoSearchText: string | undefined;
  testRunner: import('./loops.js').TestRunner | undefined;
  serialFallback: boolean;
  skipTestPhase: boolean;
  skipImplPhase: boolean;
  extraImplAttempts: number;
  pendingPRFileList: string[];
  tiEngine: TIEngineType;
  specCtxBase: EngineContext;
  buildEngineContext: () => EngineContext;
  progress: ProgressTracker | undefined;
  setPromptHash: (wave: string, hash: string | undefined) => void;
  logger: Logger;
}

/** Result of `runTIWave`: updated state + new codebaseContext (refreshed post-impl per #277). */
export interface RunTIWaveResult {
  state: FixState;
  codebaseContext: string | undefined;
}

/**
 * Run the WAVE T+I block: pre-impl SHA capture (#277), TIEngine dispatch,
 * handoff persistence, post-impl codebaseContext refresh, and the
 * shouldRespec escalation (spec re-dispatch + second TI attempt + state
 * delta application).
 */
export async function runTIWave(input: RunTIWaveInput): Promise<RunTIWaveResult> {
  const {
    issue,
    state: stateIn,
    config,
    workDir,
    prContext,
    codebaseContext: codebaseContextIn,
    codegraphContext,
    callPathContext,
    failedEpisodicContext,
    repoSearchText,
    testRunner,
    serialFallback,
    skipTestPhase,
    skipImplPhase,
    extraImplAttempts,
    pendingPRFileList,
    tiEngine,
    specCtxBase,
    buildEngineContext,
    progress,
    setPromptHash,
    logger,
  } = input;
  let state = stateIn;
  let codebaseContext = codebaseContextIn;
  const tiWaveStart = Date.now();

  // Capture pre-impl HEAD SHA for incremental refresh (#277).
  let preImplSha: string | null = null;
  try {
    preImplSha = await getCurrentHeadSha(workDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[context-refresh] Could not capture pre-impl SHA (${msg}) — context refresh will be a no-op`);
  }

  const tiCtx = buildEngineContext();
  const tiEngineResult = await tiEngine.run(tiCtx, {
    issue,
    waveResults: state.waveResults,
    ...(prContext != null && { prContext }),
    ...(codebaseContext != null && { codebaseContext }),
    ...(codegraphContext != null && { codegraphContext }),
    ...(callPathContext != null && { callPathContext }),
    ...(testRunner != null && { testRunner }),
    ...(serialFallback && { maxConcurrent: 1 }),
    ...(skipTestPhase && { skipTestPhase: true }),
    ...(skipImplPhase && { skipImplPhase: true }),
    ...(extraImplAttempts > 0 && { extraImplAttempts }),
  });
  const tiResult = tiEngineResult.handoff.artifact;

  await saveHandoff(workDir, waveResultToHandoff(tiResult.testWaveResult));
  state.waveResults.test = tiResult.testWaveResult;

  const implHandoff: _WaveHandoff = {
    ...waveResultToHandoff(tiResult.implWaveResult),
    confidence: tiResult.testsPassing ? 'high' : 'low',
    approach_notes: tiResult.diagnosis ? `diagnosis: ${tiResult.diagnosis}` : '',
  };
  await saveHandoff(workDir, implHandoff);
  state.waveResults.impl = tiResult.implWaveResult;
  state = applyEngineStateDelta(state, tiEngineResult.stateDelta);

  if (!state.completedWaves.includes('test')) state.completedWaves.push('test');
  if (!state.completedWaves.includes('impl')) state.completedWaves.push('impl');
  await saveCheckpoint(workDir, state);
  await progress?.waveCompleted('impl', state);
  const tiDuration = Date.now() - tiWaveStart;
  metrics.recordWaveCompleted('test');
  metrics.recordWaveDuration('test', tiDuration);
  metrics.recordWaveCompleted('impl');
  metrics.recordWaveDuration('impl', tiDuration);

  // Issue #277: refresh codebaseContext to reflect post-impl edits.
  codebaseContext = await refreshCodebaseContext({
    config,
    workDir,
    sinceSha: preImplSha,
    issueQuery: `${issue.title}\n\n${issue.body}`,
    currentContext: codebaseContext,
  });

  // Escalation: shouldRespec → re-run spec + TI loop (max 1 re-spec).
  if (!tiResult.testsPassing && tiResult.shouldRespec) {
    logger.info(`[escalation] ${tiResult.diagnosis ?? 'SPEC_WRONG'} — re-running spec then TI loop`);
    const respecContext = `Previous spec led to ${tiResult.diagnosis ?? 'failure'} — the implementation could not pass the tests. Re-examine the requirements and produce a revised spec.`;
    const respecResult = await SpecEngine.run(specCtxBase, {
      userMessage: buildWaveContext('spec', issue, state.waveResults, {
        ...(prContext != null && { prContext }),
        ...(failedEpisodicContext != null && { episodicContext: failedEpisodicContext }),
        ...(codegraphContext != null && { codegraphContext }),
        ...(callPathContext != null && { callPathContext }),
        ...(codebaseContext != null && { codebaseContext }),
        ...(repoSearchText != null && { repoSearchText }),
        escalationHint: respecContext,
      }),
      outputFormat: specOutputFormat(),
      pendingPRFiles: pendingPRFileList,
    } satisfies SpecEngineInput);
    await saveHandoff(workDir, respecResult.handoff);
    setPromptHash('spec', respecResult.promptHash);
    state.waveResults.spec = handoffToResult(
      respecResult.handoff,
      waveProvider(config, 'spec'),
      respecResult.promptHash,
    );
    state = applyEngineStateDelta(state, respecResult.stateDelta);

    const respecTI = await tiEngine.run(tiCtx, {
      issue,
      waveResults: state.waveResults,
      ...(prContext != null && { prContext }),
      ...(codebaseContext != null && { codebaseContext }),
      ...(codegraphContext != null && { codegraphContext }),
      ...(callPathContext != null && { callPathContext }),
      ...(testRunner != null && { testRunner }),
      ...(skipTestPhase && { skipTestPhase: true }),
      ...(skipImplPhase && { skipImplPhase: true }),
      ...(extraImplAttempts > 0 && { extraImplAttempts }),
    });
    const retryTI = respecTI.handoff.artifact;
    state.waveResults.test = retryTI.testWaveResult;
    state.waveResults.impl = retryTI.implWaveResult;
    state = applyEngineStateDelta(state, respecTI.stateDelta);
    appendFailedPiece(state, respecTI.newFailedPiece);
    await saveCheckpoint(workDir, state);
  } else {
    appendFailedPiece(state, tiEngineResult.newFailedPiece);
  }

  return { state, codebaseContext };
}

// --- WAVE Q runner (quality + self-healing retry) ---

import { z } from 'zod';
import type { AgentRuntimeFactory, MCPServerHandle, OutputFormat } from '../ai/index.js';
import type { VariantSelection } from '../services/ab-test.js';
import { defaultLiveFixRegistry, type LiveFixRegistry } from '../services/live-fix-registry.js';
import { formatRepoStandards, queryRepoStandards } from '../services/repo-intel.js';
import type { MCPServerConfig } from '../types/index.js';
import { QualityRemediationSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { buildWaveContext } from './context.js';
import {
  type FixRunSkills,
  type SpawnWaveCacheContext,
  type SpawnWaveEventContext,
  spawnWave,
} from './context-builder.js';
import { createQualityEngine } from './engines/index.js';
import type { ProjectContext } from './project-context.js';
import { handoffToResult, waveProvider } from './result.js';

function qualityOutputFormat(schema: z.ZodType): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: schema,
  };
}

export interface RunQualityWaveInput {
  issue: Issue;
  state: FixState;
  config: RepoConfig;
  workDir: string;
  repoPath: string;
  ownerRepo: string | undefined;
  testRunner: import('./loops.js').TestRunner | undefined;
  mcpHandles: Map<string, MCPServerHandle>;
  resolvedPromptsDir: string | undefined;
  projectContext: ProjectContext | undefined;
  abTestVariants: VariantSelection | undefined;
  sandboxContext: import('../sandbox/dispatch.js').SandboxContext | undefined;
  runSkills: FixRunSkills | undefined;
  cacheContext: SpawnWaveCacheContext;
  eventContext: SpawnWaveEventContext;
  resolvedRuntimeFactory: AgentRuntimeFactory | undefined;
  resolvedMcpServers: Record<string, MCPServerConfig>;
  liveFixRegistry: LiveFixRegistry;
  buildEngineContext: () => EngineContext;
  progress: ProgressTracker | undefined;
  setPromptHash: (wave: string, hash: string | undefined) => void;
  logger: Logger;
}

/**
 * Run the WAVE Q block: repo-intel project-standards query, initial quality
 * dispatch via spawnWave, then QualityEngine self-healing retry. Returns the
 * updated FixState.
 */
export async function runQualityWave(input: RunQualityWaveInput): Promise<FixState> {
  const {
    issue,
    state: stateIn,
    config,
    workDir,
    repoPath,
    ownerRepo,
    testRunner,
    mcpHandles,
    resolvedPromptsDir,
    projectContext,
    abTestVariants,
    sandboxContext,
    runSkills,
    cacheContext,
    eventContext,
    resolvedRuntimeFactory,
    resolvedMcpServers,
    liveFixRegistry,
    buildEngineContext,
    progress,
    setPromptHash,
    logger: _logger,
  } = input;
  void _logger;
  const state = stateIn;
  let repoStandardsText: string | undefined;
  if (config.repo_intel?.enabled && ownerRepo) {
    const raw = await queryRepoStandards(config.repo_intel, ownerRepo);
    if (raw.length > 0) {
      repoStandardsText = formatRepoStandards(raw);
    }
  }

  const waveStart = Date.now();
  const { handoff, promptHash } = await spawnWave(
    'quality',
    workDir,
    repoPath,
    config,
    buildWaveContext('quality', issue, state.waveResults, {
      coverageThreshold: config.rules.coverage,
      ...(repoStandardsText != null && { repoStandardsText }),
    }),
    qualityOutputFormat(QualityRemediationSchema),
    mcpHandles,
    undefined,
    resolvedPromptsDir,
    projectContext,
    abTestVariants?.quality,
    sandboxContext,
    runSkills,
    cacheContext,
    eventContext,
    resolvedRuntimeFactory,
    resolvedMcpServers,
    liveFixRegistry ?? defaultLiveFixRegistry,
  );
  await saveHandoff(workDir, handoff);
  setPromptHash('quality', promptHash);
  state.waveResults.quality = handoffToResult(handoff, waveProvider(config, 'quality'), promptHash);
  state.completedWaves.push('quality');
  await saveCheckpoint(workDir, state);
  await progress?.waveCompleted('quality', state);
  metrics.recordWaveCompleted('quality');
  metrics.recordWaveDuration('quality', Date.now() - waveStart);

  // Quality self-healing: delegated to QualityEngine.
  const qualityEngine = createQualityEngine();
  const qualityRetryEngineResult = await qualityEngine.run(buildEngineContext(), {
    issue,
    waveResults: state.waveResults,
    ...(testRunner != null && { testRunner }),
  });
  const qualityRetry = qualityRetryEngineResult.handoff.artifact;
  if (qualityRetry.retried) {
    state.waveResults.quality = qualityRetry.qualityWaveResult;
    await saveCheckpoint(workDir, state);
    log.info(`[fix] Quality self-healing completed (cost: $${qualityRetry.totalCost.toFixed(2)})`);
  }
  return state;
}

// --- WAVE R runner (review loop) ---

import { syncCodegraph } from '../ai/codegraph.js';
import { formatReviewFeedback, queryReviewFeedbackContext } from '../services/memory/review-feedback-rest.js';
import { buildRegressionSurface } from './codegraph-checks.js';
import { createReviewEngine, type ReviewEngineInput } from './engines/index.js';

export interface RunReviewWaveInput {
  issue: Issue;
  state: FixState;
  config: RepoConfig;
  repoName: string;
  workDir: string;
  repoPath: string;
  prContext: string | undefined;
  testRunner: import('./loops.js').TestRunner | undefined;
  codegraphAvailable: boolean;
  codegraphWithholdList: string[];
  buildEngineContext: () => EngineContext;
  progress: ProgressTracker | undefined;
  logger: Logger;
}

/**
 * Run the WAVE R block. Owns: pre-review codegraph sync (#271), review-feedback
 * context query (#369), regression-surface context build (#276), ReviewEngine
 * dispatch, and state/handoff/metrics persistence.
 */
export async function runReviewWave(input: RunReviewWaveInput): Promise<FixState> {
  const {
    issue,
    state: stateIn,
    config,
    repoName,
    workDir,
    repoPath,
    prContext,
    testRunner,
    codegraphAvailable,
    codegraphWithholdList,
    buildEngineContext,
    progress,
    logger,
  } = input;
  let state = stateIn;

  // Issue #271 — sync the codegraph so impact/callers/callees reflect WAVE-I
  // edits before the review wave consults the graph.
  if (codegraphAvailable && codegraphWithholdList.length === 0) {
    const syncResult = await syncCodegraph(workDir);
    if (!syncResult.ok) {
      logger.warn(`[codegraph] pre-review sync failed (${syncResult.reason}) — review will use stale graph`);
    } else {
      logger.info('[codegraph] pre-review sync complete');
    }
  }

  const waveStart = Date.now();

  // Query past review feedback for injection.
  let reviewFeedbackContext: string | undefined;
  if (config.episodes?.enabled) {
    const feedbackItems = await queryReviewFeedbackContext(
      config.episodes,
      `${issue.title}\n\n${issue.body}`,
      repoName,
      workDir,
    );
    if (feedbackItems.length > 0) {
      reviewFeedbackContext = formatReviewFeedback(feedbackItems);
    }
  }

  const regressionSurfaceContext = await buildRegressionSurface({ workDir, repoPath, logger });

  const reviewEngine = createReviewEngine();
  const reviewInput: ReviewEngineInput = {
    issue,
    waveResults: state.waveResults,
    ...(prContext != null && { prContext }),
    ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
    ...(regressionSurfaceContext != null && { regressionSurfaceContext }),
    ...(testRunner != null && { testRunner }),
  };
  const reviewEngineResult = await reviewEngine.run(buildEngineContext(), reviewInput);
  const reviewLoopResult = reviewEngineResult.handoff.artifact;

  await saveHandoff(workDir, reviewEngineResult.handoff);

  state.waveResults.review = reviewLoopResult.reviewWaveResult;
  if (reviewLoopResult.qualityWaveResult) {
    state.waveResults.quality = reviewLoopResult.qualityWaveResult;
  }
  state = applyEngineStateDelta(state, reviewEngineResult.stateDelta);
  state.completedWaves.push('review');
  await saveCheckpoint(workDir, state);
  await progress?.waveCompleted('review', state);
  metrics.recordWaveCompleted('review');
  metrics.recordWaveDuration('review', Date.now() - waveStart);

  return state;
}

// Re-exports for callers that need them alongside the runners.
export { applyEngineStateDelta, saveHandoff };
