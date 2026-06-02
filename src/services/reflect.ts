// Cross-run telemetry analysis. Reads HistoryEntry[] (from history.jsonl) and
// surfaces patterns, stalls, gate failures, and A/B leaders — plus a bounded,
// count-cited recommendation list. Pure functions, no fs I/O.
//
// Source-of-truth for the kova `reflect` CLI subcommand (issue #265). Mirrors
// the cross-skill /reflect protocol while staying read-only and citing every
// number it surfaces.

import type { HistoryEntry } from './history.js';
import { correlateByABTestVariant } from './prompt-correlation.js';

/** A single recurring issue+repo pair across multiple runs. */
export interface ReflectStall {
  issue: number;
  repo: string;
  runs: number;
  /** Last seen ISO timestamp (most recent entry). */
  lastSeen: string;
}

/** A single error-string bucket from `issues[].error` across failed runs. */
export interface ReflectGateFailure {
  error: string;
  count: number;
}

/** Winner per wave from A/B variants, only emitted when both variants have ≥10 runs. */
export interface ReflectABLeader {
  wave: string;
  winner: string;
  runners_up: string[];
  winnerSuccessRate: number;
  winnerRuns: number;
}

/** A bounded recommendation with required count-cited evidence. */
export interface ReflectRecommendation {
  action: string;
  evidence: string;
  priority: number;
}

/** Top-level patterns block — coarse outcome distribution + first-pass rate. */
export interface ReflectPatterns {
  /** % of entries with outcome=success (0..100). */
  successRate: number;
  /** % with outcome=partial. */
  partialRate: number;
  /** % with outcome=failure. */
  failureRate: number;
  /**
   * First-pass rate — heuristic: outcome=success counts as first-pass for now.
   * When HistoryEntry grows review-iteration metadata this widens (see #265).
   */
  firstPassRate: number;
}

/** Full reflect report — the shape returned for both text and JSON. */
export interface ReflectReport {
  generatedAt: string;
  sinceIso?: string;
  totalRuns: number;
  /** True when no entries are present (after filtering). */
  empty: boolean;
  patterns: ReflectPatterns;
  stalls: ReflectStall[];
  gateFailures: ReflectGateFailure[];
  abLeaders: ReflectABLeader[];
  recommendations: ReflectRecommendation[];
}

/** Cap applied to each bounded section + recommendation list per acceptance criteria. */
const SECTION_CAP = 5;

/**
 * Parse a relative duration flag (`Nd` / `Nh` / `Nw`) or absolute ISO date
 * into a `Date`. Returns `undefined` for missing/invalid input — callers
 * fall back to "no filter" semantics.
 */
export function parseSinceFlag(input: string | undefined, now: Date = new Date()): Date | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // Relative: Nd / Nh / Nw (positive integers)
  const relMatch = /^(\d+)([dhw])$/i.exec(trimmed);
  if (relMatch) {
    const amount = Number.parseInt(relMatch[1] ?? '0', 10);
    const unit = (relMatch[2] ?? 'd').toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const msPerUnit = unit === 'h' ? 3_600_000 : unit === 'w' ? 7 * 86_400_000 : 86_400_000;
    return new Date(now.getTime() - amount * msPerUnit);
  }

  // Absolute ISO date — require a date-shape (yyyy-mm-dd...) so bare numbers
  // like "7" don't accidentally parse as a year.
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return undefined;
  const abs = new Date(trimmed);
  if (Number.isNaN(abs.getTime())) return undefined;
  return abs;
}

