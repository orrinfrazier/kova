// Fix pipeline — Assess → Spec → Test → Impl → Quality → Review → Ship
// Uses spawnWaveAgent() for standalone waves, runTILoop() for test+impl,
// and runReviewLoop() for review. Handoffs persist after every wave.

import { z } from 'zod';
import {
  type FixAIWaveName,
  getApiFallbackModelString,
  getMCPToolsForWave,
  getWaveTools,
  isLocalModel,
  type MCPServerHandle,
  type OutputFormat,
  resolveMCPServers,
  resolveThinkingLevel,
  resolveWaveModel,
  spawnWaveAgentWithFallback,
  startAllMCPServers,
  stopAllMCPServers,
} from '../ai/index.js';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from '../services/checkpoint.js';
import { collectPRFeedback } from '../services/feedback-collector.js';
import { commentOnIssue, createPR, listOpenPRs } from '../services/github.js';
import { validateIsolation } from '../services/isolation.js';
import { detectTooling } from '../services/language-detect.js';
import { ensureScreenshotsDir, isPlaywrightEnabled, resolvePlaywrightEnv } from '../services/playwright.js';
import { formatPRContext, type OpenPR } from '../services/pr-context.js';
import { ProgressTracker } from '../services/progress.js';
import {
  formatRepoContext,
  formatRepoSearch,
  formatRepoStandards,
  queryRepoContext,
  queryRepoSearch,
  queryRepoStandards,
} from '../services/repo-intel.js';
import {
  buildSandboxImage,
  DEFAULT_SANDBOX_LIMITS,
  getContainerStats,
  killContainer,
  parseTimeout,
  startSandboxContainer,
} from '../services/sandbox.js';
import { shutdownRequested } from '../services/shutdown.js';
import {
  buildEpisodeRecord,
  formatCodeChunks,
  formatEpisodes,
  formatReviewFeedback,
  queryCodeContext,
  queryEpisodeContext,
  queryReviewFeedbackContext,
  recordEpisode,
} from '../services/vectordb.js';
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

/** Determine the fallback model string for a wave config, if applicable.
 *  Uses the configured fallback model when set, otherwise falls back to
 *  the tier-default API model for local-only models. */
