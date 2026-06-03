import { beforeEach, describe, expect, it } from 'vitest';
import type { WaveName } from '../types/index.js';
import {
  MetricsRegistry,
  recordConflictDetected,
  recordConflictFailed,
  recordConflictResolved,
  recordFixCost,
  recordFixDuration,
  recordIssueFailed,
  recordIssueFixed,
  recordPRCreated,
  recordRebaseAttempt,
  recordWaveCompleted,
  recordWaveDuration,
  reset,
  serialize,
  setActiveFixes,
  setCurrentCostUsd,
} from './metrics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a numeric metric value from Prometheus text output. Returns NaN if not found. */
function extractMetric(text: string, metricName: string, labels?: Record<string, string>): number {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (!line.includes(metricName)) continue;

    if (labels) {
      const allLabelsMatch = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
      if (!allLabelsMatch) continue;
    } else {
      // No labels variant — line must NOT contain { (unless it's the histogram _count/_sum)
      if (line.includes('{')) continue;
    }

    const parts = line.trim().split(/\s+/);
    const value = parts[parts.length - 1];
    return Number(value);
  }
  return NaN;
}

/** Check that a Prometheus text block contains a HELP line for a metric. */
function hasHelp(text: string, metricName: string): boolean {
  return text.includes(`# HELP ${metricName}`);
}

/** Check that a Prometheus text block contains a TYPE line for a metric. */
function hasType(text: string, metricName: string, kind: string): boolean {
  return text.includes(`# TYPE ${metricName} ${kind}`);
}

// ---------------------------------------------------------------------------
// Default (enabled) registry tests
// ---------------------------------------------------------------------------

