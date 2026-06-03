// Parallel multi-model wave executor with opus adjudication (#260).
//
// `spawnConsensusWave<T>` is the consensus complement to `spawnWaveAgent` /
// `spawnWaveAgentWithFallback` (sequential failover): it dispatches the wave
// to every pool member concurrently, retries each failing worker ONCE, and
// then spawns a single adjudicator (always large/opus by default) that
// receives every surviving worker's artifact + approach notes + confidence
// and emits one reconciled `WaveHandoff`.
//
// Why a separate function: `spawnWaveAgentWithFallback` returns ONE artifact
// wholesale and is sequential by design — adding a parallel-fanout branch
// would muddle a primitive that has clean "primary, then maybe fallback"
// semantics. The parallel/adjudicate pattern is a different shape: N
// independent runs that get reconciled by a final pass.
//
// Per-pool-member runtime swap (post-#310): pool members can opt into
// different `AgentRuntimeFactory` values via `poolMembers[i].runtimeFactory`.
// Without an override, every member uses the default factory (pi-mono today).
// The adjudicator always uses the default factory unless overridden.
//
// Invariants:
//   - At least 2 pool members required (otherwise it's not consensus).
//   - Adjudicator is ALWAYS large-tier by default — never inherits a pool
//     member's tier, even if every pool member is small.
//   - Failing workers are retried EXACTLY ONCE, then dropped.
//   - Run succeeds (proceeds to adjudication) iff ≥2 valid artifacts survive.
//   - Returned `handoff.cost` is the sum of every worker attempt (including
//     failed) + adjudicator cost.
//   - No worker can leak its `Agent` instance — all returns are `WaveHandoff<T>`
//     per the inter-wave-isolation invariant documented on `spawnWaveAgent`.

import type { WaveHandoff } from '../types/index.js';
import { log } from '../utils/logger.js';
import { KovaError } from './errors.js';
import { getModelString, resolveWaveModel } from './models.js';
import { type OutputFormat, type SpawnWaveAgentConfig, spawnWaveAgent } from './wave-executor.js';

/**
 * Per-pool-member metadata in the consensus result. One entry per configured
 * pool model, preserved in input order so callers can map back to their
 * config.
 */
export interface PoolMemberResult {
  /** The model string that was dispatched (post-resolution form, `provider:id`). */
  model: string;
  /**
   * `success` — produced a valid artifact within the retry budget.
   * `dropped` — failed after initial attempt + one retry; excluded from adjudication.
   */
  status: 'success' | 'dropped';
  /** Cost incurred by this pool member across all attempts. 0 when every attempt threw before producing a handoff. */
  cost: number;
  /** Per-pool-member confidence from the surviving handoff (when `status === 'success'`). */
  confidence?: 'high' | 'medium' | 'low';
  /** Surviving handoff's approach notes (when `status === 'success'`). */
  approach_notes?: string;
  /** Error message from the final failed attempt (when `status === 'dropped'`). */
  error?: string;
}

/**
 * Reconciliation outcome based on whether worker artifacts agree by
 * structural equality (`JSON.stringify` order-stable round-trip).
 *
 * - `unanimous` — every surviving worker emitted the same artifact JSON.
 * - `majority` — ≥(N+1)/2 workers agree; the rest diverged.
 * - `split` — no majority; adjudicator chooses freely.
 *
 * The adjudicator is invoked in all three cases — `agreement` is metadata
 * for telemetry and downstream UI, not a control flag.
 */
export type ConsensusAgreement = 'unanimous' | 'majority' | 'split';

export interface ConsensusMetadata {
  pool_results: PoolMemberResult[];
  /** Resolved adjudicator model string (`provider:id`). */
  adjudicator_model: string;
  /** True when one or more pool members were dropped after retry. */
  degraded: boolean;
  /** Worker-artifact agreement classification (see `ConsensusAgreement`). */
  agreement: ConsensusAgreement;
}

export interface ConsensusWaveHandoff<T = unknown> extends WaveHandoff<T> {
  consensus: ConsensusMetadata;
}

/**
 * Optional per-pool-member configuration. Today only `runtimeFactory` is
 * exposed — that's the seam #310 opened for swapping the underlying
 * `AgentRuntime` per worker. Other `SpawnWaveAgentConfig` fields are inherited
 * from the base config; per-member overrides for them can be added later if a
 * concrete use case appears.
 */
export interface PoolMemberConfig {
  model: string;
  runtimeFactory?: SpawnWaveAgentConfig['runtimeFactory'];
}

/**
 * Inputs for `spawnConsensusWave`. The shape mirrors `SpawnWaveAgentConfig`
 * but with `model` replaced by `poolModels` (≥2 entries) and an optional
 * `adjudicatorModel`. The `outputFormat`, `tools`, `cwd`, `systemPrompt`,
 * `handoffContext`, `userMessage`, and per-wave runtime knobs (timeoutMs,
 * maxCostUsd, thinkingLevel, …) are shared across every pool member and the
 * adjudicator.
 */
