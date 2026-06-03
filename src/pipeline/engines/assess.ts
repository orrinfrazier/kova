// AssessEngine — WAVE A wrapper (issue #354).
//
// Mirrors the `spawnWave('assess', ...)` call site in `fix.ts` lines 769-797.
// The grading gate (`should_proceed → comment + bail`) STAYS in the orchestrator:
// engines never make pipeline-flow decisions; they run the wave and return the
// artifact. The episodic-memory + repo-intel context strings are pre-built by
// the orchestrator and passed in as `userMessage`.

import {
  buildWaveSessionId,
  getMCPToolsForWave,
  getModelString,
  getWaveTools,
  isConsensusPool,
  isLocalModel,
  resolveConsensusPool,
  resolveThinkingLevel,
  resolveWaveModel,
} from '../../ai/index.js';
import { spawnConsensusWave } from '../../ai/parallel-executor.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../../memory/prompt-versions.js';
import { dispatchSpawnWave } from '../../sandbox/dispatch.js';
import { appendConsensusDisagreement } from '../../telemetry/consensus-disagreements.js';
import { buildLiveHandleSink } from '../../telemetry/live-fix-registry.js';
import type { AssessResult, PipelineMode } from '../../types/index.js';
import { log } from '../../utils/logger.js';
import { applyPipelineMode, autoSelectMode, describeAutoSelection, MODE_EXTRA_IMPL_ATTEMPTS } from '../mode.js';
import { loadPrompt } from '../prompts.js';
import { waveFallbackModel } from './fallback.js';
import type { EngineConfig, EngineConfigDelta, EngineResult, WaveEngine } from './types.js';

/**
 * Input for the assess wave. The orchestrator pre-builds `userMessage` from
 * the issue body + episodic context + repo-intel + pattern context (so this
 * engine stays decoupled from the context-builder), and supplies the schema
 * to route structured output.
 *
 * `eventContext`, `runtimeFactory`, and `resolvedMcpServers` are sourced from
 * `EngineContext` (orchestrator-owned plumbing). Engines forward them into
 * `dispatchSpawnWave` so the runtime choice and event tagging stay consistent
 * across every wave in a single fix run.
 *
 * `explicitMode` (issue #432) lets the orchestrator pass `options.mode` so the
 * engine can pre-resolve the pipeline mode and return it via `configDelta`. If
 * `explicitMode` is undefined the engine auto-selects from the assess artifact.
 */
export interface AssessEngineInput extends EngineConfig {
  userMessage: string;
  explicitMode?: PipelineMode | undefined;
}

const WAVE: FixAIWaveName = 'assess';

