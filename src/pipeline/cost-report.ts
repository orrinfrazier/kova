import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLocalProvider } from '../ai/index.js';
import type { FixState, SandboxResourceUsage, StructuredOutputMetrics, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface CostReport {
  issueNumber: number;
  totalCost: number;
  apiCost: number;
  localCost: number;
  totalTurns: number;
  totalDuration: number;
  waves: Array<{
    wave: string;
    cost: number;
    turns: number;
    duration: number;
    model?: string | undefined;
    provider?: string | undefined;
    fallback_used?: boolean | undefined;
    /**
     * Structured-output extraction telemetry for this wave (issue #247).
     * Present when the wave was invoked with an `outputFormat`.
     */
    structured_output_metrics?: StructuredOutputMetrics | undefined;
  }>;
  /** Per-provider cost aggregation (e.g., { anthropic: 0.50, google: 0.20 }). */
  providerCosts: Record<string, number>;
  fallbackCount: number;
  startedAt: string;
  completedAt: string;
  sandboxResourceUsage?: SandboxResourceUsage | undefined;
}

const WAVE_ORDER: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];

export function buildCostReport(state: FixState): CostReport {
  const waves: CostReport['waves'] = [];
  let totalCost = 0;
  let apiCost = 0;
  let localCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  let fallbackCount = 0;
  const providerCosts: Record<string, number> = {};

  for (const wave of WAVE_ORDER) {
    const result = state.waveResults[wave];
    if (!result) continue;
    const fallbackUsed = result.fallback_used ?? false;
    waves.push({
      wave,
      cost: result.cost,
      turns: result.turns,
      duration: result.duration,
      model: result.model,
      provider: result.provider,
      fallback_used: fallbackUsed || undefined,
      ...(result.structured_output_metrics != null && {
        structured_output_metrics: result.structured_output_metrics,
      }),
    });
    totalCost += result.cost;
    totalTurns += result.turns;
    totalDuration += result.duration;

    // Per-provider cost aggregation
    const providerKey = result.provider ?? 'unknown';
    providerCosts[providerKey] = (providerCosts[providerKey] ?? 0) + result.cost;

    // Classify cost as API or local — undefined provider treated as API (backward compat)
    if (result.provider && isLocalProvider(result.provider)) {
      localCost += result.cost;
    } else {
      apiCost += result.cost;
    }

    if (fallbackUsed) {
      fallbackCount++;
      // When fallback was used, the local attempt cost is tracked separately
      localCost += result.local_attempt_cost ?? 0;
    }
  }
  return {
    issueNumber: state.issue.number,
    totalCost,
    apiCost,
    localCost,
    totalTurns,
    totalDuration,
    waves,
    providerCosts,
    fallbackCount,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
    sandboxResourceUsage: state.sandboxResourceUsage,
  };
}

export async function writeCostReport(workDir: string, report: CostReport): Promise<void> {
  const kovaDir = join(workDir, '.kova');
  await mkdir(kovaDir, { recursive: true });
  await writeFile(join(kovaDir, 'cost-report.json'), JSON.stringify(report, null, 2));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function printRunSummary(report: CostReport): void {
  log.info('');
  log.info('=== Run Summary ===');
  log.info(`Issue:    #${report.issueNumber}`);
  log.info(`Cost:     $${report.totalCost.toFixed(2)}`);
  const providerKeys = Object.keys(report.providerCosts ?? {});
  if (providerKeys.length > 1) {
    for (const provider of providerKeys.sort()) {
      const cost = report.providerCosts[provider] ?? 0;
      log.info(`  ${provider.padEnd(8)} $${cost.toFixed(2)}`);
    }
  } else if (report.apiCost > 0 || report.localCost > 0) {
    log.info(`  API:    $${report.apiCost.toFixed(2)}`);
    log.info(`  Local:  $${report.localCost.toFixed(2)}`);
  }
  log.info(`Turns:    ${report.totalTurns}`);
  log.info(`Duration: ${formatDuration(report.totalDuration)}`);
  if (report.fallbackCount > 0) {
    log.info(`Fallbacks: ${report.fallbackCount} (local cost: $${report.localCost.toFixed(2)})`);
  }
  if (report.sandboxResourceUsage) {
    const usage = report.sandboxResourceUsage;
    log.info('');
    log.info('Sandbox Resources:');
    log.info(`  Container: ${usage.containerName}`);
    log.info(`  Peak Mem:  ${usage.peakMemoryMB.toFixed(0)} MB`);
    log.info(`  CPU Time:  ${usage.cpuSeconds.toFixed(1)}s`);
    log.info(`  Wall Time: ${formatDuration(usage.wallTimeMs)}`);
    log.info(
      `  Limits:    ${usage.limitsApplied.cpus} CPUs, ${usage.limitsApplied.memory} mem, ${usage.limitsApplied.timeout} timeout`,
    );
  }
  if (report.waves.length > 0) {
    log.info('');
    log.info('Per-wave breakdown:');
    for (const wave of report.waves) {
      const model = wave.model ? ` (${wave.model})` : '';
      const provider = wave.provider ? ` [${wave.provider}]` : '';
      const fallback = wave.fallback_used ? ' [fallback]' : '';
      log.info(
        '  ' +
          wave.wave.padEnd(8) +
          ' $' +
          wave.cost.toFixed(2) +
          '  ' +
          wave.turns +
          ' turns  ' +
          formatDuration(wave.duration) +
          model +
          provider +
          fallback,
      );
    }
  }
}