describe('MetricsRegistry (enabled)', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    reset();
    registry = new MetricsRegistry({ enabled: true });
  });

  // -------------------------------------------------------------------------
  // AC1: recordIssueFixed()
  // -------------------------------------------------------------------------

  describe('recordIssueFixed()', () => {
    it('increments kova_issues_fixed_total by 1', () => {
      registry.recordIssueFixed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordIssueFixed();
      registry.recordIssueFixed();
      registry.recordIssueFixed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: recordIssueFailed()
  // -------------------------------------------------------------------------

  describe('recordIssueFailed()', () => {
    it('increments kova_issues_failed_total by 1', () => {
      registry.recordIssueFailed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_failed_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordIssueFailed();
      registry.recordIssueFailed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_failed_total')).toBe(2);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_failed_total')).toBe(0);
    });

    it('is independent from recordIssueFixed', () => {
      registry.recordIssueFixed();
      registry.recordIssueFixed();
      registry.recordIssueFailed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(2);
      expect(extractMetric(out, 'kova_issues_failed_total')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC3: recordWaveCompleted(wave)
  // -------------------------------------------------------------------------

  describe('recordWaveCompleted(wave)', () => {
    it('increments kova_waves_completed_total with wave label', () => {
      registry.recordWaveCompleted('assess');
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_waves_completed_total', { wave: 'assess' })).toBe(1);
    });

    it('tracks each wave name independently', () => {
      const waves: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];
      for (const wave of waves) {
        registry.recordWaveCompleted(wave);
      }
      const out = registry.serialize();
      for (const wave of waves) {
        expect(extractMetric(out, 'kova_waves_completed_total', { wave })).toBe(1);
      }
    });

    it('increments the correct label only', () => {
      registry.recordWaveCompleted('assess');
      registry.recordWaveCompleted('assess');
      registry.recordWaveCompleted('spec');
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_waves_completed_total', { wave: 'assess' })).toBe(2);
      expect(extractMetric(out, 'kova_waves_completed_total', { wave: 'spec' })).toBe(1);
    });

    it('starts at 0 for any wave not yet called', () => {
      registry.recordWaveCompleted('assess');
      const out = registry.serialize();
      // 'impl' was never called — should not appear or appear as 0
      const implValue = extractMetric(out, 'kova_waves_completed_total', { wave: 'impl' });
      expect(implValue === 0 || Number.isNaN(implValue)).toBe(true);
    });

    it('handles brainstorm wave', () => {
      registry.recordWaveCompleted('brainstorm');
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_waves_completed_total', { wave: 'brainstorm' })).toBe(1);
    });

    it('escapes special characters in label values', () => {
      // Prometheus exposition format requires escaping backslash, double-quote, and newline
      registry.recordWaveCompleted('wave"with\\special\nchars');
      const out = registry.serialize();
      expect(out).toContain('wave\\"with\\\\special\\nchars');
      expect(out).not.toContain('wave"with\\special\nchars');
    });
  });

  // -------------------------------------------------------------------------
  // AC4: recordPRCreated()
  // -------------------------------------------------------------------------

  describe('recordPRCreated()', () => {
    it('increments kova_prs_created_total by 1', () => {
      registry.recordPRCreated();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_prs_created_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordPRCreated();
      registry.recordPRCreated();
      registry.recordPRCreated();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_prs_created_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_prs_created_total')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC5: setCurrentCostUsd(value)
  // -------------------------------------------------------------------------

  describe('setCurrentCostUsd(value)', () => {
    it('sets kova_current_cost_usd gauge to the given value', () => {
      registry.setCurrentCostUsd(1.5);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_current_cost_usd')).toBe(1.5);
    });

    it('replaces previous value (gauge semantics)', () => {
      registry.setCurrentCostUsd(1.5);
      registry.setCurrentCostUsd(2.75);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_current_cost_usd')).toBe(2.75);
    });

    it('can be set to 0', () => {
      registry.setCurrentCostUsd(5);
      registry.setCurrentCostUsd(0);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_current_cost_usd')).toBe(0);
    });

    it('serializes with TYPE gauge', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_current_cost_usd', 'gauge')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC6: setActiveFixes(value)
  // -------------------------------------------------------------------------

  describe('setActiveFixes(value)', () => {
    it('sets kova_active_fixes gauge to the given value', () => {
      registry.setActiveFixes(3);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_active_fixes')).toBe(3);
    });

    it('replaces previous value (gauge semantics)', () => {
      registry.setActiveFixes(3);
      registry.setActiveFixes(1);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_active_fixes')).toBe(1);
    });

    it('can be set to 0', () => {
      registry.setActiveFixes(5);
      registry.setActiveFixes(0);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_active_fixes')).toBe(0);
    });

    it('serializes with TYPE gauge', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_active_fixes', 'gauge')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC7: recordWaveDuration(wave, ms)
  // -------------------------------------------------------------------------

  describe('recordWaveDuration(wave, ms)', () => {
    it('observes into kova_wave_duration_ms histogram for a given wave', () => {
      registry.recordWaveDuration('assess', 1000);
      const out = registry.serialize();
      // _count should be 1
      expect(extractMetric(out, 'kova_wave_duration_ms_count', { wave: 'assess' })).toBe(1);
    });

    it('accumulates _sum for multiple observations', () => {
      registry.recordWaveDuration('spec', 500);
      registry.recordWaveDuration('spec', 1500);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_wave_duration_ms_sum', { wave: 'spec' })).toBe(2000);
    });

    it('increments _count for each observation', () => {
      registry.recordWaveDuration('impl', 100);
      registry.recordWaveDuration('impl', 200);
      registry.recordWaveDuration('impl', 300);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_wave_duration_ms_count', { wave: 'impl' })).toBe(3);
    });

    it('tracks different waves independently', () => {
      registry.recordWaveDuration('assess', 1000);
      registry.recordWaveDuration('review', 2000);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_wave_duration_ms_count', { wave: 'assess' })).toBe(1);
      expect(extractMetric(out, 'kova_wave_duration_ms_count', { wave: 'review' })).toBe(1);
    });

    it('serializes with TYPE histogram', () => {
      registry.recordWaveDuration('test', 500);
      const out = registry.serialize();
      expect(hasType(out, 'kova_wave_duration_ms', 'histogram')).toBe(true);
    });

    it('includes _bucket lines', () => {
      registry.recordWaveDuration('quality', 500);
      const out = registry.serialize();
      expect(out).toContain('kova_wave_duration_ms_bucket');
    });
  });

  // -------------------------------------------------------------------------
  // AC8: recordFixDuration(ms)
  // -------------------------------------------------------------------------

  describe('recordFixDuration(ms)', () => {
    it('observes into kova_fix_duration_ms histogram', () => {
      registry.recordFixDuration(5000);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_fix_duration_ms_count')).toBe(1);
    });

    it('accumulates _sum for multiple observations', () => {
      registry.recordFixDuration(3000);
      registry.recordFixDuration(7000);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_fix_duration_ms_sum')).toBe(10000);
    });

    it('increments _count for each observation', () => {
      registry.recordFixDuration(1000);
      registry.recordFixDuration(2000);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_fix_duration_ms_count')).toBe(2);
    });

    it('serializes with TYPE histogram', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_fix_duration_ms', 'histogram')).toBe(true);
    });

    it('includes _bucket lines after an observation', () => {
      registry.recordFixDuration(5000);
      const out = registry.serialize();
      expect(out).toContain('kova_fix_duration_ms_bucket');
    });
  });

  // -------------------------------------------------------------------------
  // AC9: recordFixCost(usd)
  // -------------------------------------------------------------------------

  describe('recordFixCost(usd)', () => {
    it('observes into kova_cost_per_fix_usd histogram', () => {
      registry.recordFixCost(0.5);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_cost_per_fix_usd_count')).toBe(1);
    });

    it('accumulates _sum for multiple observations', () => {
      registry.recordFixCost(0.25);
      registry.recordFixCost(0.75);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_cost_per_fix_usd_sum')).toBeCloseTo(1.0, 5);
    });

    it('increments _count for each observation', () => {
      registry.recordFixCost(0.1);
      registry.recordFixCost(0.2);
      registry.recordFixCost(0.3);
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_cost_per_fix_usd_count')).toBe(3);
    });

    it('serializes with TYPE histogram', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_cost_per_fix_usd', 'histogram')).toBe(true);
    });

    it('includes _bucket lines after an observation', () => {
      registry.recordFixCost(0.5);
      const out = registry.serialize();
      expect(out).toContain('kova_cost_per_fix_usd_bucket');
    });
  });

  // -------------------------------------------------------------------------
  // Piece 3: recordRebaseAttempt()
  // -------------------------------------------------------------------------

  describe('recordRebaseAttempt()', () => {
    it('increments kova_rebase_attempts_total by 1', () => {
      registry.recordRebaseAttempt();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_rebase_attempts_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordRebaseAttempt();
      registry.recordRebaseAttempt();
      registry.recordRebaseAttempt();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_rebase_attempts_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_rebase_attempts_total')).toBe(0);
    });

    it('serializes with HELP and TYPE counter lines', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_rebase_attempts_total')).toBe(true);
      expect(hasType(out, 'kova_rebase_attempts_total', 'counter')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Piece 3: recordConflictDetected()
  // -------------------------------------------------------------------------

  describe('recordConflictDetected()', () => {
    it('increments kova_conflicts_detected_total by 1', () => {
      registry.recordConflictDetected();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_detected_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordConflictDetected();
      registry.recordConflictDetected();
      registry.recordConflictDetected();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_detected_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_detected_total')).toBe(0);
    });

    it('serializes with HELP and TYPE counter lines', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_conflicts_detected_total')).toBe(true);
      expect(hasType(out, 'kova_conflicts_detected_total', 'counter')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Piece 3: recordConflictResolved()
  // -------------------------------------------------------------------------

  describe('recordConflictResolved()', () => {
    it('increments kova_conflicts_resolved_total by 1', () => {
      registry.recordConflictResolved();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_resolved_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordConflictResolved();
      registry.recordConflictResolved();
      registry.recordConflictResolved();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_resolved_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_resolved_total')).toBe(0);
    });

    it('serializes with HELP and TYPE counter lines', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_conflicts_resolved_total')).toBe(true);
      expect(hasType(out, 'kova_conflicts_resolved_total', 'counter')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Piece 3: recordConflictFailed()
  // -------------------------------------------------------------------------

  describe('recordConflictFailed()', () => {
    it('increments kova_conflicts_failed_total by 1', () => {
      registry.recordConflictFailed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_failed_total')).toBe(1);
    });

    it('increments by 1 on each call', () => {
      registry.recordConflictFailed();
      registry.recordConflictFailed();
      registry.recordConflictFailed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_failed_total')).toBe(3);
    });

    it('starts at 0 before any calls', () => {
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_conflicts_failed_total')).toBe(0);
    });

    it('serializes with HELP and TYPE counter lines', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_conflicts_failed_total')).toBe(true);
      expect(hasType(out, 'kova_conflicts_failed_total', 'counter')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC10: serialize() Prometheus text exposition format
  // -------------------------------------------------------------------------

  describe('serialize()', () => {
    it('returns a non-empty string', () => {
      const out = registry.serialize();
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it('includes HELP lines for all counters', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_issues_fixed_total')).toBe(true);
      expect(hasHelp(out, 'kova_issues_failed_total')).toBe(true);
      expect(hasHelp(out, 'kova_prs_created_total')).toBe(true);
    });

    it('includes TYPE counter for counter metrics', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_issues_fixed_total', 'counter')).toBe(true);
      expect(hasType(out, 'kova_issues_failed_total', 'counter')).toBe(true);
      expect(hasType(out, 'kova_prs_created_total', 'counter')).toBe(true);
    });

    it('includes HELP lines for gauges', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_current_cost_usd')).toBe(true);
      expect(hasHelp(out, 'kova_active_fixes')).toBe(true);
    });

    it('includes TYPE gauge for gauge metrics', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_current_cost_usd', 'gauge')).toBe(true);
      expect(hasType(out, 'kova_active_fixes', 'gauge')).toBe(true);
    });

    it('includes HELP lines for histograms', () => {
      const out = registry.serialize();
      expect(hasHelp(out, 'kova_wave_duration_ms')).toBe(true);
      expect(hasHelp(out, 'kova_fix_duration_ms')).toBe(true);
      expect(hasHelp(out, 'kova_cost_per_fix_usd')).toBe(true);
    });

    it('includes TYPE histogram for histogram metrics', () => {
      const out = registry.serialize();
      expect(hasType(out, 'kova_wave_duration_ms', 'histogram')).toBe(true);
      expect(hasType(out, 'kova_fix_duration_ms', 'histogram')).toBe(true);
      expect(hasType(out, 'kova_cost_per_fix_usd', 'histogram')).toBe(true);
    });

    it('all metric names are prefixed with kova_', () => {
      registry.recordIssueFixed();
      registry.recordWaveCompleted('assess');
      const out = registry.serialize();
      const metricLines = out.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
      for (const line of metricLines) {
        expect(line).toMatch(/^kova_/);
      }
    });

    it('counter value appears after HELP and TYPE lines in correct order', () => {
      registry.recordIssueFixed();
      const out = registry.serialize();
      const helpIdx = out.indexOf('# HELP kova_issues_fixed_total');
      const typeIdx = out.indexOf('# TYPE kova_issues_fixed_total');
      const valueIdx = out.indexOf('kova_issues_fixed_total 1');
      expect(helpIdx).toBeGreaterThanOrEqual(0);
      expect(typeIdx).toBeGreaterThan(helpIdx);
      expect(valueIdx).toBeGreaterThan(typeIdx);
    });

    it('histogram _count/_sum/_bucket appear after HELP/TYPE', () => {
      registry.recordFixDuration(1000);
      const out = registry.serialize();
      const helpIdx = out.indexOf('# HELP kova_fix_duration_ms');
      const typeIdx = out.indexOf('# TYPE kova_fix_duration_ms');
      expect(helpIdx).toBeGreaterThanOrEqual(0);
      expect(typeIdx).toBeGreaterThan(helpIdx);
      // Ensure lines exist after TYPE
      const afterType = out.slice(typeIdx);
      expect(afterType).toContain('kova_fix_duration_ms_bucket');
      expect(afterType).toContain('kova_fix_duration_ms_count');
      expect(afterType).toContain('kova_fix_duration_ms_sum');
    });

    it('histogram includes le="+Inf" bucket', () => {
      registry.recordFixDuration(999999);
      const out = registry.serialize();
      expect(out).toContain('le="+Inf"');
    });

    it('produces valid lines (each non-comment, non-empty line has a value)', () => {
      registry.recordIssueFixed();
      registry.setActiveFixes(2);
      registry.recordFixCost(0.5);
      const out = registry.serialize();
      const dataLines = out.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
      for (const line of dataLines) {
        const parts = line.trim().split(/\s+/);
        const lastPart = parts[parts.length - 1];
        expect(Number.isNaN(Number(lastPart))).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC12: reset()
  // -------------------------------------------------------------------------

  describe('reset()', () => {
    it('clears counter values', () => {
      registry.recordIssueFixed();
      registry.recordIssueFixed();
      registry.recordIssueFailed();
      registry.recordPRCreated();
      registry.reset();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(0);
      expect(extractMetric(out, 'kova_issues_failed_total')).toBe(0);
      expect(extractMetric(out, 'kova_prs_created_total')).toBe(0);
    });

    it('clears gauge values', () => {
      registry.setCurrentCostUsd(9.99);
      registry.setActiveFixes(5);
      registry.reset();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_current_cost_usd')).toBe(0);
      expect(extractMetric(out, 'kova_active_fixes')).toBe(0);
    });

    it('clears histogram observations (_count resets to 0)', () => {
      registry.recordFixDuration(5000);
      registry.recordFixCost(1.5);
      registry.recordWaveDuration('assess', 1000);
      registry.reset();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_fix_duration_ms_count')).toBe(0);
      expect(extractMetric(out, 'kova_cost_per_fix_usd_count')).toBe(0);
    });

    it('clears labeled wave counter values', () => {
      registry.recordWaveCompleted('assess');
      registry.recordWaveCompleted('spec');
      registry.reset();
      const out = registry.serialize();
      // After reset, no 'assess' or 'spec' label values should appear with non-zero counts
      const assessValue = extractMetric(out, 'kova_waves_completed_total', { wave: 'assess' });
      expect(assessValue === 0 || Number.isNaN(assessValue)).toBe(true);
    });

    it('allows re-recording after reset', () => {
      registry.recordIssueFixed();
      registry.recordIssueFixed();
      registry.reset();
      registry.recordIssueFixed();
      const out = registry.serialize();
      expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Disabled registry tests (AC11)
// ---------------------------------------------------------------------------

describe('MetricsRegistry (disabled)', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    reset();
    registry = new MetricsRegistry({ enabled: false });
  });

  it('recordIssueFixed() is a no-op', () => {
    registry.recordIssueFixed();
    registry.recordIssueFixed();
    // serialize returns '' so no metric output expected
    expect(registry.serialize()).toBe('');
  });

  it('recordIssueFailed() is a no-op', () => {
    registry.recordIssueFailed();
    expect(registry.serialize()).toBe('');
  });

  it('recordWaveCompleted() is a no-op', () => {
    registry.recordWaveCompleted('assess');
    expect(registry.serialize()).toBe('');
  });

  it('recordPRCreated() is a no-op', () => {
    registry.recordPRCreated();
    expect(registry.serialize()).toBe('');
  });

  it('setCurrentCostUsd() is a no-op', () => {
    registry.setCurrentCostUsd(5.0);
    expect(registry.serialize()).toBe('');
  });

  it('setActiveFixes() is a no-op', () => {
    registry.setActiveFixes(3);
    expect(registry.serialize()).toBe('');
  });

  it('recordWaveDuration() is a no-op', () => {
    registry.recordWaveDuration('impl', 1000);
    expect(registry.serialize()).toBe('');
  });

  it('recordFixDuration() is a no-op', () => {
    registry.recordFixDuration(5000);
    expect(registry.serialize()).toBe('');
  });

  it('recordFixCost() is a no-op', () => {
    registry.recordFixCost(1.5);
    expect(registry.serialize()).toBe('');
  });

  it('recordRebaseAttempt() is a no-op', () => {
    registry.recordRebaseAttempt();
    expect(registry.serialize()).toBe('');
  });

  it('recordConflictDetected() is a no-op', () => {
    registry.recordConflictDetected();
    expect(registry.serialize()).toBe('');
  });

  it('recordConflictResolved() is a no-op', () => {
    registry.recordConflictResolved();
    expect(registry.serialize()).toBe('');
  });

  it('recordConflictFailed() is a no-op', () => {
    registry.recordConflictFailed();
    expect(registry.serialize()).toBe('');
  });

  it('serialize() returns empty string', () => {
    expect(registry.serialize()).toBe('');
  });

  it('serialize() returns empty string even after many calls', () => {
    registry.recordIssueFixed();
    registry.recordIssueFailed();
    registry.recordPRCreated();
    registry.setCurrentCostUsd(10);
    registry.setActiveFixes(2);
    registry.recordWaveCompleted('spec');
    registry.recordWaveDuration('spec', 2000);
    registry.recordFixDuration(10000);
    registry.recordFixCost(2.0);
    expect(registry.serialize()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton functions
// ---------------------------------------------------------------------------

describe('module-level singleton functions', () => {
  beforeEach(() => {
    reset();
  });

  it('recordIssueFixed() delegates to the default registry', () => {
    recordIssueFixed();
    expect(serialize()).toContain('kova_issues_fixed_total');
  });

  it('recordIssueFailed() delegates to the default registry', () => {
    recordIssueFailed();
    expect(serialize()).toContain('kova_issues_failed_total');
  });

  it('recordWaveCompleted() delegates to the default registry', () => {
    recordWaveCompleted('test');
    expect(serialize()).toContain('kova_waves_completed_total');
  });

  it('recordPRCreated() delegates to the default registry', () => {
    recordPRCreated();
    expect(serialize()).toContain('kova_prs_created_total');
  });

  it('setCurrentCostUsd() delegates to the default registry', () => {
    setCurrentCostUsd(3.14);
    expect(serialize()).toContain('kova_current_cost_usd');
  });

  it('setActiveFixes() delegates to the default registry', () => {
    setActiveFixes(4);
    expect(serialize()).toContain('kova_active_fixes');
  });

  it('recordWaveDuration() delegates to the default registry', () => {
    recordWaveDuration('review', 8000);
    expect(serialize()).toContain('kova_wave_duration_ms');
  });

  it('recordFixDuration() delegates to the default registry', () => {
    recordFixDuration(12000);
    expect(serialize()).toContain('kova_fix_duration_ms');
  });

  it('recordFixCost() delegates to the default registry', () => {
    recordFixCost(0.99);
    expect(serialize()).toContain('kova_cost_per_fix_usd');
  });

  it('recordRebaseAttempt() delegates to the default registry', () => {
    recordRebaseAttempt();
    expect(serialize()).toContain('kova_rebase_attempts_total');
  });

  it('recordConflictDetected() delegates to the default registry', () => {
    recordConflictDetected();
    expect(serialize()).toContain('kova_conflicts_detected_total');
  });

  it('recordConflictResolved() delegates to the default registry', () => {
    recordConflictResolved();
    expect(serialize()).toContain('kova_conflicts_resolved_total');
  });

  it('recordConflictFailed() delegates to the default registry', () => {
    recordConflictFailed();
    expect(serialize()).toContain('kova_conflicts_failed_total');
  });

  it('reset() clears the default registry state', () => {
    recordIssueFixed();
    recordIssueFixed();
    reset();
    const out = serialize();
    expect(extractMetric(out, 'kova_issues_fixed_total')).toBe(0);
  });
});