/** Apply optional `since` filter to entries (entries with timestamp >= since are kept). */
function filterEntries(entries: HistoryEntry[], since?: Date): HistoryEntry[] {
  if (!since) return entries;
  const cutoff = since.getTime();
  return entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Round a percentage to 1 decimal place. */
function pct(numer: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.round((numer / denom) * 1000) / 10;
}

/** Build the patterns block. */
function buildPatterns(entries: HistoryEntry[]): ReflectPatterns {
  if (entries.length === 0) {
    return { successRate: 0, partialRate: 0, failureRate: 0, firstPassRate: 0 };
  }
  const total = entries.length;
  const success = entries.filter((e) => e.outcome === 'success').length;
  const partial = entries.filter((e) => e.outcome === 'partial').length;
  const failure = entries.filter((e) => e.outcome === 'failure').length;
  return {
    successRate: pct(success, total),
    partialRate: pct(partial, total),
    failureRate: pct(failure, total),
    // Heuristic until HistoryEntry carries review_iterations: success === first-pass.
    firstPassRate: pct(success, total),
  };
}

/** Build the stalls section. */
function buildStalls(entries: HistoryEntry[]): ReflectStall[] {
  const counts = new Map<string, { issue: number; repo: string; runs: number; lastSeen: string }>();
  for (const entry of entries) {
    for (const issue of entry.issues) {
      const key = `${entry.repo}#${issue.number}`;
      const bucket = counts.get(key);
      if (bucket) {
        bucket.runs += 1;
        if (entry.timestamp > bucket.lastSeen) bucket.lastSeen = entry.timestamp;
      } else {
        counts.set(key, {
          issue: issue.number,
          repo: entry.repo,
          runs: 1,
          lastSeen: entry.timestamp,
        });
      }
    }
  }
  const stalls = [...counts.values()].filter((s) => s.runs >= 2);
  stalls.sort((a, b) => b.runs - a.runs || a.issue - b.issue);
  return stalls.slice(0, SECTION_CAP);
}

/** Build the gate failures histogram. */
function buildGateFailures(entries: HistoryEntry[]): ReflectGateFailure[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome === 'success') continue;
    for (const issue of entry.issues) {
      if (!issue.error || issue.error.trim() === '') continue;
      const key = issue.error;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const list: ReflectGateFailure[] = [...counts.entries()].map(([error, count]) => ({ error, count }));
  list.sort((a, b) => b.count - a.count || a.error.localeCompare(b.error));
  return list.slice(0, SECTION_CAP);
}

/**
 * Build the A/B leaders section. Reuses `correlateByABTestVariant` to honour
 * the existing AB_TEST_MIN_RUNS sufficiency threshold — a wave with only one
 * sufficient variant has no comparable peer and is skipped.
 */
function buildABLeaders(entries: HistoryEntry[]): ReflectABLeader[] {
  const variantStats = correlateByABTestVariant(entries);
  const sufficient = variantStats.filter((v) => v.sufficient);
  const byWave = new Map<string, typeof sufficient>();
  for (const v of sufficient) {
    const bucket = byWave.get(v.wave) ?? [];
    bucket.push(v);
    byWave.set(v.wave, bucket);
  }
  const leaders: ReflectABLeader[] = [];
  for (const [wave, variants] of byWave) {
    if (variants.length < 2) continue;
    variants.sort((a, b) => b.successRate - a.successRate);
    const [winner, ...rest] = variants;
    if (!winner) continue;
    leaders.push({
      wave,
      winner: winner.variant,
      runners_up: rest.map((v) => v.variant),
      winnerSuccessRate: Math.round(winner.successRate * 10) / 10,
      winnerRuns: winner.runs,
    });
  }
  leaders.sort((a, b) => a.wave.localeCompare(b.wave));
  return leaders.slice(0, SECTION_CAP);
}

/**
 * Emit a bounded (≤5) recommendation list. Every entry MUST cite a count —
 * uncited prose is forbidden by acceptance criteria.
 */
function buildRecommendations(args: {
  entries: HistoryEntry[];
  patterns: ReflectPatterns;
  stalls: ReflectStall[];
  gateFailures: ReflectGateFailure[];
  abLeaders: ReflectABLeader[];
}): ReflectRecommendation[] {
  const recs: ReflectRecommendation[] = [];
  const total = args.entries.length;
  if (total === 0) return recs;

  // Low success rate
  if (args.patterns.successRate < 50) {
    const failedRuns = args.entries.filter((e) => e.outcome !== 'success').length;
    recs.push({
      action: 'Investigate persistent failures — success rate is below 50%',
      evidence: `${failedRuns}/${total} runs did not reach 'success' (${args.patterns.successRate}% success).`,
      priority: 1,
    });
  }

  // Top stall
  const topStall = args.stalls[0];
  if (topStall && topStall.runs >= 3) {
    recs.push({
      action: `Deep-dive ${topStall.repo}#${topStall.issue} — it keeps re-running`,
      evidence: `${topStall.repo}#${topStall.issue} ran ${topStall.runs} times (last seen ${topStall.lastSeen}).`,
      priority: 2,
    });
  }

  // Top gate failure
  const topGate = args.gateFailures[0];
  if (topGate && topGate.count >= 2) {
    recs.push({
      action: `Address recurring failure mode "${topGate.error}"`,
      evidence: `"${topGate.error}" reported on ${topGate.count} runs.`,
      priority: 3,
    });
  }

  // A/B leader recommendation
  const topLeader = args.abLeaders[0];
  if (topLeader) {
    recs.push({
      action: `Promote variant ${topLeader.winner} for wave ${topLeader.wave}`,
      evidence: `${topLeader.winner} won ${topLeader.wave} at ${topLeader.winnerSuccessRate}% over ${topLeader.runners_up.length} alternative(s) across ${topLeader.winnerRuns} runs.`,
      priority: 4,
    });
  }

  // Cost-spike check
  if (total >= 5) {
    const costs = args.entries.map((e) => e.cost).sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)] ?? 0;
    const maxCost = costs[costs.length - 1] ?? 0;
    if (median > 0 && maxCost > median * 5) {
      recs.push({
        action: 'Review cost outliers — one run cost >5× the median',
        evidence: `Max run cost $${maxCost.toFixed(2)} vs median $${median.toFixed(2)} across ${total} runs.`,
        priority: 5,
      });
    }
  }

  return recs.slice(0, SECTION_CAP);
}

