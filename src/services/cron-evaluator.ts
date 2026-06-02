// Pure cron evaluator — `shouldRun(expr, last_run, now)` (issue #303).
//
// Uses `node-cron`'s built-in `validate()` to accept the standard 5-field
// cron expressions documented in the package README. To compute the most
// recent due time we walk back one minute at a time from `now`; for any
// realistic poll cadence (seconds → minutes) this terminates in O(60 *
// hoursMissed) iterations, which is bounded for daily/weekly crons and
// dwarfed by the network/wave-runtime of an actual fix loop.
//
// The "last_run gating" property is what makes the scheduler crash-safe:
// after a missed wake-up window the scheduler still triggers exactly one
// run for the missed slot, but never double-fires for the SAME slot.

import cron from 'node-cron';

/** Cron field bounds — minute, hour, day-of-month, month, day-of-week. */
type CronField = { values: Set<number>; min: number; max: number };

const FIELD_BOUNDS: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week (0 = Sunday)
];

/** Parse a single cron field into the set of allowed integer values. */
function parseField(raw: string, { min, max }: { min: number; max: number }): CronField {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      step = Number.parseInt(part.slice(slash + 1), 10);
      range = part.slice(0, slash);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`invalid cron step: "${part}"`);
      }
    }

    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number.parseInt(a ?? '', 10);
      hi = Number.parseInt(b ?? '', 10);
    } else {
      lo = hi = Number.parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid cron field: "${part}" (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, min, max };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`invalid cron expression (expected 5 fields, got ${parts.length}): "${expr}"`);
  }
  const fields = parts.map((p, i) => {
    const bounds = FIELD_BOUNDS[i];
    if (!bounds) throw new Error('internal: cron field index out of range');
    return parseField(p, bounds);
  });
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error('internal: cron parse produced incomplete fields');
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Public — does the given Date match the cron expression at minute resolution? */
function matches(parsed: ParsedCron, when: Date): boolean {
  return (
    parsed.minute.values.has(when.getUTCMinutes()) &&
    parsed.hour.values.has(when.getUTCHours()) &&
    parsed.dayOfMonth.values.has(when.getUTCDate()) &&
    parsed.month.values.has(when.getUTCMonth() + 1) &&
    parsed.dayOfWeek.values.has(when.getUTCDay())
  );
}

/** Validate a cron expression without throwing. */
export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== 'string' || expr.trim() === '') return false;
  if (!cron.validate(expr)) return false;
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the most recent minute (≤ `now`) at which the expression fired.
 * Returns null if no such minute exists in the lookback window (defaults to
 * 35 days, comfortably covering monthly crons).
 */
function mostRecentFireTime(parsed: ParsedCron, now: Date, lookbackMinutes = 35 * 24 * 60): Date | null {
  // Truncate to the current minute so seconds don't affect matching.
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (matches(parsed, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return null;
}

/**
 * Returns true when the job is due — there exists a fire-time ≤ `now` that
 * has not yet been covered by `lastRunIso`. Crash-safe: a missed daily slot
 * fires exactly once on the next tick, then `recordRun` advances last_run.
 *
 * @throws if `expr` is not a valid cron expression.
 */
export function shouldRun(expr: string, lastRunIso: string | undefined, now: Date): boolean {
  if (!isValidCronExpression(expr)) {
    throw new Error(`invalid cron expression: "${expr}"`);
  }
  const parsed = parseCron(expr);
  const lastFire = mostRecentFireTime(parsed, now);
  if (!lastFire) return false; // never fires in the lookback window
  if (lastRunIso == null) {
    // Cold start: only fire when "now" sits in the same minute as the most
    // recent due time. This prevents a fresh scheduler from immediately
    // re-firing yesterday's slot at 01:59 on day 1.
    return sameMinute(lastFire, now);
  }
  // If last_run < lastFire we've missed (or never seen) this slot — run it.
  return new Date(lastRunIso).getTime() < lastFire.getTime();
}

function sameMinute(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours() &&
    a.getUTCMinutes() === b.getUTCMinutes()
  );
}
