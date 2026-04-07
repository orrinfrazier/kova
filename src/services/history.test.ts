import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistoryEntry,
  computeStats,
  formatHistoryTable,
  formatStatsTable,
  type HistoryEntry,
  HistoryEntrySchema,
  readHistory,
} from './history.js';

function makeEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: '2026-01-15T10:00:00.000Z',
    repo: 'test-repo',
    issues: [{ number: 1, title: 'Fix bug', success: true, prUrl: 'https://github.com/test/repo/pull/10' }],
    prsCreated: 1,
    cost: 0.5,
    duration: 60000,
    outcome: 'success',
    ...overrides,
  };
}

describe('HistoryEntrySchema', () => {
  it('validates a valid entry', () => {
    const entry = makeEntry();
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects entry missing required fields', () => {
    const result = HistoryEntrySchema.safeParse({ timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });

  it('validates entry with multiple issues', () => {
    const entry = makeEntry({
      issues: [
        { number: 1, title: 'Fix A', success: true, prUrl: 'https://example.com/pull/1' },
        { number: 2, title: 'Fix B', success: false, error: 'Grade D' },
      ],
      prsCreated: 1,
      outcome: 'partial',
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('validates entry with failure outcome', () => {
    const entry = makeEntry({
      issues: [{ number: 5, title: 'Broken', success: false, error: 'impl failed' }],
      prsCreated: 0,
      cost: 1.2,
      outcome: 'failure',
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('validates entry with abTestVariants', () => {
    const entry = makeEntry({
      abTestVariants: { assess: 'v1', spec: 'v2' },
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.abTestVariants).toEqual({ assess: 'v1', spec: 'v2' });
    }
  });

  it('validates entry without abTestVariants (backward compat)', () => {
    const entry = makeEntry();
    // No abTestVariants field
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.abTestVariants).toBeUndefined();
    }
  });
});

describe('appendHistoryEntry', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-history-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates history.jsonl when it does not exist', async () => {
    const entry = makeEntry();
    await appendHistoryEntry(workDir, entry);

    const content = await readFile(join(workDir, '.kova', 'history.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as HistoryEntry;
    expect(parsed.repo).toBe('test-repo');
    expect(parsed.cost).toBe(0.5);
  });

  it('appends to existing history.jsonl', async () => {
    const entry1 = makeEntry({ timestamp: '2026-01-15T10:00:00.000Z' });
    const entry2 = makeEntry({ timestamp: '2026-01-16T10:00:00.000Z', cost: 1.0 });
    await appendHistoryEntry(workDir, entry1);
    await appendHistoryEntry(workDir, entry2);

    const content = await readFile(join(workDir, '.kova', 'history.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed1 = JSON.parse(lines[0] ?? '') as HistoryEntry;
    const parsed2 = JSON.parse(lines[1] ?? '') as HistoryEntry;
    expect(parsed1.cost).toBe(0.5);
    expect(parsed2.cost).toBe(1.0);
  });
});

describe('readHistory', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kova-history-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns empty array when no history file exists', async () => {
    const entries = await readHistory(workDir);
    expect(entries).toEqual([]);
  });

  it('reads all entries from history file', async () => {
    await appendHistoryEntry(workDir, makeEntry({ cost: 0.5 }));
    await appendHistoryEntry(workDir, makeEntry({ cost: 1.0 }));
    await appendHistoryEntry(workDir, makeEntry({ cost: 2.0 }));

    const entries = await readHistory(workDir);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.cost).toBe(0.5);
    expect(entries[2]?.cost).toBe(2.0);
  });

  it('filters by repo name', async () => {
    await appendHistoryEntry(workDir, makeEntry({ repo: 'alpha' }));
    await appendHistoryEntry(workDir, makeEntry({ repo: 'beta' }));
    await appendHistoryEntry(workDir, makeEntry({ repo: 'alpha' }));

    const entries = await readHistory(workDir, { repo: 'alpha' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.repo === 'alpha')).toBe(true);
  });

  it('skips malformed JSONL lines gracefully', async () => {
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(workDir, '.kova'), { recursive: true });
    const filePath = join(workDir, '.kova', 'history.jsonl');
    const validEntry = JSON.stringify(makeEntry());
    await appendFile(filePath, `${validEntry}\n`);
    await appendFile(filePath, 'NOT VALID JSON\n');
    await appendFile(filePath, `${JSON.stringify(makeEntry({ cost: 9.9 }))}\n`);

    const entries = await readHistory(workDir);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.cost).toBe(9.9);
  });
});

describe('computeStats', () => {
  it('returns zero stats for empty entries', () => {
    const stats = computeStats([]);
    expect(stats.totalRuns).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.avgDuration).toBe(0);
    expect(stats.totalIssuesAttempted).toBe(0);
    expect(stats.totalPrsCreated).toBe(0);
  });

  it('computes aggregate stats correctly', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ cost: 0.5, duration: 60000, outcome: 'success', prsCreated: 1 }),
      makeEntry({ cost: 1.0, duration: 120000, outcome: 'failure', prsCreated: 0 }),
      makeEntry({ cost: 0.8, duration: 90000, outcome: 'success', prsCreated: 1 }),
    ];

    const stats = computeStats(entries);
    expect(stats.totalRuns).toBe(3);
    expect(stats.totalCost).toBeCloseTo(2.3);
    expect(stats.successRate).toBeCloseTo(66.67, 1);
    expect(stats.avgDuration).toBeCloseTo(90000);
    expect(stats.totalPrsCreated).toBe(2);
  });

  it('treats partial outcome as not fully successful', () => {
    const entries: HistoryEntry[] = [makeEntry({ outcome: 'success' }), makeEntry({ outcome: 'partial' })];

    const stats = computeStats(entries);
    expect(stats.successRate).toBeCloseTo(50);
  });
});

describe('formatHistoryTable', () => {
  it('formats entries as a readable table', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        timestamp: '2026-01-15T10:00:00.000Z',
        repo: 'kova',
        issues: [{ number: 1, title: 'Fix bug', success: true }],
        cost: 0.5,
        duration: 65000,
        outcome: 'success',
      }),
    ];

    const table = formatHistoryTable(entries);
    expect(table).toContain('2026-01-15');
    expect(table).toContain('kova');
    expect(table).toContain('success');
    expect(table).toContain('$0.50');
  });

  it('returns a message when no entries', () => {
    const table = formatHistoryTable([]);
    expect(table).toContain('No history');
  });
});

describe('formatStatsTable', () => {
  it('formats stats as a readable summary', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ cost: 0.5, duration: 60000, outcome: 'success', prsCreated: 1 }),
      makeEntry({ cost: 1.0, duration: 120000, outcome: 'failure', prsCreated: 0 }),
    ];

    const stats = computeStats(entries);
    const table = formatStatsTable(stats);
    expect(table).toContain('Total runs');
    expect(table).toContain('Total cost');
    expect(table).toContain('Success rate');
    expect(table).toContain('$1.50');
  });
});