/**
 * Top-level entrypoint — pure function over `HistoryEntry[]`. Returns the
 * `ReflectReport` consumed by both the text formatter and `--json` output.
 *
 * Empty inputs are findings, not errors — the caller renders an "empty"
 * message based on `report.empty` rather than throwing.
 */
export function analyzeReflect(entries: HistoryEntry[], options?: { since?: Date }): ReflectReport {
  const filtered = filterEntries(entries, options?.since);
  const patterns = buildPatterns(filtered);
  const stalls = buildStalls(filtered);
  const gateFailures = buildGateFailures(filtered);
  const abLeaders = buildABLeaders(filtered);
  const recommendations = buildRecommendations({
    entries: filtered,
    patterns,
    stalls,
    gateFailures,
    abLeaders,
  });

  const report: ReflectReport = {
    generatedAt: new Date().toISOString(),
    totalRuns: filtered.length,
    empty: filtered.length === 0,
    patterns,
    stalls,
    gateFailures,
    abLeaders,
    recommendations,
  };
  if (options?.since) report.sinceIso = options.since.toISOString();
  return report;
}

/**
 * Markdown-ish text rendering. Mirrors the section layout used by
 * `formatStatsTable` so terminal output stays visually consistent.
 *
 * Empty reports render the canonical "No telemetry…" line so users see a
 * clean signal instead of a wall of blank tables.
 */
export function formatReflectReport(report: ReflectReport, opts: { path: string }): string {
  if (report.empty) {
    const sinceClause = report.sinceIso ? ` since ${report.sinceIso}` : '';
    return `No telemetry under ${opts.path}${sinceClause}. Run \`kova fix\` to populate it.`;
  }

  const lines: string[] = [];
  lines.push(`# kova reflect`);
  lines.push('');
  lines.push(
    `_Generated ${report.generatedAt}_  •  total runs: ${report.totalRuns}${
      report.sinceIso ? `  •  since ${report.sinceIso}` : ''
    }`,
  );
  lines.push('');
  lines.push('## Patterns');
  lines.push('| Metric           | Value    |');
  lines.push('|------------------|----------|');
  lines.push(`| Success rate     | ${report.patterns.successRate.toFixed(1)}% |`);
  lines.push(`| Partial rate     | ${report.patterns.partialRate.toFixed(1)}% |`);
  lines.push(`| Failure rate     | ${report.patterns.failureRate.toFixed(1)}% |`);
  lines.push(`| First-pass rate  | ${report.patterns.firstPassRate.toFixed(1)}% |`);
  lines.push('');

  lines.push('## Stalls');
  if (report.stalls.length === 0) {
    lines.push('_No issues with 2+ runs._');
  } else {
    lines.push('| Repo                | Issue | Runs | Last seen                 |');
    lines.push('|---------------------|-------|------|---------------------------|');
    for (const s of report.stalls) {
      lines.push(
        `| ${s.repo.padEnd(19)} | #${String(s.issue).padEnd(4)} | ${String(s.runs).padStart(4)} | ${s.lastSeen} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Gate failures');
  if (report.gateFailures.length === 0) {
    lines.push('_No failures recorded._');
  } else {
    lines.push('| Error                                              | Count |');
    lines.push('|----------------------------------------------------|-------|');
    for (const g of report.gateFailures) {
      const errPretty = g.error.length > 50 ? `${g.error.slice(0, 47)}...` : g.error.padEnd(50);
      lines.push(`| ${errPretty} | ${String(g.count).padStart(5)} |`);
    }
  }
  lines.push('');

  lines.push('## A/B leaders');
  if (report.abLeaders.length === 0) {
    lines.push('_No wave has enough runs (≥10 per variant) to declare a leader._');
  } else {
    lines.push('| Wave    | Winner | Runs | Success | Runners-up        |');
    lines.push('|---------|--------|------|---------|-------------------|');
    for (const l of report.abLeaders) {
      lines.push(
        `| ${l.wave.padEnd(7)} | ${l.winner.padEnd(6)} | ${String(l.winnerRuns).padStart(4)} | ${`${l.winnerSuccessRate.toFixed(1)}%`.padStart(7)} | ${(l.runners_up.join(', ') || '—').padEnd(17)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Recommendations');
  if (report.recommendations.length === 0) {
    lines.push('_No actionable signal found._');
  } else {
    for (const rec of report.recommendations) {
      lines.push(`- **${rec.action}** — ${rec.evidence}`);
    }
  }

  return lines.join('\n');
}
