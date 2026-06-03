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
  resolveThinkingLevel,
  resolveWaveModel,
} from '../../ai/index.js';
import type { FixAIWaveName } from '../../ai/wave-tools.js';
import { dispatchSpawnWave } from '../../sandbox/dispatch.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../../services/prompt-versions.js';
import type { AssessResult } from '../../types/index.js';
import { log } from '../../utils/logger.js';
import { loadPrompt } from '../prompts.js';
import { waveFallbackModel } from './fallback.js';
import type { EngineConfig, EngineResult, WaveEngine } from './types.js';

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
 */
export interface AssessEngineInput extends EngineConfig {
  userMessage: string;
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
    } = ctx;
    const { userMessage, outputFormat } = input;

    const model = resolveWaveModel(config.model[WAVE]);
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
    const modelString = getModelString(model);
    const fallbackModel = waveFallbackModel(config.model[WAVE], modelString, config.model.fallback, {
      isConsensusPool,
      isLocalModel,
    });
    const timeoutSeconds = config.rules.wave_timeout?.[WAVE];
    const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;
    const sessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: WAVE }) : undefined;
    // Issue #306 — sandbox-only MCP plumbing. Host-path waves get MCP tools via
    // `tools` (already resolved above); the sandbox runner reconstructs servers
    // on /workspace from this config map.
    const sandboxMcpServers =
      sandbox != null && resolvedMcpServers != null && Object.keys(resolvedMcpServers).length > 0
        ? resolvedMcpServers
        : undefined;
    const sandboxMcpWaveOverrides =
      sandbox != null ? (config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined) : undefined;

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
      },
      sandbox,
    );

    return { handoff, promptHash };
  },
};
