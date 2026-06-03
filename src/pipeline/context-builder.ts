// Context Builder — wave-spawn helper extracted from fix.ts (issue #435 — ADR 004 step 2).
//
// Encapsulates the per-wave AI-agent dispatch path: resolves model + fallback,
// loads the wave prompt (with skills + project-context injection), records
// prompt version, builds the LiveFixRegistry sink, and routes through
// `dispatchSpawnWave` (which in turn picks host vs sandbox execution).
//
// Pure dispatch — no FixState, no checkpoints, no metrics. The orchestrator
// owns those; this module owns the "how do I run one wave end-to-end?" seam.
//
// Today only the WAVE Q initial-dispatch call site uses this module (the
// other waves have engines that handle dispatch internally). Engines for
// quality's initial dispatch are tracked as a follow-up.

import type { Skill } from '@earendil-works/pi-coding-agent';
import {
  type AgentRuntimeFactory,
  buildWaveSessionId,
  type FixAIWaveName,
  getMCPToolsForWave,
  getModelString,
  getWaveTools,
  isConsensusPool,
  isLocalModel,
  type MCPServerHandle,
  type OutputFormat,
  resolveThinkingLevel,
  resolveWaveModel,
} from '../ai/index.js';
import { dispatchSpawnWave, type SandboxContext } from '../sandbox/dispatch.js';
import type { EventBus } from '../services/event-bus/index.js';
import { buildLiveHandleSink, type LiveFixRegistry } from '../services/live-fix-registry.js';
import { detectPromptChange, hashPrompt, recordPromptVersion } from '../services/prompt-versions.js';
import type { MCPServerConfig, RepoConfig, SkillWaveName, WaveHandoff } from '../types/index.js';
import { log } from '../utils/logger.js';
import { waveFallbackModel } from './engines/fallback.js';
import type { ProjectContext } from './project-context.js';
import { loadPrompt } from './prompts.js';

/** Cached per-run skills + the configured enabledWaves list (issue #298). */
export interface FixRunSkills {
  skills: readonly Skill[];
  enabledWaves: readonly SkillWaveName[];
}

/**
 * Cache-affinity context for prompt-cache pinning (issue #297).
 */
export interface SpawnWaveCacheContext {
  repo: string;
  issue: string | number;
}

/**
 * Shared event context — forwarded into wave-executor so wave-enter / wave-output
 * / cost / aborted events share the orchestrator's runId/fixId tags (issue #340).
 */
export interface SpawnWaveEventContext {
  eventBus: EventBus;
  runId: string;
  repoId: string;
  fixId: string;
}

/**
 * Spawn a wave agent with automatic local-to-API fallback. Returns the handoff
 * + prompt hash.
 *
 * When `sandbox` is provided, the wave is dispatched into the sandbox container
 * via `dispatchSpawnWave` — the AI runs on `/workspace` inside the container,
 * not on the host filesystem. Without `sandbox`, the wave runs in-process on
 * the host (worktree / none isolation modes).
 *
 * Issue #297: when `cacheContext` is provided, builds a deterministic
 * `sessionId` of the form `kova-<repo>-<issue>-<wave>` and forwards it to the
 * underlying spawn so providers that key prompt caching off session affinity
 * can keep the cache hot across the multi-turn run. The per-wave cache
 * retention default (long for impl/test) is applied inside spawnWaveAgent.
 */
