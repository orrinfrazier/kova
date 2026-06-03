import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HistoryEntry, readHistory } from '../telemetry/history.js';
import { analyzeReflect, formatReflectReport, parseSinceFlag } from './reflect.js';

function entryJson(o: HistoryEntry): string {
  return `${JSON.stringify(o)}\n`;
}
function mk(over?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: '2026-05-01T10:00:00.000Z',
    repo: 'test-repo',
    issues: [{ number: 1, title: 'X', success: true }],
    prsCreated: 1,
    cost: 0.5,
    duration: 1000,
    outcome: 'success',
    ...over,
  };
}

describe('reflect — fixture integration', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-reflect-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns empty report when no history file exists', async () => {
    const entries = await readHistory(workDir);
    const report = analyzeReflect(entries);
    expect(report.empty).toBe(true);
    const text = formatReflectReport(report, { path: workDir });
    expect(text).toContain('No telemetry');
  });

  it('reads history.jsonl and produces report (--since respected)', async () => {
    await mkdir(join(workDir, '.kova'), { recursive: true });
    const fp = join(workDir, '.kova', 'history.jsonl');
    await appendFile(
      fp,
      entryJson(
        mk({
          timestamp: '2026-01-01T00:00:00.000Z',
          outcome: 'failure',
          issues: [{ number: 1, title: 'A', success: false, error: 'lint failed' }],
        }),
      ),
    );
    await appendFile(fp, entryJson(mk({ timestamp: '2026-05-20T00:00:00.000Z', outcome: 'success' })));
    await appendFile(fp, entryJson(mk({ timestamp: '2026-05-20T00:00:00.000Z', outcome: 'success' })));
    const entries = await readHistory(workDir);
    expect(entries).toHaveLength(3);

    const since = parseSinceFlag('30d', new Date('2026-06-01T00:00:00.000Z'));
    const report = analyzeReflect(entries, since ? { since } : undefined);
    expect(report.totalRuns).toBe(2); // jan entry filtered out
    expect(report.patterns.successRate).toBe(100);

    const fullReport = analyzeReflect(entries);
    expect(fullReport.totalRuns).toBe(3);
  });
});
