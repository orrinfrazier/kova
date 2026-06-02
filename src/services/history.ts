import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from '../utils/logger.js';

const HistoryIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  success: z.boolean(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Per-wave structured-output metrics recorded with each run (issue #247).
 * Aggregated per history entry so `kova history --stats` can compute success
 * rates by parse method and by model across many runs.
 */
const HistoryStructuredOutputMetricsSchema = z.object({
  parse_method: z
    .enum([
      'json-tag',
      'json-tag-repaired',
      'markdown-fence',
      'markdown-fence-repaired',
      'direct-parse',
      'direct-parse-repaired',
    ])
    .nullable()
    .optional(),
  attempts: z.number().int().min(0),
  success: z.boolean(),
  repair_attempts: z.number().int().min(0),
  /** Model id used for this wave (for per-model success-rate breakdowns). */
  model: z.string().optional(),
});

/**
 * Per-run causal telemetry fields (issue #266). Mirrors what the episodic
 * vectordb already captures (diagnosis/thrashing/quality_gates/failed_at_wave)
 * so cross-run analytics over `history.jsonl` can break success rates down by
 * grade, diagnosis, and which gates failed — not just by cost/outcome.
 *
 * All fields are OPTIONAL so legacy history.jsonl lines (pre-#266) still
 * parse via `readHistory`.
 */
export const HistoryGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type HistoryGrade = z.infer<typeof HistoryGradeSchema>;

export const HistoryDiagnosisSchema = z.enum(['SPEC_WRONG', 'APPROACH_WRONG', 'MISSING_CONTEXT', 'STUCK']);
export type HistoryDiagnosis = z.infer<typeof HistoryDiagnosisSchema>;

export const HistoryThrashingSchema = z.enum(['SAME_FILES', 'DIFFERENT_FILES', 'NORMAL', 'INSUFFICIENT_DATA']);
export type HistoryThrashing = z.infer<typeof HistoryThrashingSchema>;

/**
 * Per-run tool-call telemetry (issue #278). Captures how many tool calls the
 * agent ran for THIS history entry. The retrieval-quality eval harness reads
 * this to compute the on-vs-off delta — does injected codebase context reduce
 * the agent's own tool calls?
 *
 * `reads` mirrors `byTool.Read` (file reads dominate retrieval cost, so it's
 * surfaced as a first-class metric).
 */
export const HistoryToolCallCountsSchema = z.object({
  total: z.number().int().min(0),
  reads: z.number().int().min(0),
  byTool: z.record(z.string(), z.number().int().min(0)),
});
export type HistoryToolCallCounts = z.infer<typeof HistoryToolCallCountsSchema>;

export const HistoryEntrySchema = z.object({
  timestamp: z.string(),
  repo: z.string(),
  issues: z.array(HistoryIssueSchema),
  prsCreated: z.number(),
  cost: z.number(),
  duration: z.number(),
  outcome: z.enum(['success', 'partial', 'failure']),
  promptHashes: z.record(z.string(), z.string()).optional(),
  abTestVariants: z.record(z.string(), z.string()).optional(),
  /**
   * Which arm of the retrieval-quality eval this run is part of (issue #278).
   * `on` = codebaseContext injected; `off` = control. Omitted when the run
   * is not an eval run (legacy + production runs).
   */
  contextArm: z.enum(['on', 'off']).optional(),
  /**
   * Per-run aggregated tool-call counts (issue #278). Populated by
   * `spawnWaveAgent` when the wave instruments a `ToolCallCounter`.
   */
  toolCallCounts: HistoryToolCallCountsSchema.optional(),
  /**
   * Per-wave structured-output extraction telemetry (issue #247). Keyed by
   * wave name (e.g. `assess`, `spec`, `review`). Backward-compatible: legacy
   * history entries without this field still validate.
   */
  structuredOutputMetrics: z.record(z.string(), HistoryStructuredOutputMetricsSchema).optional(),
  /** Assessment grade for this run (issue #266). Optional for back-compat. */
  grade: HistoryGradeSchema.optional(),
  /** Final TI-loop diagnosis when the run failed or escalated (issue #266). */
  diagnosis: HistoryDiagnosisSchema.optional(),
  /** Thrashing signal from impl loop (issue #266). */
  thrashingSignal: HistoryThrashingSchema.optional(),
  /** Names of quality gates that failed (e.g. ['lint', 'tests']) (issue #266). */
  gatesFailed: z.array(z.string()).optional(),
  /** True iff the run shipped on the first impl attempt with all gates green (issue #266). */
  firstPassQuality: z.boolean().optional(),
  /** Number of impl retries the orchestrator ran before success/failure (issue #266). */
  retryAttempts: z.number().int().min(0).optional(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryStructuredOutputMetric = z.infer<typeof HistoryStructuredOutputMetricsSchema>;

export interface HistoryStats {
  totalRuns: number;
  totalCost: number;
  successRate: number;
  avgDuration: number;
  totalIssuesAttempted: number;
  totalPrsCreated: number;
  /**
   * Success-by-grade breakdown (issue #266). Only present when at least one
   * entry carries a `grade`. `success` counts entries with `outcome==='success'`
   * (partial/failure both count toward `total` but not `success`).
   */
  byGrade?: Partial<Record<HistoryGrade, { total: number; success: number }>>;
  /**
   * Diagnosis frequency across runs (issue #266). Only present when at least
   * one entry carries a `diagnosis`.
   */
  byDiagnosis?: Partial<Record<HistoryDiagnosis, number>>;
}

function historyPath(repoPath: string): string {
  return join(repoPath, '.kova', 'history.jsonl');
}

export async function appendHistoryEntry(repoPath: string, entry: HistoryEntry): Promise<void> {
  const filePath = historyPath(repoPath);
  await mkdir(join(repoPath, '.kova'), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

export async function readHistory(repoPath: string, options?: { repo?: string }): Promise<HistoryEntry[]> {
  const filePath = historyPath(repoPath);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      } else {
        log.debug(`Skipping malformed history line: ${line.slice(0, 80)}`);
      }
    } catch {
      log.debug(`Skipping unparseable history line: ${line.slice(0, 80)}`);
    }
  }

  if (options?.repo) {
    return entries.filter((e) => e.repo === options.repo);
  }

  return entries;
}

export function computeStats(entries: HistoryEntry[]): HistoryStats {
  if (entries.length === 0) {
    return {
      totalRuns: 0,
      totalCost: 0,
      successRate: 0,
      avgDuration: 0,
      totalIssuesAttempted: 0,
      totalPrsCreated: 0,
    };
  }

  const totalRuns = entries.length;
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const successCount = entries.filter((e) => e.outcome === 'success').length;
  const successRate = (successCount / totalRuns) * 100;
  const avgDuration = entries.reduce((sum, e) => sum + e.duration, 0) / totalRuns;
  const totalIssuesAttempted = entries.reduce((sum, e) => sum + e.issues.length, 0);
  const totalPrsCreated = entries.reduce((sum, e) => sum + e.prsCreated, 0);

  // Optional breakdowns (issue #266). Only emit when at least one entry carries
  // the relevant field — otherwise callers reading legacy data see a clean
  // zero-state and don't get spurious empty objects.
  const byGrade: Partial<Record<HistoryGrade, { total: number; success: number }>> = {};
  const byDiagnosis: Partial<Record<HistoryDiagnosis, number>> = {};
  let sawGrade = false;
  let sawDiagnosis = false;

  for (const e of entries) {
    if (e.grade != null) {
      sawGrade = true;
      const bucket = byGrade[e.grade] ?? { total: 0, success: 0 };
      bucket.total += 1;
      if (e.outcome === 'success') bucket.success += 1;
      byGrade[e.grade] = bucket;
    }
    if (e.diagnosis != null) {
      sawDiagnosis = true;
      byDiagnosis[e.diagnosis] = (byDiagnosis[e.diagnosis] ?? 0) + 1;
    }
  }

  const stats: HistoryStats = {
    totalRuns,
    totalCost,
    successRate,
    avgDuration,
    totalIssuesAttempted,
    totalPrsCreated,
  };
  if (sawGrade) stats.byGrade = byGrade;
  if (sawDiagnosis) stats.byDiagnosis = byDiagnosis;
  return stats;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function formatHistoryTable(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'No history entries found.';

  const lines: string[] = [
    '| Date       | Repo       | Issues | PRs | Cost   | Duration | Outcome |',
    '|------------|------------|--------|-----|--------|----------|---------|',
  ];

  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const repo = entry.repo.slice(0, 10).padEnd(10);
    const issues = String(entry.issues.length).padStart(6);
    const prs = String(entry.prsCreated).padStart(3);
    const cost = `$${entry.cost.toFixed(2)}`.padStart(6);
    const duration = formatDuration(entry.duration).padStart(8);
    lines.push(`| ${date} | ${repo} | ${issues} | ${prs} | ${cost} | ${duration} | ${entry.outcome.padEnd(7)} |`);
  }

  return lines.join('\n');
}

export interface StructuredOutputModelStats {
  /** Total parse attempts attributable to this model. */
  total: number;
  /** Parses that ultimately produced a valid value. */
  success: number;
  /** Repair turns this model needed in aggregate. */
  repairAttempts: number;
}

export interface StructuredOutputStats {
  totalAttempts: number;
  successfulParses: number;
  /** 0..100 success rate as a percentage. */
  successRate: number;
  /** Repair turns used across all runs. */
  totalRepairAttempts: number;
  /** Count of successful parses bucketed by parse method. */
  byMethod: Record<string, number>;
  /** Per-model aggregates. Omitted entirely when no entry has a model id. */
  byModel?: Record<string, StructuredOutputModelStats>;
}

/**
 * Aggregate structured-output extraction telemetry across history entries
 * (issue #247). Returns a zero-state object when no entry has metrics. Pure
 * function (no I/O).
 */
export function computeStructuredOutputStats(entries: HistoryEntry[]): StructuredOutputStats {
  const stats: StructuredOutputStats = {
    totalAttempts: 0,
    successfulParses: 0,
    successRate: 0,
    totalRepairAttempts: 0,
    byMethod: {},
  };

  const byModel: Record<string, StructuredOutputModelStats> = {};
  let sawModel = false;

  for (const entry of entries) {
    const metrics = entry.structuredOutputMetrics;
    if (!metrics) continue;
    for (const m of Object.values(metrics)) {
      stats.totalAttempts += 1;
      stats.totalRepairAttempts += m.repair_attempts;
      if (m.success) {
        stats.successfulParses += 1;
        if (m.parse_method) {
          stats.byMethod[m.parse_method] = (stats.byMethod[m.parse_method] ?? 0) + 1;
        }
      }
      if (m.model) {
        sawModel = true;
        const bucket = byModel[m.model] ?? { total: 0, success: 0, repairAttempts: 0 };
        bucket.total += 1;
        if (m.success) bucket.success += 1;
        bucket.repairAttempts += m.repair_attempts;
        byModel[m.model] = bucket;
      }
    }
  }

  stats.successRate = stats.totalAttempts > 0 ? (stats.successfulParses / stats.totalAttempts) * 100 : 0;
  if (sawModel) stats.byModel = byModel;

  return stats;
}

export function formatStatsTable(stats: HistoryStats, entries?: HistoryEntry[]): string {
  const lines: string[] = [
    '| Metric               | Value    |',
    '|----------------------|----------|',
    `| Total runs           | ${stats.totalRuns} |`,
    `| Total cost           | $${stats.totalCost.toFixed(2)} |`,
    `| Success rate         | ${stats.successRate.toFixed(1)}% |`,
    `| Avg duration         | ${formatDuration(stats.avgDuration)} |`,
    `| Issues attempted     | ${stats.totalIssuesAttempted} |`,
    `| PRs created          | ${stats.totalPrsCreated} |`,
  ];

  // Structured-output extraction section (issue #247). Only rendered when
  // the caller supplied entries AND at least one entry has metrics.
  if (entries) {
    const soStats = computeStructuredOutputStats(entries);
    if (soStats.totalAttempts > 0) {
      lines.push('');
      lines.push('## Structured Output');
      lines.push('| Metric               | Value    |');
      lines.push('|----------------------|----------|');
      lines.push(`| Parse attempts       | ${soStats.totalAttempts} |`);
      lines.push(`| Successful parses    | ${soStats.successfulParses} |`);
      lines.push(`| Parse success rate   | ${soStats.successRate.toFixed(1)}% |`);
      lines.push(`| Repair turns used    | ${soStats.totalRepairAttempts} |`);
      const methods = Object.entries(soStats.byMethod).sort((a, b) => b[1] - a[1]);
      if (methods.length > 0) {
        lines.push('');
        lines.push('### By parse method');
        lines.push('| Method                  | Count |');
        lines.push('|-------------------------|-------|');
        for (const [method, count] of methods) {
          lines.push(`| ${method.padEnd(23)} | ${String(count).padStart(5)} |`);
        }
      }
      if (soStats.byModel) {
        const modelEntries = Object.entries(soStats.byModel).sort((a, b) => b[1].total - a[1].total);
        if (modelEntries.length > 0) {
          lines.push('');
          lines.push('### By model');
          lines.push('| Model                       | Attempts | Success | Repairs |');
          lines.push('|-----------------------------|----------|---------|---------|');
          for (const [model, agg] of modelEntries) {
            const rate = agg.total > 0 ? ((agg.success / agg.total) * 100).toFixed(0) : '0';
            lines.push(
              `| ${model.padEnd(27)} | ${String(agg.total).padStart(8)} | ${String(`${agg.success} (${rate}%)`).padStart(7)} | ${String(agg.repairAttempts).padStart(7)} |`,
            );
          }
        }
      }
    }
  }

  return lines.join('\n');
}