export interface SpawnConsensusWaveConfig extends Omit<SpawnWaveAgentConfig, 'model' | 'runtimeFactory'> {
  /**
   * Pool of models to run concurrently. Pass either bare model strings or
   * full `PoolMemberConfig` objects (the latter lets you swap `AgentRuntime`
   * per pool member — see kova#310). At least 2 entries required.
   */
  poolModels: ReadonlyArray<string | PoolMemberConfig>;
  /**
   * Adjudicator model string (round-trip `provider:id`). Defaults to the
   * `large` tier resolved from kova's model registry — typically opus. The
   * adjudicator is ALWAYS large regardless of pool tiers; explicit override
   * is allowed for testing and for callers who want a specific reconciler.
   */
  adjudicatorModel?: string;
  /**
   * Optional adjudicator `AgentRuntimeFactory` override. Defaults to the
   * same factory used by `spawnWaveAgent` (pi-mono today).
   */
  adjudicatorRuntimeFactory?: SpawnWaveAgentConfig['runtimeFactory'];
}

const MIN_POOL_SIZE = 2;
const WORKER_RETRY_BUDGET = 1; // one retry after the initial attempt

/**
 * Resolve the default adjudicator model string lazily so test seams that
 * stub `resolveWaveModel` work without import-time side effects.
 */
function getDefaultAdjudicatorModelString(): string {
  return getModelString(resolveWaveModel('large'));
}

function normalizePoolMember(entry: string | PoolMemberConfig): PoolMemberConfig {
  return typeof entry === 'string' ? { model: entry } : entry;
}

/** Run one worker's wave with one retry on failure. Returns the surviving
 *  handoff + cumulative cost across attempts, or null + accumulated cost +
 *  the final error message when both attempts failed. */
