import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WaveName, WaveResult } from '../types/index.js';
import { log } from '../utils/logger.js';
import type { LoopResult } from './loop.js';

export interface RunReportIssue {
  number: number;
  title: string;
  success: boolean;
  prUrl?: string | undefined;
  error?: string | undefined;
  cost: number;
  turns: number;
  duration: number;
}

export interface RunReport {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalCost: number;
  totalTurns: number;
  totalDuration: number;
  budgetExceeded: boolean;
  issues: RunReportIssue[];
  startedAt: string;
  completedAt: string;
}

function sumWaveField(
  waveResults: Partial<Record<WaveName, WaveResult>>,
  field: 'cost' | 'turns' | 'duration',
): number {
  let total = 0;
  for (const result of Object.values(waveResults)) {
    if (result) {
      total += result[field];
    }
  }
  return total;
}

export function buildRunReport(loopResult: LoopResult): RunReport {
  const issues: RunReportIssue[] = loopResult.results.map(({ issue, result }) => ({
    number: issue.number,
    title: issue.title,
    success: result.success,
    prUrl: result.prUrl,
    error: result.error,
    cost: sumWaveField(result.state.waveResults, 'cost'),
    turns: sumWaveField(result.state.waveResults, 'turns'),
    duration: sumWaveField(result.state.waveResults, 'duration'),
  }));

  return {
    total: loopResult.total,
    succeeded: loopResult.succeeded,
    failed: loopResult.failed,
    skipped: loopResult.skipped,
    totalCost: loopResult.totalCost,
    totalTurns: loopResult.totalTurns,
    totalDuration: loopResult.totalDuration,
    budgetExceeded: loopResult.budgetExceeded,
    issues,
    startedAt: loopResult.startedAt,
    completedAt: new Date().toISOString(),
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

export async function writeRunReport(workDir: string, report: RunReport): Promise<void> {
  const kovaDir = join(workDir, '.kova');
  await mkdir(kovaDir, { recursive: true });
  await writeFile(join(kovaDir, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(kovaDir, 'run-report.md'), renderMarkdown(report));
}

function renderMarkdown(report: RunReport): string {
  const lines: string[] = [
    '# Kova Run Report',
    '',
    `**${report.succeeded}/${report.total} succeeded** | ${report.failed} failed | ${report.skipped} skipped`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| **Total cost** | $${report.totalCost.toFixed(2)} |`,
    `| **Total duration** | ${formatDuration(report.totalDuration)} |`,
    `| **Total turns** | ${report.totalTurns} |`,
    '',
    '## Per-Issue Breakdown',
    '',
    '| Issue | Status | Cost | Duration | PR |',
    '|-------|--------|------|----------|-----|',
  ];

  for (const issue of report.issues) {
    const status = issue.success ? 'OK' : 'FAIL';
    const pr = issue.prUrl ? `[PR](${issue.prUrl})` : '\u2014';
    lines.push(
      `| #${issue.number} ${escapeTableCell(issue.title)} | ${status} | $${issue.cost.toFixed(2)} | ${formatDuration(issue.duration)} | ${pr} |`,
    );
  }

  const failures = report.issues.filter((i) => !i.success);
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const f of failures) {
      lines.push(`- **#${f.number} ${f.title}**: ${f.error ?? 'Unknown error'}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function printRunReport(report: RunReport): void {
  log.info('');
  log.info('=== Auto Mode Run Report ===');
  log.info(`${report.succeeded} succeeded, ${report.failed} failed, ${report.skipped} skipped (${report.total} total)`);
  log.info(
    `Total cost: $${report.totalCost.toFixed(2)} | ${report.totalTurns} turns | ${formatDuration(report.totalDuration)}`,
  );
  log.info('');
  log.info('Per-issue breakdown:');
  for (const issue of report.issues) {
    const status = issue.success ? 'OK  ' : 'FAIL';
    const pr = issue.prUrl ? ` \u2192 ${issue.prUrl}` : '';
    const err = issue.error ? ` \u2014 ${issue.error}` : '';
    log.info(
      `  #${issue.number} [${status}] $${issue.cost.toFixed(2)}  ${formatDuration(issue.duration)}  ${issue.title}${pr}${err}`,
    );
  }
}
