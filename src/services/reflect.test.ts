import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './history.js';
import { analyzeReflect, formatReflectReport, parseSinceFlag, type ReflectReport } from './reflect.js';

function makeEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: '2026-05-01T10:00:00.000Z',
    repo: 'test-repo',
    issues: [{ number: 1, title: 'Fix bug', success: true, prUrl: 'https://example.com/pull/1' }],
    prsCreated: 1,
    cost: 0.5,
    duration: 60_000,
    outcome: 'success',
    ...overrides,
  };
}

describe('analyzeReflect', () => {
  it('returns empty report shape for empty entries', () => {
    const r = analyzeReflect([]);
    expect(r.totalRuns).toBe(0);
    expect(r.patterns.successRate).toBe(0);
    expect(r.patterns.firstPassRate).toBe(0);
    expect(r.stalls).toEqual([]);
    expect(r.gateFailures).toEqual([]);
    expect(r.abLeaders).toEqual([]);
    expect(r.recommendations).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('computes overall success rate from outcome field', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ outcome: 'success' }),
      makeEntry({ outcome: 'success' }),
      makeEntry({ outcome: 'failure' }),
      makeEntry({ outcome: 'partial' }),
    ];
    const r = analyzeReflect(entries);
    expect(r.totalRuns).toBe(4);
    expect(r.patterns.successRate).toBe(50); // 2/4
    expect(r.patterns.partialRate).toBe(25); // 1/4
    expect(r.patterns.failureRate).toBe(25); // 1/4
    expect(r.empty).toBe(false);
  });

  it('treats success outcome as first-pass (no review iterations baked in HistoryEntry yet)', () => {
    const entries: HistoryEntry[] = [makeEntry({ outcome: 'success' }), makeEntry({ outcome: 'partial' })];
    const r = analyzeReflect(entries);
    expect(r.patterns.firstPassRate).toBe(50); // 1/2
  });

  it('filters by since cutoff', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ timestamp: '2026-05-01T10:00:00.000Z', cost: 1.0 }),
      makeEntry({ timestamp: '2026-05-20T10:00:00.000Z', cost: 2.0 }),
      makeEntry({ timestamp: '2026-05-25T10:00:00.000Z', cost: 3.0 }),
    ];
    const r = analyzeReflect(entries, { since: new Date('2026-05-15T00:00:00.000Z') });
    expect(r.totalRuns).toBe(2);
    expect(r.sinceIso).toBe('2026-05-15T00:00:00.000Z');
  });

  it('omits sinceIso when no since filter provided', () => {
    const r = analyzeReflect([makeEntry()]);
    expect(r.sinceIso).toBeUndefined();
  });

  it('builds stalls list — issues with 2+ runs in same repo', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        repo: 'kova',
        issues: [{ number: 100, title: 'A', success: false, error: 'impl failed' }],
        outcome: 'failure',
      }),
      makeEntry({
        repo: 'kova',
        issues: [{ number: 100, title: 'A', success: false, error: 'impl failed' }],
        outcome: 'failure',
      }),
      makeEntry({
        repo: 'kova',
        issues: [{ number: 100, title: 'A', success: true }],
        outcome: 'success',
      }),
      makeEntry({
        repo: 'kova',
        issues: [{ number: 200, title: 'B', success: true }],
      }),
    ];
    const r = analyzeReflect(entries);
    expect(r.stalls).toHaveLength(1);
    expect(r.stalls[0]?.issue).toBe(100);
    expect(r.stalls[0]?.repo).toBe('kova');
    expect(r.stalls[0]?.runs).toBe(3);
  });

  it('stalls are sorted by run count descending', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ issues: [{ number: 1, title: 'X', success: false }], outcome: 'failure' }),
      makeEntry({ issues: [{ number: 1, title: 'X', success: false }], outcome: 'failure' }),
      makeEntry({ issues: [{ number: 2, title: 'Y', success: false }], outcome: 'failure' }),
      makeEntry({ issues: [{ number: 2, title: 'Y', success: false }], outcome: 'failure' }),
      makeEntry({ issues: [{ number: 2, title: 'Y', success: false }], outcome: 'failure' }),
    ];
    const r = analyzeReflect(entries);
    expect(r.stalls[0]?.issue).toBe(2);
    expect(r.stalls[0]?.runs).toBe(3);
    expect(r.stalls[1]?.issue).toBe(1);
  });

  it('stalls are capped at 5', () => {
    const entries: HistoryEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      entries.push(makeEntry({ issues: [{ number: i, title: `T${i}`, success: false }], outcome: 'failure' }));
      entries.push(makeEntry({ issues: [{ number: i, title: `T${i}`, success: false }], outcome: 'failure' }));
    }
    const r = analyzeReflect(entries);
    expect(r.stalls.length).toBeLessThanOrEqual(5);
  });

  it('computes gate failures from error strings', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        issues: [{ number: 1, title: 'X', success: false, error: 'lint failed' }],
        outcome: 'failure',
      }),
      makeEntry({
        issues: [{ number: 2, title: 'Y', success: false, error: 'lint failed' }],
        outcome: 'failure',
      }),
      makeEntry({
        issues: [{ number: 3, title: 'Z', success: false, error: 'typecheck failed' }],
        outcome: 'failure',
      }),
    ];
    const r = analyzeReflect(entries);
    const lint = r.gateFailures.find((g) => g.error === 'lint failed');
    expect(lint?.count).toBe(2);
    const typecheck = r.gateFailures.find((g) => g.error === 'typecheck failed');
    expect(typecheck?.count).toBe(1);
  });

  it('gate failures sorted descending and capped at 5', () => {
    const entries: HistoryEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      for (let k = 0; k < i; k++) {
        entries.push(
          makeEntry({
            issues: [{ number: i * 100 + k, title: 'X', success: false, error: `error-${i}` }],
            outcome: 'failure',
          }),
        );
      }
    }
    const r = analyzeReflect(entries);
    expect(r.gateFailures.length).toBeLessThanOrEqual(5);
    expect(r.gateFailures[0]?.error).toBe('error-8');
    expect(r.gateFailures[0]?.count).toBe(8);
  });

  it('derives A/B leaders per wave from abTestVariants', () => {
    const baseSuccess = (variant: string) =>
      makeEntry({
        outcome: 'success',
        abTestVariants: { spec: variant },
      });
    const baseFail = (variant: string) =>
      makeEntry({
        outcome: 'failure',
        abTestVariants: { spec: variant },
        issues: [{ number: 1, title: 'X', success: false }],
      });
    const entries: HistoryEntry[] = [];
    // variant A: 12 runs, 10 success → 83%
    for (let i = 0; i < 10; i++) entries.push(baseSuccess('A'));
    for (let i = 0; i < 2; i++) entries.push(baseFail('A'));
    // variant B: 12 runs, 6 success → 50%
    for (let i = 0; i < 6; i++) entries.push(baseSuccess('B'));
    for (let i = 0; i < 6; i++) entries.push(baseFail('B'));
    const r = analyzeReflect(entries);
    const specLeader = r.abLeaders.find((l) => l.wave === 'spec');
    expect(specLeader?.winner).toBe('A');
    expect(specLeader?.winnerSuccessRate).toBeCloseTo(83.3, 1);
  });

  it('skips A/B leaders when not enough runs to be sufficient', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ outcome: 'success', abTestVariants: { spec: 'A' } }),
      makeEntry({ outcome: 'success', abTestVariants: { spec: 'B' } }),
    ];
    const r = analyzeReflect(entries);
    // Both variants have <10 runs — should not be reported as leaders
    expect(r.abLeaders.filter((l) => l.wave === 'spec')).toHaveLength(0);
  });

  it('recommendations cap at 5 and each cites a count', () => {
    // Construct entries that will trigger many recommendation types
    const entries: HistoryEntry[] = [];
    // many failures
    for (let i = 0; i < 5; i++) {
      entries.push(
        makeEntry({
          issues: [{ number: i, title: 'X', success: false, error: 'lint failed' }],
          outcome: 'failure',
        }),
      );
    }
    // stall pattern
    for (let i = 0; i < 3; i++) {
      entries.push(makeEntry({ issues: [{ number: 999, title: 'rerun', success: false }], outcome: 'failure' }));
    }
    const r = analyzeReflect(entries);
    expect(r.recommendations.length).toBeLessThanOrEqual(5);
    for (const rec of r.recommendations) {
      // every rec must mention a number/count in evidence
      expect(rec.evidence).toMatch(/\d/);
      expect(rec.action.length).toBeGreaterThan(0);
    }
  });

  it('recommendations is empty for empty entries (no uncited prose)', () => {
    const r = analyzeReflect([]);
    expect(r.recommendations).toEqual([]);
  });

  it('flags low success rate when entries are present', () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeEntry({
          issues: [{ number: i, title: 'X', success: false, error: `e${i}` }],
          outcome: 'failure',
        }),
      );
    }
    const r = analyzeReflect(entries);
    // At least one recommendation referencing the failure count
    const lowSuccess = r.recommendations.find((rec) => /\b0%|\b10\b/.test(rec.evidence));
    expect(lowSuccess).toBeDefined();
  });
});

