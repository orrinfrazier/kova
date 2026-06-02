// Tests for cron-evaluator — pure shouldRun() with fake clock (issue #303).
import { describe, expect, it } from 'vitest';
import { isValidCronExpression, shouldRun } from './cron-evaluator.js';

describe('isValidCronExpression', () => {
  it('accepts well-formed 5-field expressions', () => {
    expect(isValidCronExpression('0 2 * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(isValidCronExpression('0 0 * * 1')).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(isValidCronExpression('not a cron')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('* * *')).toBe(false);
    expect(isValidCronExpression('99 * * * *')).toBe(false);
  });
});

describe('shouldRun', () => {
  // Cron expression "0 2 * * *" = at 02:00 every day.
  const NIGHTLY = '0 2 * * *';

  it('returns true when the cron has fired and no last_run is recorded', () => {
    const now = new Date('2026-06-01T02:00:30.000Z');
    expect(shouldRun(NIGHTLY, undefined, now)).toBe(true);
  });

  it('returns false when last_run is more recent than the most recent due time', () => {
    const now = new Date('2026-06-01T03:00:00.000Z');
    const lastRun = '2026-06-01T02:00:00.000Z'; // covered the 02:00 fire
    expect(shouldRun(NIGHTLY, lastRun, now)).toBe(false);
  });

  it('returns true when last_run is before the most recent due time (missed run)', () => {
    // Last ran yesterday at 02:00, current time is today 02:30 — today's fire missed.
    const now = new Date('2026-06-02T02:30:00.000Z');
    const lastRun = '2026-06-01T02:00:00.000Z';
    expect(shouldRun(NIGHTLY, lastRun, now)).toBe(true);
  });

  it('returns false before the first scheduled fire of the day', () => {
    const now = new Date('2026-06-01T01:59:59.000Z');
    expect(shouldRun(NIGHTLY, undefined, now)).toBe(false);
  });

  it('does not double-fire across many checks within the same minute', () => {
    const now1 = new Date('2026-06-01T02:00:05.000Z');
    expect(shouldRun(NIGHTLY, undefined, now1)).toBe(true);
    // After we record the run at 02:00:05, no further fires for the same 02:00 slot.
    const now2 = new Date('2026-06-01T02:00:45.000Z');
    expect(shouldRun(NIGHTLY, now1.toISOString(), now2)).toBe(false);
  });

  it('rejects invalid cron expressions by throwing', () => {
    expect(() => shouldRun('garbage', undefined, new Date())).toThrow(/invalid cron/i);
  });

  it('weekly cron (0 0 * * 1 — Monday 00:00) fires correctly', () => {
    // 2026-06-01 is a Monday.
    const monday = new Date('2026-06-01T00:00:30.000Z');
    expect(shouldRun('0 0 * * 1', undefined, monday)).toBe(true);
    // Tuesday 2026-06-02 — last run was Monday 00:00 → next due is next Monday.
    const tuesday = new Date('2026-06-02T00:00:30.000Z');
    expect(shouldRun('0 0 * * 1', '2026-06-01T00:00:00.000Z', tuesday)).toBe(false);
  });
});
