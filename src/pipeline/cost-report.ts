import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixState, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface CostReport {
  issueNumber: number;
  totalCost: number;
  totalTurns: number;
  totalDuration: number;
  waves: Array<{ wave: string; cost: number; turns: number; duration: number; model?: string | undefined }>;
  startedAt: string;
  completedAt: string;
}

const WAVE_ORDER: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];

export function buildCostReport(state: FixState): CostReport {
  const waves: CostReport['waves'] = [];
  let totalCost = 0;
  let totalTurns = 0;
  let totalDuration = 0;
  for (const wave of WAVE_ORDER) {
    const result = state.waveResults[wave];
    if (!result) continue;
    waves.push({ wave, cost: result.cost, turns: result.turns, duration: result.duration, model: result.model });
    totalCost += result.cost;
    totalTurns += result.turns;
    totalDuration += result.duration;
  }
  return {
    issueNumber: state.issue.number,
    totalCost,
    totalTurns,
    totalDuration,
    waves,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
  };
}

export async function writeCostReport(workDir: string, report: CostReport): Promise<void> {
  const kovaDir = join(workDir, '.kova');
  await mkdir(kovaDir, { recursive: true });
  await writeFile(join(kovaDir, 'cost-report.json'), JSON.stringify(report, null, 2));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes + 'm ' + remaining + 's';
}

export function printRunSummary(report: CostReport): void {
  log.info('');
  log.info('=== Run Summary ===');
  log.info('Issue:    #' + report.issueNumber);
  log.info('Cost:     $' + report.totalCost.toFixed(2));
  log.info('Turns:    ' + report.totalTurns);
  log.info('Duration: ' + formatDuration(report.totalDuration));
  if (report.waves.length > 0) {
    log.info('');
    log.info('Per-wave breakdown:');
    for (const wave of report.waves) {
      const model = wave.model ? ' (' + wave.model + ')' : '';
      log.info(
        '  ' +
          wave.wave.padEnd(8) +
          ' $' +
          wave.cost.toFixed(2) +
          '  ' +
          wave.turns +
          ' turns  ' +
          formatDuration(wave.duration) +
          model,
      );
    }
  }
}
