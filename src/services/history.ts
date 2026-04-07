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

export const HistoryEntrySchema = z.object({
  timestamp: z.string(),
  repo: z.string(),
  issues: z.array(HistoryIssueSchema),
  prsCreated: z.number(),
  cost: z.number(),
  duration: z.number(),
  outcome: z.enum(['success', 'partial', 'failure']),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export interface HistoryStats {
  totalRuns: number;
  totalCost: number;
  successRate: number;
  avgDuration: number;
  totalIssuesAttempted: number;
  totalPrsCreated: number;
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

  return { totalRuns, totalCost, successRate, avgDuration, totalIssuesAttempted, totalPrsCreated };
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

export function formatStatsTable(stats: HistoryStats): string {
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

  return lines.join('\n');
}