function waveFallbackModel(
  waveConfig: WaveModelConfig,
  modelString: string,
  configFallback?: string,
): string | undefined {
  // Configured fallback takes priority — only use if different from primary
  if (configFallback && configFallback !== modelString) return configFallback;
  // Default behavior: local models fall back to API tier defaults
  if (!isLocalModel(modelString)) return undefined;
  if (typeof waveConfig === 'string') {
    if (waveConfig === 'small' || waveConfig === 'medium' || waveConfig === 'large') {
      return getApiFallbackModelString(waveConfig);
    }
    // Bare model string with local prefix — fall back to medium tier
    return getApiFallbackModelString('medium');
  }
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
  mcpHandles?: Map<string, MCPServerHandle>,
  playwright?: { enabled: boolean },
): Promise<WaveHandoff<T>> {
  const model = resolveWaveModel(config.model[wave]);
  const mcpTools =
    mcpHandles && mcpHandles.size > 0
      ? getMCPToolsForWave(wave, mcpHandles, config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined)
      : undefined;
  const tools = getWaveTools(wave, workDir, { customTools: config.tools, mcpTools, playwright });
  const systemPrompt = await loadPrompt(wave, config.tools);
  const thinkingLevel = resolveThinkingLevel(config, wave);
  const modelString = model.id;
  const fallbackModel = waveFallbackModel(config.model[wave], modelString, config.model.fallback);
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

  // Pre-flight: validate isolation mode is available
  const isolationCheck = await validateIsolation(config.isolation);
  if (!isolationCheck.valid) {
    const errorMsg = isolationCheck.error ?? `Isolation mode "${config.isolation}" is not available`;
    const state = createInitialState(issue, repoName, repoPath);
    state.status = 'failed';
    state.error = errorMsg;
    return { success: false, error: errorMsg, state };
  }

  if (fresh) {
    if (config.isolation === 'worktree' && (await worktreeExists(repoPath, issue.number))) {
      await removeWorktree(repoPath, getWorktreePath(repoPath, issue.number));
      log.info(`[fresh] Removed existing worktree for #${issue.number}`);
    }
  }

  const worktree = config.isolation === 'worktree' ? await createWorktree(repoPath, issue.number) : undefined;
  const workDir = worktree?.path ?? repoPath;

  // Docker sandbox: start container with resource limits
  let sandboxContainerId: string | undefined;
  let sandboxContainerName: string | undefined;
  let sandboxTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let sandboxTimedOut = false;
  const sandboxStartTime = Date.now();

  if (config.isolation === 'docker') {
    const buildResult = await buildSandboxImage({ repoName, config: config.sandbox });
    if (!buildResult.success) {
      const state = createInitialState(issue, repoName, repoPath);
      state.status = 'failed';
      const errorMsg = buildResult.error ?? 'Docker image build failed';
      state.error = errorMsg;
      return { success: false, error: errorMsg, state };
    }

    const sandbox = await startSandboxContainer({
      repoName,
      issueNumber: issue.number,
      repoPath: workDir,
      config: config.sandbox,
    });
    sandboxContainerId = sandbox.containerId;
    sandboxContainerName = sandbox.containerName;

    // Set up timeout kill
    const timeoutStr = config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout;
    const timeoutMs = parseTimeout(timeoutStr);
    sandboxTimeoutHandle = setTimeout(async () => {
      sandboxTimedOut = true;
      log.warn(`[sandbox] Timeout (${timeoutStr}) exceeded — killing container ${sandboxContainerName}`);
      if (sandboxContainerId) await killContainer(sandboxContainerId);
    }, timeoutMs);
  }

  // MCP server startup: resolve config and start servers for tool augmentation
  let mcpHandles = new Map<string, MCPServerHandle>();
  try {
    const mcpServers = await resolveMCPServers(config.mcp);
    if (Object.keys(mcpServers).length > 0) {
      mcpHandles = await startAllMCPServers(mcpServers);
      log.info(`[mcp] ${mcpHandles.size} MCP server(s) running`);
    }
  } catch (error) {
    log.warn(`[mcp] Failed to start MCP servers: ${error instanceof Error ? error.message : String(error)}`);
  }

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

  // Derive owner/repo from issue URL for repo-intel calls
  const ownerRepo = extractOwnerRepo(issue.url);

  // Progress tracker: create/update a single GitHub comment as waves complete
  let progress: ProgressTracker | undefined;
  if (config.github?.progress_comments && ownerRepo) {
    progress = new ProgressTracker({ repoPath, ownerRepo, issue });
    await progress.start();
  }

  const interruptIfShutdown = async (): Promise<FixResult | undefined> => {
    if (!shutdownRequested()) return undefined;
    log.info(`[shutdown] Interrupted after wave [${state.completedWaves.at(-1) ?? 'none'}] for #${issue.number}`);
    state.status = 'interrupted';
    await saveCheckpoint(workDir, state);
    return { success: false, error: 'Interrupted by signal', state };
  };

  try {
    // Detect tooling and set up Playwright if applicable
    const tooling = await detectTooling(workDir);
    const playwrightEnabled = isPlaywrightEnabled(config, tooling);
    const playwrightOption = playwrightEnabled ? { enabled: true } : undefined;
    if (playwrightEnabled) {
      await ensureScreenshotsDir(workDir, config);
      const pwEnv = resolvePlaywrightEnv(config, tooling);
      for (const [key, val] of Object.entries(pwEnv)) {
        process.env[key] = val;
      }
      log.info(`Playwright MCP enabled — screenshots dir: ${pwEnv.PLAYWRIGHT_SCREENSHOTS_DIR}`);
    }

    // Episodic memory: query for past learnings (before assess/spec waves)
    let episodicContext: string | undefined;
    if (config.episodes?.enabled) {
      const query = `${issue.title}\n\n${issue.body}`;
      const episodes = await queryEpisodeContext(config.episodes, query, {
        repo: repoName,
        language: tooling.language !== 'unknown' ? tooling.language : undefined,
      });
      if (episodes.length > 0) {
        episodicContext = formatEpisodes(episodes, repoName);
      }
    }

    // repo-intel: query for repository context (before assess wave)
    let repoContextText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoContext(config.repo_intel, ownerRepo, `${issue.title}\n\n${issue.body}`);
      if (raw.length > 0) {
        repoContextText = formatRepoContext(raw);
      }
    }

    // WAVE A: Assess
    if (!shouldSkip('assess')) {
      const handoff = await spawnWave<AssessResult>(
        'assess',
        workDir,
        config,
        buildWaveContext(
          'assess',
          issue,
          {},
          {
            ...(episodicContext != null && { episodicContext }),
            ...(repoContextText != null && { repoContextText }),
          },
        ),
        toOutputFormat(AssessResultSchema),
        mcpHandles,
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.assess = handoffToResult(handoff, waveProvider(config, 'assess'));
      state.completedWaves.push('assess');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('assess', state);

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

    // Vector DB: query for relevant codebase context (before spec/impl waves)
    let codebaseContext: string | undefined;
    if (config.vectordb?.enabled) {
      const query = `${issue.title}\n\n${issue.body}`;
      const chunks = await queryCodeContext(config.vectordb, query);
      if (chunks.length > 0) {
        codebaseContext = formatCodeChunks(chunks);
      }
    }

    // repo-intel: query for similar implementations (before spec wave)
    let repoSearchText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoSearch(config.repo_intel, ownerRepo, `${issue.title}\n\n${issue.body}`);
      if (raw.length > 0) {
        repoSearchText = formatRepoSearch(raw);
      }
    }

    // WAVE S: Spec
    if (!shouldSkip('spec')) {
      const handoff = await spawnWave(
        'spec',
        workDir,
        config,
        buildWaveContext('spec', issue, state.waveResults, {
          prContext,
          ...(episodicContext != null && { episodicContext }),
          ...(codebaseContext != null && { codebaseContext }),
          ...(repoSearchText != null && { repoSearchText }),
        }),
        toOutputFormat(SpecResultSchema),
        mcpHandles,
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.spec = handoffToResult(handoff, waveProvider(config, 'spec'));
      state.completedWaves.push('spec');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('spec', state);

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
        codebaseContext,
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
      await progress?.waveCompleted('impl', state);

      // Escalation: SPEC_WRONG → re-run spec + TI loop
      if (!tiResult.testsPassing && tiResult.diagnosis === 'SPEC_WRONG') {
        log.info('[escalation] SPEC_WRONG — re-running spec then TI loop');
        const specHandoff = await spawnWave(
          'spec',
          workDir,
          config,
          buildWaveContext('spec', issue, state.waveResults, {
            prContext,
            ...(episodicContext != null && { episodicContext }),
            ...(codebaseContext != null && { codebaseContext }),
            ...(repoSearchText != null && { repoSearchText }),
          }),
          toOutputFormat(SpecResultSchema),
          mcpHandles,
        );
        await saveHandoff(workDir, specHandoff);
        state.waveResults.spec = handoffToResult(specHandoff, waveProvider(config, 'spec'));

        const retryTI = await runParallelPieceTILoop({
          issue,
          workDir,
          repoConfig: config,
          waveResults: state.waveResults,
          prContext,
          codebaseContext,
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

    // repo-intel: query for project standards (before quality wave)
    let repoStandardsText: string | undefined;
    if (config.repo_intel?.enabled && ownerRepo) {
      const raw = await queryRepoStandards(config.repo_intel, ownerRepo);
      if (raw.length > 0) {
        repoStandardsText = formatRepoStandards(raw);
      }
    }

    // WAVE Q: Quality
    if (!shouldSkip('quality')) {
      const handoff = await spawnWave(
        'quality',
        workDir,
        config,
        buildWaveContext('quality', issue, state.waveResults, {
          coverageThreshold: config.rules.coverage,
          ...(repoStandardsText != null && { repoStandardsText }),
        }),
        undefined,
        mcpHandles,
      );
      await saveHandoff(workDir, handoff);
      state.waveResults.quality = handoffToResult(handoff, waveProvider(config, 'quality'));
      state.completedWaves.push('quality');
      await saveCheckpoint(workDir, state);
      await progress?.waveCompleted('quality', state);

      const interrupted = await interruptIfShutdown();
      if (interrupted) return interrupted;
    }

    // WAVE R: Review Loop
    if (!shouldSkip('review')) {
      // Query past review feedback for injection into review wave
      let reviewFeedbackContext: string | undefined;
      if (config.episodes?.enabled) {
        const feedbackItems = await queryReviewFeedbackContext(
          config.episodes,
          `${issue.title}\n\n${issue.body}`,
          repoName,
        );
        if (feedbackItems.length > 0) {
          reviewFeedbackContext = formatReviewFeedback(feedbackItems);
        }
      }

      const reviewLoopResult = await runReviewLoop({
        issue,
        workDir,
        repoConfig: config,
        waveResults: state.waveResults,
        prContext,
        ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
        ...(testRunner != null && { testRunner }),
        playwright: playwrightOption,
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
      await progress?.waveCompleted('review', state);

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
      await progress?.complete(prUrl);
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
    await progress?.failed(msg);
    return { success: false, error: msg, state };
  } finally {
    // Sandbox cleanup: collect stats then kill container
    if (sandboxContainerId) {
      if (sandboxTimeoutHandle) clearTimeout(sandboxTimeoutHandle);

      // Collect resource usage before killing
      const stats = await getContainerStats(sandboxContainerId).catch(() => ({ memoryMB: 0, cpuPercent: 0 }));
      const wallTimeMs = Date.now() - sandboxStartTime;
      const cpuCount = config.sandbox?.cpus ?? DEFAULT_SANDBOX_LIMITS.cpus;

      state.sandboxResourceUsage = {
        peakMemoryMB: stats.memoryMB,
        cpuSeconds: (stats.cpuPercent / 100) * cpuCount * (wallTimeMs / 1000),
        wallTimeMs,
        containerName: sandboxContainerName ?? 'unknown',
        limitsApplied: {
          cpus: cpuCount,
          memory: config.sandbox?.memory ?? DEFAULT_SANDBOX_LIMITS.memory,
          timeout: config.sandbox?.timeout ?? DEFAULT_SANDBOX_LIMITS.timeout,
        },
      };

      if (sandboxTimedOut) {
        log.warn('[sandbox] Container was killed due to timeout');
      }

      await killContainer(sandboxContainerId).catch(() => {});
    }

    const costReport = buildCostReport(state);
    printRunSummary(costReport);
    await writeCostReport(workDir, costReport).catch((err) => {
      log.warn(`Failed to write cost report: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Episodic memory: record fix outcome (success or failure)
    if (config.episodes?.enabled) {
      const episode = buildEpisodeRecord(state);
      const recordTooling = await detectTooling(workDir).catch(() => ({ language: 'unknown' as const }));
      if (recordTooling.language !== 'unknown') {
        episode.language = recordTooling.language;
      }
      await recordEpisode(config.episodes, episode).catch((err) => {
        log.warn(`Failed to record episode: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // PR feedback collection: collect review comments after ship
    const shipArtifact = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;
    const shipPrUrl = shipArtifact?.prUrl;
    if (config.episodes?.enabled && shipPrUrl) {
      const prNumberMatch = shipPrUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch?.[1] ? Number.parseInt(prNumberMatch[1], 10) : undefined;
      if (prNumber) {
        collectPRFeedback({ episodesConfig: config.episodes, repoName, prNumber, repoPath: workDir }).catch((err) => {
          log.warn(`Failed to collect PR feedback: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    // MCP server cleanup
    if (mcpHandles.size > 0) {
      await stopAllMCPServers(mcpHandles);
    }

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

/** Extract "owner/repo" from a GitHub issue URL. Returns undefined if not parseable. */
function extractOwnerRepo(issueUrl: string): string | undefined {
  const match = issueUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match?.[1];
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
