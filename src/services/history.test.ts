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

  // Issue #278: retrieval-quality eval harness extension.
  it('validates entry with contextArm and toolCallCounts (issue #278)', () => {
    const entry = makeEntry({
      contextArm: 'on',
      toolCallCounts: { total: 12, reads: 8, byTool: { Read: 8, Grep: 3, Edit: 1 } },
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextArm).toBe('on');
      expect(result.data.toolCallCounts?.total).toBe(12);
      expect(result.data.toolCallCounts?.reads).toBe(8);
      expect(result.data.toolCallCounts?.byTool.Read).toBe(8);
    }
  });

  it('accepts contextArm: "off" as the control variant (issue #278)', () => {
    const entry = makeEntry({ contextArm: 'off' });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextArm).toBe('off');
    }
  });

  it('rejects unknown contextArm values (issue #278)', () => {
    const entry = makeEntry({ contextArm: 'maybe' as unknown as 'on' });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('validates entry without contextArm/toolCallCounts (backward compat, issue #278)', () => {
    const entry = makeEntry();
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextArm).toBeUndefined();
      expect(result.data.toolCallCounts).toBeUndefined();
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

describe('structured output metrics — issue #247', () => {
  it('HistoryEntrySchema accepts structuredOutputMetrics field', () => {
    const entry = makeEntry({
      structuredOutputMetrics: {
        assess: {
          parse_method: 'json-tag',
          attempts: 1,
          success: true,
          repair_attempts: 0,
          model: 'claude-opus-4-6',
        },
        spec: {
          parse_method: 'markdown-fence-repaired',
          attempts: 1,
          success: true,
          repair_attempts: 0,
          model: 'claude-sonnet-4-6',
        },
      },
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.structuredOutputMetrics?.assess?.parse_method).toBe('json-tag');
    }
  });

  it('HistoryEntrySchema accepts structuredOutputMetrics with success=false', () => {
    const entry = makeEntry({
      structuredOutputMetrics: {
        review: {
          parse_method: null,
          attempts: 1,
          success: false,
          repair_attempts: 2,
          model: 'ollama:gemma3:27b',
        },
      },
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('HistoryEntrySchema accepts entries WITHOUT structuredOutputMetrics (backward compat)', () => {
    const entry = makeEntry();
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.structuredOutputMetrics).toBeUndefined();
    }
  });

  it('computeStructuredOutputStats aggregates parse methods across runs', async () => {
    const { computeStructuredOutputStats } = await import('./history.js');
    const entries: HistoryEntry[] = [
      makeEntry({
        structuredOutputMetrics: {
          assess: { parse_method: 'json-tag', attempts: 1, success: true, repair_attempts: 0 },
          spec: { parse_method: 'markdown-fence', attempts: 1, success: true, repair_attempts: 0 },
        },
      }),
      makeEntry({
        structuredOutputMetrics: {
          assess: { parse_method: 'json-tag', attempts: 1, success: true, repair_attempts: 0 },
          spec: { parse_method: 'json-tag-repaired', attempts: 1, success: true, repair_attempts: 1 },
          review: { parse_method: null, attempts: 1, success: false, repair_attempts: 2 },
        },
      }),
    ];

    const stats = computeStructuredOutputStats(entries);
    expect(stats.totalAttempts).toBe(5);
    expect(stats.successfulParses).toBe(4);
    expect(stats.successRate).toBeCloseTo(80, 1);
    expect(stats.byMethod['json-tag']).toBe(2);
    expect(stats.byMethod['markdown-fence']).toBe(1);
    expect(stats.byMethod['json-tag-repaired']).toBe(1);
    expect(stats.totalRepairAttempts).toBe(3);
  });

  it('computeStructuredOutputStats handles empty input', async () => {
    const { computeStructuredOutputStats } = await import('./history.js');
    const stats = computeStructuredOutputStats([]);
    expect(stats.totalAttempts).toBe(0);
    expect(stats.successfulParses).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.byMethod).toEqual({});
    expect(stats.totalRepairAttempts).toBe(0);
  });

  it('computeStructuredOutputStats skips entries without metrics', async () => {
    const { computeStructuredOutputStats } = await import('./history.js');
    const entries: HistoryEntry[] = [
      makeEntry(), // no structuredOutputMetrics
      makeEntry({
        structuredOutputMetrics: {
          assess: { parse_method: 'direct-parse', attempts: 1, success: true, repair_attempts: 0 },
        },
      }),
    ];
    const stats = computeStructuredOutputStats(entries);
    expect(stats.totalAttempts).toBe(1);
    expect(stats.successfulParses).toBe(1);
    expect(stats.byMethod['direct-parse']).toBe(1);
  });

  it('computeStructuredOutputStats groups by model when present', async () => {
    const { computeStructuredOutputStats } = await import('./history.js');
    const entries: HistoryEntry[] = [
      makeEntry({
        structuredOutputMetrics: {
          assess: {
            parse_method: 'json-tag',
            attempts: 1,
            success: true,
            repair_attempts: 0,
            model: 'claude-opus-4-6',
          },
          spec: {
            parse_method: 'json-tag-repaired',
            attempts: 1,
            success: true,
            repair_attempts: 1,
            model: 'ollama:gemma3:27b',
          },
        },
      }),
    ];
    const stats = computeStructuredOutputStats(entries);
    expect(stats.byModel).toBeDefined();
    expect(stats.byModel?.['claude-opus-4-6']?.success).toBe(1);
    expect(stats.byModel?.['ollama:gemma3:27b']?.success).toBe(1);
  });

  it('formatStatsTable includes structured output section when metrics present', async () => {
    const { formatStatsTable, computeStats } = await import('./history.js');
    const entries: HistoryEntry[] = [
      makeEntry({
        structuredOutputMetrics: {
          assess: { parse_method: 'json-tag', attempts: 1, success: true, repair_attempts: 0 },
        },
      }),
    ];
    const stats = computeStats(entries);
    const table = formatStatsTable(stats, entries);
    expect(table).toContain('Structured Output');
    expect(table).toContain('json-tag');
  });

  it('formatStatsTable works without entries arg (backward compat)', async () => {
    const { formatStatsTable, computeStats } = await import('./history.js');
    const stats = computeStats([makeEntry()]);
    const table = formatStatsTable(stats);
    expect(table).toContain('Total runs');
    expect(table).not.toContain('Structured Output');
  });
});

describe('per-run telemetry — issue #266', () => {
  it('HistoryEntrySchema accepts all new optional telemetry fields', () => {
    const entry = makeEntry({
      grade: 'B',
      diagnosis: 'APPROACH_WRONG',
      thrashingSignal: 'SAME_FILES',
      gatesFailed: ['lint', 'tests'],
      firstPassQuality: false,
      retryAttempts: 2,
    });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.grade).toBe('B');
      expect(result.data.diagnosis).toBe('APPROACH_WRONG');
      expect(result.data.thrashingSignal).toBe('SAME_FILES');
      expect(result.data.gatesFailed).toEqual(['lint', 'tests']);
      expect(result.data.firstPassQuality).toBe(false);
      expect(result.data.retryAttempts).toBe(2);
    }
  });

  it('HistoryEntrySchema accepts entries WITHOUT new fields (backward compat)', () => {
    const entry = makeEntry();
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.grade).toBeUndefined();
      expect(result.data.diagnosis).toBeUndefined();
      expect(result.data.thrashingSignal).toBeUndefined();
      expect(result.data.gatesFailed).toBeUndefined();
      expect(result.data.firstPassQuality).toBeUndefined();
      expect(result.data.retryAttempts).toBeUndefined();
    }
  });

  it('HistoryEntrySchema rejects invalid grade value', () => {
    const entry = makeEntry({ grade: 'Z' as unknown as 'A' });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('HistoryEntrySchema rejects invalid diagnosis value', () => {
    const entry = makeEntry({ diagnosis: 'NOT_A_THING' as unknown as 'STUCK' });
    const result = HistoryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('readHistory parses legacy entries (no new fields) and round-trips new entries', async () => {
    const legacyEntry = makeEntry({ cost: 0.25 });
    const enrichedEntry = makeEntry({
      cost: 0.75,
      grade: 'A',
      diagnosis: 'STUCK',
      thrashingSignal: 'NORMAL',
      gatesFailed: ['typecheck'],
      firstPassQuality: true,
      retryAttempts: 0,
    });

    const { appendFile, mkdir } = await import('node:fs/promises');
    const workDir = await mkdtemp(join(tmpdir(), 'kova-history-'));
    try {
      await mkdir(join(workDir, '.kova'), { recursive: true });
      const filePath = join(workDir, '.kova', 'history.jsonl');
      await appendFile(filePath, `${JSON.stringify(legacyEntry)}\n`);
      await appendFile(filePath, `${JSON.stringify(enrichedEntry)}\n`);

      const entries = await readHistory(workDir);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.grade).toBeUndefined();
      expect(entries[1]?.grade).toBe('A');
      expect(entries[1]?.diagnosis).toBe('STUCK');
      expect(entries[1]?.gatesFailed).toEqual(['typecheck']);
      expect(entries[1]?.firstPassQuality).toBe(true);
      expect(entries[1]?.retryAttempts).toBe(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('computeStats breaks down success by grade', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ grade: 'A', outcome: 'success' }),
      makeEntry({ grade: 'A', outcome: 'success' }),
      makeEntry({ grade: 'A', outcome: 'failure' }),
      makeEntry({ grade: 'B', outcome: 'success' }),
      makeEntry({ grade: 'B', outcome: 'partial' }),
      makeEntry({ outcome: 'success' }), // no grade — should not appear in byGrade
    ];

    const stats = computeStats(entries);
    expect(stats.byGrade).toBeDefined();
    expect(stats.byGrade?.A?.total).toBe(3);
    expect(stats.byGrade?.A?.success).toBe(2);
    expect(stats.byGrade?.B?.total).toBe(2);
    expect(stats.byGrade?.B?.success).toBe(1); // 'partial' is NOT success
    expect(stats.byGrade?.C).toBeUndefined();
  });

  it('computeStats counts diagnoses across failed runs', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ outcome: 'failure', diagnosis: 'APPROACH_WRONG' }),
      makeEntry({ outcome: 'failure', diagnosis: 'APPROACH_WRONG' }),
      makeEntry({ outcome: 'failure', diagnosis: 'STUCK' }),
      makeEntry({ outcome: 'success' }), // no diagnosis — fine
    ];

    const stats = computeStats(entries);
    expect(stats.byDiagnosis).toBeDefined();
    expect(stats.byDiagnosis?.APPROACH_WRONG).toBe(2);
    expect(stats.byDiagnosis?.STUCK).toBe(1);
    expect(stats.byDiagnosis?.SPEC_WRONG).toBeUndefined();
  });

  it('computeStats omits byGrade/byDiagnosis when no entries carry those fields', () => {
    const entries: HistoryEntry[] = [makeEntry(), makeEntry({ cost: 1.0 })];
    const stats = computeStats(entries);
    expect(stats.byGrade).toBeUndefined();
    expect(stats.byDiagnosis).toBeUndefined();
  });
});