describe('formatReflectReport', () => {
  it('renders empty-data line when report is empty', () => {
    const r = analyzeReflect([]);
    const text = formatReflectReport(r, { path: '/tmp/test' });
    expect(text).toContain('No telemetry');
    expect(text).toContain('/tmp/test');
    expect(text).toContain('kova fix');
  });

  it('renders the four required sections + recommendations', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ outcome: 'success' }),
      makeEntry({
        outcome: 'failure',
        issues: [{ number: 5, title: 'X', success: false, error: 'lint failed' }],
      }),
      makeEntry({
        outcome: 'failure',
        issues: [{ number: 5, title: 'X', success: false, error: 'lint failed' }],
      }),
    ];
    const r = analyzeReflect(entries);
    const text = formatReflectReport(r, { path: '/tmp/test' });
    expect(text).toContain('Patterns');
    expect(text).toContain('Stalls');
    expect(text).toContain('Gate failures');
    expect(text).toContain('A/B leaders');
    expect(text).toContain('Recommendations');
  });

  it('includes since marker in header when filter is set', () => {
    const r: ReflectReport = analyzeReflect([makeEntry()], {
      since: new Date('2026-05-15T00:00:00.000Z'),
    });
    const text = formatReflectReport(r, { path: '/tmp/p' });
    expect(text).toContain('2026-05-15');
  });

  it('JSON-shape report is serializable to a single object', () => {
    const r = analyzeReflect([
      makeEntry({ outcome: 'success' }),
      makeEntry({ outcome: 'failure', issues: [{ number: 1, title: 'X', success: false }] }),
    ]);
    const j = JSON.stringify(r);
    expect(() => JSON.parse(j)).not.toThrow();
    const obj = JSON.parse(j) as ReflectReport;
    expect(obj.totalRuns).toBe(2);
  });
});

describe('parseSinceFlag', () => {
  it('parses Nd as N days before now', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const d = parseSinceFlag('7d', now);
    // 7 days before
    expect(d).toEqual(new Date('2026-05-25T12:00:00.000Z'));
  });

  it('parses Nh as N hours before now', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const d = parseSinceFlag('24h', now);
    expect(d).toEqual(new Date('2026-05-31T12:00:00.000Z'));
  });

  it('parses Nw as N weeks before now', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const d = parseSinceFlag('1w', now);
    expect(d).toEqual(new Date('2026-05-25T12:00:00.000Z'));
  });

  it('returns undefined for invalid format', () => {
    expect(parseSinceFlag('garbage')).toBeUndefined();
    expect(parseSinceFlag('7')).toBeUndefined();
    expect(parseSinceFlag('')).toBeUndefined();
  });

  it('returns undefined when input is undefined', () => {
    expect(parseSinceFlag(undefined)).toBeUndefined();
  });

  it('parses absolute ISO date too', () => {
    const d = parseSinceFlag('2026-05-15T00:00:00.000Z');
    expect(d).toEqual(new Date('2026-05-15T00:00:00.000Z'));
  });
});
