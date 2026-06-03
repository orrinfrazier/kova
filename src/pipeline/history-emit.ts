// History emission helpers — extracted from fix.ts finally block (issue #435).
//
// Aggregates per-wave structured-output metrics (#247), per-wave tool-call
// counts (#278), and the per-run causal telemetry (#266) into a single flat
// history.jsonl entry. Pure helpers — no IO except the appendHistoryEntry
// caller resolves.

import type { VariantSelection } from '../services/ab-test.js';
import { appendHistoryEntry } from '../services/history.js';
import type { FixState, Issue, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';
import type { CostReport } from './cost-report.js';

/** Shape of one history entry's structured-output telemetry sub-record. */
export type HistoryWaveMetric = {
  parse_method?:
    | 'json-tag'
    | 'json-tag-repaired'
    | 'markdown-fence'
    | 'markdown-fence-repaired'
    | 'direct-parse'
    | 'direct-parse-repaired'
    | null
    | undefined;
  attempts: number;
  success: boolean;
  repair_attempts: number;
  model?: string;
};

/** Aggregate per-wave structured-output metrics into a single record (#247). */
export function aggregateStructuredOutputMetrics(state: FixState): Record<string, HistoryWaveMetric> {
  const out: Record<string, HistoryWaveMetric> = {};
  for (const [waveName, waveResult] of Object.entries(state.waveResults)) {
    const m = waveResult?.structured_output_metrics;
    if (!m) continue;
    const entry: HistoryWaveMetric = {
      attempts: m.attempts,
      success: m.success,
      repair_attempts: m.repair_attempts,
    };
    if (m.parse_method !== undefined) entry.parse_method = m.parse_method;
    if (waveResult?.model != null) entry.model = waveResult.model;
    out[waveName] = entry;
  }
  return out;
}

/** Aggregate per-wave tool-call counts into a single run-level total (#278). */
export function aggregateToolCallCounts(
  state: FixState,
): { total: number; reads: number; byTool: Record<string, number> } | undefined {
  let total = 0;
  let reads = 0;
  const byTool: Record<string, number> = {};
  let observedAny = false;
  for (const waveResult of Object.values(state.waveResults)) {
    const counts = waveResult?.toolCallCounts;
    if (!counts) continue;
    observedAny = true;
    total += counts.total;
    reads += counts.reads;
    for (const [name, n] of Object.entries(counts.byTool)) {
      byTool[name] = (byTool[name] ?? 0) + n;
    }
  }
  return observedAny ? { total, reads, byTool } : undefined;
}

/** Derive `gatesFailed` + `firstPassQuality` from the quality wave artifact (#266). */
export function deriveQualityTelemetry(state: FixState): {
  gatesFailed: string[];
  firstPassQuality: boolean | undefined;
} {
  const qualityArtifact = state.waveResults.quality?.artifact as
    | { lint?: string; typecheck?: string; tests?: string; audit?: string; all_passing?: boolean }
    | undefined;
  const GATE_KEYS = ['lint', 'typecheck', 'tests', 'audit'] as const;
  const gatesFailed: string[] = qualityArtifact ? GATE_KEYS.filter((k) => qualityArtifact[k] === 'fail') : [];
  const firstPassQuality =
    qualityArtifact?.all_passing != null ? qualityArtifact.all_passing && (state.retryAttempts ?? 0) === 0 : undefined;
  return { gatesFailed, firstPassQuality };
}

/** Inputs the orchestrator passes to `emitHistoryEntry`. */
export interface EmitHistoryEntryInput {
  state: FixState;
  issue: Issue;
  repoName: string;
  repoPath: string;
  config: RepoConfig;
  costReport: CostReport;
  promptHashes: Record<string, string>;
  abTestVariants?: VariantSelection | undefined;
}

/**
 * Aggregate the per-run causal telemetry and append it to history.jsonl.
 * Best-effort: write failures are logged-and-swallowed so they never
 * interfere with the fix outcome.
 */
export async function emitHistoryEntry(input: EmitHistoryEntryInput): Promise<void> {
  const { state, issue, repoName, repoPath, config, costReport, promptHashes, abTestVariants } = input;
  const shipResult = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;
  const prUrlForHistory = shipResult?.prUrl;

  const structuredOutputMetrics = aggregateStructuredOutputMetrics(state);
  const aggregatedToolCallCounts = aggregateToolCallCounts(state);
  const { gatesFailed, firstPassQuality } = deriveQualityTelemetry(state);

  const assessArtifact = state.waveResults.assess?.artifact as { grade?: 'A' | 'B' | 'C' | 'D' | 'F' } | undefined;

  await appendHistoryEntry(repoPath, {
    timestamp: state.startedAt,
    repo: repoName,
    issues: [
      {
        number: issue.number,
        title: issue.title,
        success: state.status === 'completed',
        ...(prUrlForHistory != null && { prUrl: prUrlForHistory }),
        ...(state.error != null && { error: state.error }),
      },
    ],
    prsCreated: prUrlForHistory ? 1 : 0,
    cost: costReport.totalCost,
    duration: costReport.totalDuration,
    outcome:
      state.status === 'completed'
        ? state.failedPieces && state.failedPieces.length > 0
          ? 'partial'
          : 'success'
        : 'failure',
    ...(Object.keys(promptHashes).length > 0 && { promptHashes }),
    ...(abTestVariants != null && Object.keys(abTestVariants).length > 0 && { abTestVariants }),
    ...(Object.keys(structuredOutputMetrics).length > 0 && { structuredOutputMetrics }),
    ...(assessArtifact?.grade != null && { grade: assessArtifact.grade }),
    ...(state.diagnosis != null && { diagnosis: state.diagnosis }),
    ...(state.thrashingSignal != null && { thrashingSignal: state.thrashingSignal }),
    ...(gatesFailed.length > 0 && { gatesFailed }),
    ...(firstPassQuality != null && { firstPassQuality }),
    ...(state.retryAttempts != null && { retryAttempts: state.retryAttempts }),
    ...(aggregatedToolCallCounts != null && { toolCallCounts: aggregatedToolCallCounts }),
    ...(config.eval?.context_arm != null && { contextArm: config.eval.context_arm }),
  }).catch((err) => {
    log.warn(`Failed to record history: ${err instanceof Error ? err.message : String(err)}`);
  });
}
