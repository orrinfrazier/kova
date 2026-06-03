// SpecEngine — WAVE S wrapper (issue #354).
//
// Encapsulates the WAVE S spawnWave call PLUS the piece-merging /
// file-ownership validation that ran inline in `fix.ts` lines 887-1064.
//
// What this engine owns:
//   1. Initial spawnWave('spec', ...) call.
//   2. validatePieceFileOwnership() against the spec pieces.
//   3. If piece-to-piece overlap merged → return the merged spec (no retry).
//   4. If pending-PR conflicts → re-run spawnWave once with feedback context.
//   5. If retry still has persistent pending-PR conflicts → emit
//      `mergeDependencies` (open-PR numbers to wait on).
//   6. If retry produces only-overlap-and-no-merge → emit `serialFallback`
//      so the orchestrator can force maxConcurrent=1 on TI.
//
// What stays in the orchestrator:
//   - The empty-pieces post-retry path (#243): a separate concern that fires
//     when structured-output parsing fails repeatedly, not a spec validation
//     concern.
//   - The respec-after-TI-failure escalation: TI's diagnosis drives that
//     loop, not spec validation.
//   - State persistence + checkpoint writes — engines stay stateless.
//
// Contract note: the returned `handoff` is the LAST spawnWave handoff (either
// initial or retry), with `artifact` mutated to reflect any in-validator merge.
// `promptHash` matches the same call.

import {
  buildWaveSessionId,
  getMCPToolsForWave,
  getModelString,
  getWaveTools,
  isConsensusPool,
  isLocalModel,
  resolveThinkingLevel,
  resolveWaveModel,
} from '../../ai/index.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import { dispatchSpawnWave } from '../../sandbox/dispatch.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../../services/prompt-versions.js';
import type { SpecResult } from '../../types/index.js';
import { log } from '../../utils/logger.js';
import { loadPrompt } from '../prompts.js';
import {
  formatOverlapFeedback,
  formatPendingPRConflictFeedback,
  validatePieceFileOwnership,
} from '../spec-validator.js';
import { waveFallbackModel } from './fallback.js';
import type { EngineConfig, EngineContext, EngineResult, WaveEngine } from './types.js';

/**
 * Pending PR descriptor used by the spec engine to record `mergeDependencies`
 * when conflicts persist after the retry. Shape-compatible with `pr-context.OpenPR`
 * but kept structural so the engine doesn't pull in the wider service module.
 */
export interface SpecEnginePendingPR {
  number: number;
  files: string[];
}

/**
 * Input for the spec wave.
 *   - `userMessage` is pre-built by the orchestrator (issue body + PR context
 *     + episodic/codebase/playbook context) via `buildWaveContext('spec', ...)`.
 *   - `pendingPRFiles` are flattened from `pendingPRs` so the validator can
 *     detect overlap quickly; both lists are passed because `mergeDependencies`
 *     needs the PR-number mapping.
 *   - `pendingPRs` is optional — pass it when the orchestrator wants the engine
 *     to compute `mergeDependencies` on persistent conflict.
 */
export interface SpecEngineInput extends EngineConfig {
  userMessage: string;
  pendingPRFiles: readonly string[];
  pendingPRs?: readonly SpecEnginePendingPR[] | undefined;
}

/**
 * Result returned by the spec engine.
 *   - `handoff` + `promptHash` follow the standard EngineResult contract.
 *   - `serialFallback` mirrors fix.ts:929 — set when the retry still has
 *     overlaps the validator could not merge. Orchestrator passes this to
 *     `runParallelPieceTILoop` as `maxConcurrent: 1`.
 *   - `mergeDependencies` is the list of pending-PR numbers whose files
 *     remain conflicting after the retry. Orchestrator records these on
 *     state so the fix waits on those merges before opening its own PR.
 *   - `retried` lets the caller observe whether a retry happened (useful
 *     for telemetry and tests).
 */
export interface SpecEngineResult extends EngineResult<SpecResult> {
  serialFallback: boolean;
  mergeDependencies?: number[] | undefined;
  retried: boolean;
}

const WAVE: FixAIWaveName = 'spec';