export async function spawnWave<T>(
  wave: FixAIWaveName,
  workDir: string,
  repoPath: string,
  config: RepoConfig,
  userMessage: string,
  outputFormat?: OutputFormat,
  mcpHandles?: Map<string, MCPServerHandle>,
  playwright?: { enabled: boolean },
  promptsDir?: string,
  projectContext?: ProjectContext,
  abTestVariant?: string,
  sandbox?: SandboxContext | undefined,
  runSkills?: FixRunSkills | undefined,
  cacheContext?: SpawnWaveCacheContext,
  eventContext?: SpawnWaveEventContext,
  /**
   * Issue #407 — pre-resolved `AgentRuntimeFactory`. When undefined, spawnWaveAgent
   * applies its own `defaultAgentRuntimeFactory` default (pi-mono). Caller `fix()`
   * resolves precedence (option > config.runtime > 'pi') once and threads the
   * factory into every wave so the runtime choice is consistent across S/T/I/Q/R.
   */
  runtimeFactory?: AgentRuntimeFactory | undefined,
  /**
   * Issue #306 — host-resolved MCP server config map. Forwarded only when
   * `sandbox` is set so dispatch.ts can serialize it across the docker-exec
   * boundary; the runner inside the sandbox starts the same servers locally
   * on `/workspace`. Host-path waves get MCP tools via `mcpHandles` (live
   * connections) and ignore this field — it would be redundant on the host.
   */
  resolvedMcpServers?: Record<string, MCPServerConfig> | undefined,
  /**
   * Issue #294 — optional LiveFixRegistry to register the wave's live agent
   * handle in (keyed by `eventContext.fixId`). When set, `kova send <fixId>`
   * and `kova kill <fixId>` route into the running wave via the daemon's
   * steer/abort RPCs. When unset, the wave runs unchanged — backward-compat.
   * Sandbox path skips registration (agent runs in a remote container).
   */
  liveFixRegistry?: LiveFixRegistry | undefined,
): Promise<{ handoff: WaveHandoff<T>; promptHash: string }> {
  const model = resolveWaveModel(config.model[wave]);
  const mcpTools =
    mcpHandles && mcpHandles.size > 0
      ? getMCPToolsForWave(wave, mcpHandles, config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined)
      : undefined;
  const tools = getWaveTools(wave, workDir, { customTools: config.tools, mcpTools, playwright });
  const systemPrompt = await loadPrompt(wave, config.tools, projectContext, promptsDir, {
    abTestVariant,
    ...(runSkills != null && {
      skills: { skills: runSkills.skills, enabledWaves: runSkills.enabledWaves },
    }),
  });
  const promptHash = hashPrompt(systemPrompt);

  // Prompt versioning: detect changes and record version
  const change = await detectPromptChange(repoPath, wave, systemPrompt).catch(() => null);
  if (change) {
    log.info(`Prompt changed for ${wave}: ${change.previousHash} → ${change.currentHash}`);
  }
  await recordPromptVersion(repoPath, wave, systemPrompt).catch(() => {});
  const thinkingLevel = resolveThinkingLevel(config, wave);
  const modelString = getModelString(model);
  const fallbackModel = waveFallbackModel(config.model[wave], modelString, config.model.fallback, {
    isConsensusPool,
    isLocalModel,
  });
  // Issue #244: per-repo wave_timeout override (seconds) → ms.
  const timeoutSeconds = config.rules.wave_timeout?.[wave];
  const timeoutMs = timeoutSeconds != null ? timeoutSeconds * 1000 : undefined;
  // Issue #297: build a deterministic session id when caller supplied the
  // cache context. Forwarded to dispatchSpawnWave → spawnWaveAgent → runtime,
  // where pi-mono Agent threads it into the provider call as the
  // cache-affinity key.
  const sessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave }) : undefined;
  // Issue #306 — when dispatching into a sandbox, the host-side `mcpHandles`
  // live connections cannot cross the container boundary. Instead we forward
  // the resolved MCP server CONFIG map (commands + args + env) so the
  // in-container runner can call `startAllMCPServers` on /workspace itself.
  // Host-path waves use `mcpTools` (already in `tools`) and don't need this.
  const sandboxMcpServers =
    sandbox != null && resolvedMcpServers != null && Object.keys(resolvedMcpServers).length > 0
      ? resolvedMcpServers
      : undefined;
  const sandboxMcpWaveOverrides =
    sandbox != null ? (config.mcp?.waves as Partial<Record<FixAIWaveName, string[]>> | undefined) : undefined;

  // Issue #294: when a registry + fixId are present AND we're on the host path
  // (no sandbox), build a sink that registers the live handle under the fixId
  // for the duration of this wave.
  const fixIdForRegistry = eventContext?.fixId;
  const liveHandleSink = buildLiveHandleSink({
    registry: liveFixRegistry,
    fixId: fixIdForRegistry,
    sandboxActive: sandbox != null,
    ...(eventContext != null
      ? { eventBus: eventContext.eventBus, eventContext: { runId: eventContext.runId, repoId: eventContext.repoId } }
      : {}),
    wave,
  });

  try {
    const handoff = await dispatchSpawnWave<T>(
      {
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
    return { handoff, promptHash };
  } finally {
    // Issue #294: clear the live handle for this fixId so a subsequent
    // `kova send <fixId>` between waves returns a clear "not running" error
    // instead of routing into a stale agent.
    if (liveFixRegistry != null && fixIdForRegistry != null) {
      liveFixRegistry.clear(fixIdForRegistry);
    }
  }
}
