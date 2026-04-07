// Status dashboard — show per-repo stats across all configured repos.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchKovaPRs, fetchOpenIssueCount } from '../services/github.js';
import type { QueueStatus } from '../services/priority-queue.js';
import type { KovaConfig } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface RepoStatus {
  name: string;
  path: string;
  openIssues: number;
  kovaPRs: number;
  lastRunDate: string | null;
  totalSpend: number;
}

export interface StatusResult {
  repos: RepoStatus[];
  totalSpend: number;
  queue?: QueueStatus | undefined;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as unknown;
}

interface RunReportJson {
  totalCost?: number;
  completedAt?: string;
}

interface CostReportJson {
  totalCost?: number;
  completedAt?: string;
}

async function readKovaFiles(repoPath: string): Promise<{ lastRunDate: string | null; totalSpend: number }> {
  let lastRunDate: string | null = null;
  let totalSpend = 0;

  // Try run-report.json first (loop-level aggregate)
  try {
    const report = (await readJsonFile(join(repoPath, '.kova', 'run-report.json'))) as RunReportJson;
    if (report.completedAt) lastRunDate = report.completedAt;
    if (typeof report.totalCost === 'number') totalSpend = report.totalCost;
    return { lastRunDate, totalSpend };
  } catch {
    // No run-report.json, try cost-report.json
  }

  // Fall back to cost-report.json (single-fix)
  try {
    const report = (await readJsonFile(join(repoPath, '.kova', 'cost-report.json'))) as CostReportJson;
    if (report.completedAt) lastRunDate = report.completedAt;
    if (typeof report.totalCost === 'number') totalSpend = report.totalCost;
  } catch {
    // No .kova files at all
  }

  return { lastRunDate, totalSpend };
}

export async function gatherRepoStatus(name: string, repoPath: string): Promise<RepoStatus> {
  const [issueResult, prResult, kovaFiles] = await Promise.all([
    fetchOpenIssueCount(repoPath).catch(() => -1),
    fetchKovaPRs(repoPath).catch(() => null),
    readKovaFiles(repoPath),
  ]);

  return {
    name,
    path: repoPath,
    openIssues: issueResult,
    kovaPRs: prResult === null ? -1 : prResult.length,
    lastRunDate: kovaFiles.lastRunDate,
    totalSpend: kovaFiles.totalSpend,
  };
}

export async function gatherStatus(config: KovaConfig): Promise<StatusResult> {
  const entries = Object.entries(config.repos);
  const repos = await Promise.all(entries.map(([name, repo]) => gatherRepoStatus(name, repo.path)));

  const totalSpend = repos.reduce((sum, r) => sum + r.totalSpend, 0);

  return { repos, totalSpend };
}

function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatStatusTable(result: StatusResult): string {
  const headers = ['Repo', 'Open Issues', 'Kova PRs', 'Last Run', 'Spend'];
  const rows: string[][] = result.repos.map((r) => [
    r.name,
    r.openIssues === -1 ? 'ERR' : String(r.openIssues),
    r.kovaPRs === -1 ? 'ERR' : String(r.kovaPRs),
    r.lastRunDate ? formatRelativeDate(r.lastRunDate) : '\u2014',
    r.totalSpend > 0 ? `$${r.totalSpend.toFixed(2)}` : '\u2014',
  ]);

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxDataWidth = Math.max(...rows.map((row) => (row[i] ?? '').length), 0);
    return Math.max(h.length, maxDataWidth);
  });

  const headerLine = headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  ');
  const separatorLine = widths.map((w) => '\u2500'.repeat(w)).join('  ');
  const dataLines = rows.map((row) => row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join('  '));

  const lines = [
    'Kova Status Dashboard',
    '',
    headerLine,
    separatorLine,
    ...dataLines,
    separatorLine,
    `Total: $${result.totalSpend.toFixed(2)}`,
  ];

  if (result.queue) {
    lines.push('', formatQueueTable(result.queue));
  }

  return lines.join('\n');
}

export function formatQueueTable(queue: QueueStatus): string {
  const lines: string[] = [`Queue (${queue.activeSlots}/${queue.maxSlots} slots active)`];
  lines.push('');

  if (queue.entries.length === 0) {
    lines.push('  (empty)');
    return lines.join('\n');
  }

  const headers = ['Issue', 'Score', 'Status', 'Failures', 'Blocked By'];
  const rows: string[][] = queue.entries.map((e) => {
    const blockers = e.request.blockedBy.length > 0 ? e.request.blockedBy.map((b) => `#${b}`).join(', ') : '\u2014';
    return [
      `#${e.request.issueNumber}`,
      String(e.request.score),
      e.status,
      e.consecutiveFailures > 0 ? String(e.consecutiveFailures) : '\u2014',
      blockers,
    ];
  });

  const widths = headers.map((h, i) => {
    const maxDataWidth = Math.max(...rows.map((row) => (row[i] ?? '').length), 0);
    return Math.max(h.length, maxDataWidth);
  });

  const headerLine = headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  ');
  const separatorLine = widths.map((w) => '\u2500'.repeat(w)).join('  ');
  const dataLines = rows.map((row) => row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join('  '));

  lines.push(headerLine, separatorLine, ...dataLines, separatorLine);

  const counts: string[] = [];
  if (queue.completedCount > 0) counts.push(`${queue.completedCount} completed`);
  if (queue.skippedCount > 0) counts.push(`${queue.skippedCount} skipped`);
  if (queue.failedCount > 0) counts.push(`${queue.failedCount} failed`);
  if (counts.length > 0) {
    lines.push(counts.join(', '));
  }

  return lines.join('\n');
}

export function printStatusDashboard(result: StatusResult): void {
  log.info('');
  const table = formatStatusTable(result);
  for (const line of table.split('\n')) {
    log.info(line);
  }
  log.info('');
}