/**
 * The SpecEngine narrows the engine contract to its richer `SpecEngineResult`
 * return type (which extends `EngineResult<SpecResult>` with `serialFallback`,
 * `mergeDependencies`, and `retried`). This is a deliberate covariant narrowing
 * — every `WaveEngine<SpecEngineInput, SpecResult>` consumer still sees the
 * base shape, while callers that want the spec-specific fields see them too.
 */
export interface SpecEngineType extends WaveEngine<SpecEngineInput, SpecResult> {
  run(ctx: EngineContext, input: SpecEngineInput): Promise<SpecEngineResult>;
}

export const SpecEngine: SpecEngineType = {
  name: WAVE,
  async run(ctx, input): Promise<SpecEngineResult> {
    const { userMessage, pendingPRFiles, pendingPRs } = input;

    // First spawn — same as fix.ts:890.
    const first = await spawnSpec(ctx, userMessage, input);
    let currentHandoff = first.handoff;
    let currentPromptHash = first.promptHash;

    const initialArtifact = currentHandoff.artifact as SpecResult | undefined;
    let serialFallback = false;
    let mergeDependencies: number[] | undefined;
    let retried = false;

    // Skip validation entirely if the model produced no pieces — the empty-pieces
    // path is handled by the orchestrator (#243 retry semantics).
    if (initialArtifact?.pieces && initialArtifact.pieces.length > 0) {
      const validation = validatePieceFileOwnership(initialArtifact.pieces, initialArtifact.dependency_order, [
        ...pendingPRFiles,
      ]);

      // Persist merged result back into the handoff so downstream code sees the
      // post-merge piece list — same shape mutation fix.ts performs into state.
      if (validation.merged) {
        currentHandoff = {
          ...currentHandoff,
          artifact: {
            ...initialArtifact,
            pieces: validation.pieces,
            dependency_order: validation.dependencyOrder,
          },
        };
        log.info(
          `[spec-engine] Merged spec in place (${initialArtifact.pieces.length} → ${validation.pieces.length} pieces)`,
        );
      }

      // Retry trigger: persistent pending-PR conflict, OR overlaps that the
      // validator could not absorb via merge. Mirror fix.ts:963-964.
      const needsRetry =
        validation.pendingPRConflicts.length > 0 || (validation.overlaps.length > 0 && !validation.merged);

      if (needsRetry) {
        retried = true;
        const feedbackParts: string[] = [];
        if (validation.overlaps.length > 0) feedbackParts.push(formatOverlapFeedback(validation.overlaps));
        if (validation.pendingPRConflicts.length > 0) {
          feedbackParts.push(formatPendingPRConflictFeedback(validation.pendingPRConflicts));
        }
        const feedback = feedbackParts.join('\n\n');

        log.warn(
          `[spec-engine] Spec retry needed (${validation.overlaps.length} overlap(s), ` +
            `${validation.pendingPRConflicts.length} pending PR conflict(s))`,
        );

        const retryMessage = `${userMessage}\n\n${feedback}`;
        const retry = await spawnSpec(ctx, retryMessage, input);
        currentHandoff = retry.handoff;
        currentPromptHash = retry.promptHash;

        const retryArtifact = currentHandoff.artifact as SpecResult | undefined;
        if (retryArtifact?.pieces && retryArtifact.pieces.length > 0) {
          const retryValidation = validatePieceFileOwnership(retryArtifact.pieces, retryArtifact.dependency_order, [
            ...pendingPRFiles,
          ]);

          if (retryValidation.merged) {
            currentHandoff = {
              ...currentHandoff,
              artifact: {
                ...retryArtifact,
                pieces: retryValidation.pieces,
                dependency_order: retryValidation.dependencyOrder,
              },
            };
            log.info(
              `[spec-engine] Merged retry spec in place (${retryArtifact.pieces.length} → ${retryValidation.pieces.length} pieces)`,
            );
          }

          if (!retryValidation.valid) {
            if (retryValidation.overlaps.length > 0 && !retryValidation.merged) {
              log.warn(`[spec-engine] Retry still has unmergeable overlap — orchestrator should serialize TI`);
              serialFallback = true;
            }
            if (retryValidation.pendingPRConflicts.length > 0 && pendingPRs && pendingPRs.length > 0) {
              const conflictingFiles = new Set(retryValidation.pendingPRConflicts.map((c) => c.file));
              const deps = new Set<number>();
              for (const pr of pendingPRs) {
                if (pr.files.some((f) => conflictingFiles.has(f))) deps.add(pr.number);
              }
              if (deps.size > 0) {
                mergeDependencies = [...deps];
                log.warn(
                  `[spec-engine] Pending PR conflicts persist — merge dependencies: ` +
                    `[${[...deps].map((n) => `#${n}`).join(', ')}]`,
                );
              }
            }
          }
        }
      }
    }

    return {
      handoff: currentHandoff,
      promptHash: currentPromptHash,
      serialFallback,
      ...(mergeDependencies != null && { mergeDependencies }),
      retried,
    };
  },
};