async function runWorkerWithOneRetry<T>(
  baseConfig: Omit<SpawnConsensusWaveConfig, 'poolModels' | 'adjudicatorModel' | 'adjudicatorRuntimeFactory'>,
  member: PoolMemberConfig,
): Promise<{ handoff: WaveHandoff<T> | null; cost: number; error?: string }> {
  let totalCost = 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= WORKER_RETRY_BUDGET; attempt++) {
    try {
      const handoff = await spawnWaveAgent<T>({
        ...baseConfig,
        model: member.model,
        ...(member.runtimeFactory != null ? { runtimeFactory: member.runtimeFactory } : {}),
      });
      totalCost += handoff.cost;
      // Treat low-confidence as a soft failure on the first attempt only.
      // The retry might land on a higher-confidence result; if not, we accept
      // it and let the adjudicator decide (or be dropped if we hit retry budget).
      if (handoff.confidence === 'low' && attempt < WORKER_RETRY_BUDGET) {
        log.warn(`[consensus] worker ${member.model} returned low confidence (attempt ${attempt + 1}), retrying`);
        lastError = new Error('low confidence');
        continue;
      }
      return { handoff, cost: totalCost };
    } catch (err) {
      lastError = err;
      log.warn(
        `[consensus] worker ${member.model} attempt ${attempt + 1}/${WORKER_RETRY_BUDGET + 1} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    handoff: null,
    cost: totalCost,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/** Classify agreement by structural equality of worker artifacts. */
function classifyAgreement(handoffs: ReadonlyArray<WaveHandoff<unknown>>): ConsensusAgreement {
  if (handoffs.length === 0) return 'split';
  const firstKey = JSON.stringify(handoffs[0]?.artifact);
  const matchCount = handoffs.filter((h) => JSON.stringify(h.artifact) === firstKey).length;
  if (matchCount === handoffs.length) return 'unanimous';
  if (matchCount > handoffs.length / 2) return 'majority';
  return 'split';
}

/**
 * Build the adjudicator's user message: original user message + every
 * surviving worker's artifact JSON + approach notes + confidence. Keeps the
 * raw `userMessage` first so the adjudicator's prompt-cache prefix lines up
 * with the workers' prompts — only the appended "pool artifacts" section
 * varies.
 */
function buildAdjudicatorMessage(
  originalUserMessage: string,
  survivors: ReadonlyArray<{ model: string; handoff: WaveHandoff<unknown> }>,
  agreement: ConsensusAgreement,
): string {
  const sections = survivors.map(({ model, handoff }, idx) => {
    const artifactJson = JSON.stringify(handoff.artifact, null, 2);
    return [
      `### Pool member ${idx + 1}: ${model}`,
      `confidence: ${handoff.confidence}`,
      `approach_notes: ${handoff.approach_notes}`,
      'artifact:',
      '```json',
      artifactJson,
      '```',
    ].join('\n');
  });

  return [
    originalUserMessage,
    '',
    '---',
    '',
    'You are the ADJUDICATOR for a consensus wave. Multiple pool members ran the same wave',
    `concurrently. Their results are listed below (agreement: ${agreement}).`,
    '',
    'Your job: emit ONE reconciled artifact that satisfies the original task. Reason over the',
    'pool artifacts as evidence — cite specifics, prefer the strongest single approach over',
    'a hedge, and break ties on quality, not vote count. Output the same structured-output',
    'format the pool members emitted.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Dispatch the wave concurrently to every pool member, retry each failing
 * worker exactly once, drop workers that still fail, and adjudicate the
 * surviving artifacts via a single large-tier model. Returns one
 * `ConsensusWaveHandoff<T>` whose `cost` is the sum of every worker attempt
 * plus the adjudicator's cost.
 *
 * Throws `KovaError('consensus_insufficient_pool', 'config', false)` when
 * fewer than 2 pool members survive — adjudication needs ≥2 perspectives
 * to be meaningful (otherwise just call `spawnWaveAgent` directly).
 */
export async function spawnConsensusWave<T = unknown>(
  config: SpawnConsensusWaveConfig,
): Promise<ConsensusWaveHandoff<T>> {
  const { poolModels, adjudicatorModel, adjudicatorRuntimeFactory, ...sharedConfig } = config;

  if (poolModels.length < MIN_POOL_SIZE) {
    throw new KovaError(
      `spawnConsensusWave requires at least ${MIN_POOL_SIZE} pool members (got ${poolModels.length})`,
      'config',
      false,
    );
  }

  const members = poolModels.map(normalizePoolMember);
  log.info(
    `[consensus] dispatching ${members.length} workers concurrently for wave=${sharedConfig.wave}: ${members
      .map((m) => m.model)
      .join(', ')}`,
  );

  // Phase 1: dispatch every pool member concurrently. Each worker handles its
  // own one-retry budget inside `runWorkerWithOneRetry` so the outer
  // Promise.allSettled never sees a rejected promise (the function returns
  // `handoff: null` on terminal failure rather than throwing).
  const settled = await Promise.allSettled(members.map((member) => runWorkerWithOneRetry<T>(sharedConfig, member)));

  // Project into per-member results + collect survivors in input order.
  const poolResults: PoolMemberResult[] = members.map((member, i) => {
    const result = settled[i];
    if (!result || result.status === 'rejected') {
      const reason = result?.status === 'rejected' ? result.reason : 'unknown failure';
      return {
        model: member.model,
        status: 'dropped' as const,
        cost: 0,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    const { handoff, cost, error } = result.value;
    if (handoff == null) {
      return {
        model: member.model,
        status: 'dropped' as const,
        cost,
        ...(error != null ? { error } : {}),
      };
    }
    return {
      model: member.model,
      status: 'success' as const,
      cost,
      confidence: handoff.confidence,
      approach_notes: handoff.approach_notes,
    };
  });

  const survivors = members
    .map((member, i) => {
      const r = settled[i];
      if (!r || r.status === 'rejected' || r.value.handoff == null) return null;
      return { model: member.model, handoff: r.value.handoff };
    })
    .filter((s): s is { model: string; handoff: WaveHandoff<T> } => s !== null);

  const degraded = survivors.length < members.length;
  const workerCostTotal = poolResults.reduce((sum, r) => sum + r.cost, 0);

  log.info(
    `[consensus] worker phase complete: ${survivors.length}/${members.length} surviving, degraded=${degraded}, worker_cost=${workerCostTotal.toFixed(4)}`,
  );

  if (survivors.length < MIN_POOL_SIZE) {
    throw new KovaError(
      `spawnConsensusWave: insufficient surviving pool members for adjudication (${survivors.length}/${members.length} survived, need ≥${MIN_POOL_SIZE}). ` +
        `Drops: ${poolResults
          .filter((r) => r.status === 'dropped')
          .map((r) => `${r.model}: ${r.error ?? 'unknown'}`)
          .join('; ')}`,
      'config',
      false,
    );
  }

  // Phase 2: classify agreement, then spawn the adjudicator. The adjudicator
  // is ALWAYS large by default — never inherits a pool member's tier. It
  // receives the original user message plus every survivor's artifact + notes.
  const agreement = classifyAgreement(survivors.map((s) => s.handoff));
  const resolvedAdjudicatorModel = adjudicatorModel ?? getDefaultAdjudicatorModelString();

  log.info(
    `[consensus] dispatching adjudicator wave=${sharedConfig.wave} model=${resolvedAdjudicatorModel} agreement=${agreement}`,
  );

  const adjudicatorMessage = buildAdjudicatorMessage(sharedConfig.userMessage, survivors, agreement);

  const adjudicatorHandoff = await spawnWaveAgent<T>({
    ...sharedConfig,
    userMessage: adjudicatorMessage,
    model: resolvedAdjudicatorModel,
    ...(adjudicatorRuntimeFactory != null ? { runtimeFactory: adjudicatorRuntimeFactory } : {}),
  });

  const totalCost = workerCostTotal + adjudicatorHandoff.cost;

  log.info(
    `[consensus] adjudication complete: agreement=${agreement} adjudicator_cost=${adjudicatorHandoff.cost.toFixed(4)} total_cost=${totalCost.toFixed(4)}`,
  );

  return {
    ...adjudicatorHandoff,
    cost: totalCost,
    consensus: {
      pool_results: poolResults,
      adjudicator_model: resolvedAdjudicatorModel,
      degraded,
      agreement,
    },
  };
}

// Type re-export for callers that want to inspect outputFormat shape without
// touching wave-executor directly.
export type { OutputFormat };