export const AssessEngine: WaveEngine<AssessEngineInput, AssessResult> = {
  name: WAVE,
  async run(ctx, input): Promise<EngineResult<AssessResult>> {
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
      liveFixRegistry,
    } = ctx;
    const { userMessage, outputFormat, explicitMode } = input;

    const waveConfig = config.model[WAVE];

    // Shared per-wave plumbing — both single-model and consensus paths need
    // tools, prompt, and the cross-wave knobs. The model resolution + dispatch
    // call site is the only thing that branches.
    const mcpTools =
      mcpHandles && mcpHandles.size > 0
        ? getMCPToolsForWave(
            WAVE,
            mcpHandles,
            config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined,
          )
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

    // Prompt-version drift detection — best-effort; never blocks the wave.
    const change = await detectPromptChange(repoPath, WAVE, systemPrompt).catch(() => null);
    if (change) {
      log.info(`Prompt changed for ${WAVE}: ${change.previousHash} → ${change.currentHash}`);
    }
    await recordPromptVersion(repoPath, WAVE, systemPrompt).catch(() => {});

    const thinkingLevel = resolveThinkingLevel(config, WAVE);
    const timeoutSeconds = config.rules.wave_timeout?.[WAVE];
    const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;
    const sessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: WAVE }) : undefined;

    // Consensus-pool routing (#261): when the wave config is a pool, fan out
    // through `spawnConsensusWave` instead of the single-model dispatch path.
    // The disagreement-log callback writes `.kova/consensus_disagreements.jsonl`
    // (#262) when the adjudicator overrides ≥1 pool member.
    if (isConsensusPool(waveConfig)) {
      const { pool, adjudicator } = resolveConsensusPool(waveConfig);
      const poolModels = pool.map(getModelString);
      const adjudicatorModel = getModelString(adjudicator);
      const handoff = await spawnConsensusWave<AssessResult>({
        wave: WAVE,
        poolModels,
        adjudicatorModel,
        tools,
        systemPrompt,
        handoffContext: '',
        userMessage,
        cwd: workDir,
        thinkingLevel,
        ...(outputFormat != null && { outputFormat }),
        ...(timeoutMs != null && { timeoutMs }),
        ...(sessionId != null ? { sessionId } : {}),
        ...(eventContext != null
          ? {
              eventBus: eventContext.eventBus,
              eventContext: { runId: eventContext.runId, repoId: eventContext.repoId, fixId: eventContext.fixId },
            }
          : {}),
        appendDisagreement: (record) => appendConsensusDisagreement(repoPath, record),
      });
      const configDelta = buildConfigDelta(config, handoff.artifact as AssessResult | undefined, explicitMode);
      return { handoff, promptHash, ...(configDelta != null && { configDelta }) };
    }

    // Single-model path: existing dispatch through dispatchSpawnWave.
    const model = resolveWaveModel(waveConfig);
    const modelString = getModelString(model);
    const fallbackModel = waveFallbackModel(waveConfig, modelString, config.model.fallback, {
      isConsensusPool,
      isLocalModel,
    });
    // Issue #306 — sandbox-only MCP plumbing. Host-path waves get MCP tools via
    // `tools` (already resolved above); the sandbox runner reconstructs servers
    // on /workspace from this config map.
    const sandboxMcpServers =
      sandbox != null && resolvedMcpServers != null && Object.keys(resolvedMcpServers).length > 0
        ? resolvedMcpServers
        : undefined;
    const sandboxMcpWaveOverrides =
      sandbox != null ? (config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined) : undefined;

    // Issue #294: build a `liveHandleSink` when a registry + fixId are present
    // AND we're on the host path (no sandbox). The sandbox path's agent runs
    // in a remote container with no in-process handle to expose.
    const fixIdForRegistry = eventContext?.fixId;
    const liveHandleSink = buildLiveHandleSink({
      registry: liveFixRegistry,
      fixId: fixIdForRegistry,
      sandboxActive: sandbox != null,
      ...(eventContext != null
        ? { eventBus: eventContext.eventBus, eventContext: { runId: eventContext.runId, repoId: eventContext.repoId } }
        : {}),
      wave: WAVE,
    });

    try {
      const handoff = await dispatchSpawnWave<AssessResult>(
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
          ...(liveHandleSink != null ? { liveHandleSink } : {}),
        },
        sandbox,
      );

      const configDelta = buildConfigDelta(config, handoff.artifact as AssessResult | undefined, explicitMode);
      return { handoff, promptHash, ...(configDelta != null && { configDelta }) };
    } finally {
      // Issue #294: clear the entry so a between-wave `kova send <fixId>`
      // surfaces "not running" instead of routing into a stale agent.
      if (liveFixRegistry != null && fixIdForRegistry != null) {
        liveFixRegistry.clear(fixIdForRegistry);
      }
    }
  },
};

/**
 * Compute the pipeline-mode `EngineConfigDelta` (issue #432).
 *
 * Replicates the resolution branch that used to live inline in fix.ts:1132-1147:
 *   - explicit `--mode` from FixOptions wins
 *   - else auto-select from the assess artifact's grade + surface area
 *   - else fall back to `standard` (no artifact -> never economize)
 *
 * Returns `undefined` when the engine cannot determine a mode (no explicit
 * mode AND no artifact) — but this branch is unreachable today because the
 * fallback to 'standard' covers the artifact-missing case. We keep the
 * undefined return for defensive symmetry with future engine deltas.
 *
 * Side-effect-free except for an info-level log line that mirrors the old
 * orchestrator log so log parsers don't regress.
 */
export function buildConfigDelta(
  config: import('../../types/index.js').RepoConfig,
  artifact: AssessResult | undefined,
  explicitMode: PipelineMode | undefined,
): EngineConfigDelta | undefined {
  let resolvedMode: PipelineMode;
  if (explicitMode != null) {
    resolvedMode = explicitMode;
    log.info(`Pipeline mode: ${resolvedMode} (explicit via --mode).`);
  } else if (artifact != null) {
    const fileCount = artifact.surface_area.files.length;
    resolvedMode = autoSelectMode(artifact.grade, fileCount);
    log.info(
      `Pipeline mode: ${resolvedMode} (auto-selected). ${describeAutoSelection(artifact.grade, fileCount, resolvedMode)}`,
    );
  } else {
    // Assess artifact missing (e.g. confidence too low for structured output).
    // Fall back to standard — never economize when we can't see surface area.
    resolvedMode = 'standard';
    log.info(`Pipeline mode: ${resolvedMode} (default — no assess artifact available).`);
  }
  const newConfig = applyPipelineMode(config, resolvedMode);
  const extraImplAttempts = MODE_EXTRA_IMPL_ATTEMPTS[resolvedMode];
  if (extraImplAttempts > 0) {
    log.info(
      `[mode] ${resolvedMode} — running up to ${3 + extraImplAttempts} impl attempts per piece (review selects winner).`,
    );
  }
  return {
    config: newConfig,
    resolvedMode,
    extraImplAttempts,
  };
}