/**
 * Inner helper that mirrors `spawnWave('spec', ...)` from fix.ts so the
 * initial + retry calls share one implementation. Returns the bare handoff +
 * promptHash; merge/feedback logic lives in the engine's `run` above.
 */
async function spawnSpec(
  ctx: EngineContext,
  userMessage: string,
  input: SpecEngineInput,
): Promise<EngineResult<SpecResult>> {
  const {
    workDir,
    repoPath,
    config,
    sandbox,
    mcpHandles,
    promptsDir,
    projectContext,
    runSkills,
    cacheContext,
    runtimeFactory,
    resolvedMcpServers,
    eventContext,
  } = ctx;
  const { outputFormat } = input;

  const model = resolveWaveModel(config.model[WAVE]);
  const mcpTools =
    mcpHandles && mcpHandles.size > 0
      ? getMCPToolsForWave(WAVE, mcpHandles, config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined)
      : undefined;
  const tools = getWaveTools(WAVE, workDir, {
    customTools: config.tools,
    mcpTools,
    ...(ctx.playwright != null && { playwright: ctx.playwright }),
  });
  const systemPrompt = await loadPrompt(WAVE, config.tools, projectContext, promptsDir, {
    ...(ctx.abTestVariant != null && { abTestVariant: ctx.abTestVariant }),
    ...(runSkills != null && {
      skills: { skills: runSkills.skills, enabledWaves: runSkills.enabledWaves },
    }),
  });
  const promptHash = hashPrompt(systemPrompt);

  const change = await detectPromptChange(repoPath, WAVE, systemPrompt).catch(() => null);
  if (change) {
    log.info(`Prompt changed for ${WAVE}: ${change.previousHash} → ${change.currentHash}`);
  }
  await recordPromptVersion(repoPath, WAVE, systemPrompt).catch(() => {});

  const thinkingLevel = resolveThinkingLevel(config, WAVE);
  const modelString = getModelString(model);
  const fallbackModel = waveFallbackModel(config.model[WAVE], modelString, config.model.fallback, {
    isConsensusPool,
    isLocalModel,
  });
  const timeoutSeconds = config.rules.wave_timeout?.[WAVE];
  const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;
  const sessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: WAVE }) : undefined;
  // Issue #306 — sandbox-only MCP plumbing. Host-path waves use `tools` above.
  const sandboxMcpServers =
    sandbox != null && resolvedMcpServers != null && Object.keys(resolvedMcpServers).length > 0
      ? resolvedMcpServers
      : undefined;
  const sandboxMcpWaveOverrides =
    sandbox != null ? (config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined) : undefined;

  const handoff = await dispatchSpawnWave<SpecResult>(
    {
      wave: WAVE,
      model: modelString,
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd: workDir,
      thinkingLevel,
      fallbackModel,
      ...(outputFormat != null && { outputFormat }),
      ...(timeoutMs != null && { timeoutMs }),
      ...(sessionId != null ? { sessionId } : {}),
      ...(eventContext != null
        ? {
            eventBus: eventContext.eventBus,
            eventContext: { runId: eventContext.runId, repoId: eventContext.repoId, fixId: eventContext.fixId },
          }
        : {}),
      ...(runtimeFactory != null ? { runtimeFactory } : {}),
      ...(sandboxMcpServers != null ? { mcpServers: sandboxMcpServers } : {}),
      ...(sandboxMcpWaveOverrides != null ? { mcpWaveOverrides: sandboxMcpWaveOverrides } : {}),
    },
    sandbox,
  );

  return { handoff, promptHash };
}
