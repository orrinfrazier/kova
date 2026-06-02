// Issue prioritization — score issues and order by dependency + priority.
//
// Formula is the canonical issue-score spec
// (~/.claude/skills/issue-score/SKILL.md §Formula). Keep this file in sync
// with that table; brainstorm / reflect / triage consume the breakdown.

import type { Issue } from '../types/index.js';

/** Per-factor breakdown surfaced alongside the final score (issue #253). */
export interface ScoreBreakdown {
  base_priority: number;
  dependency_bonus: number;
  blocked_penalty: number;
  /**
   * Freshness factor (issue #286): +10 when an open issue has gone
   * `FRESHNESS_STALE_DAYS` (30) days without activity. Bumps stale issues so
   * they don't get stranded behind a wall of fresher work.
   */
  freshness_bonus: number;
  quick_win_bonus: number;
  rescope_bonus: number;
}

export interface PrioritizedIssue {
  issue: Issue;
  score: number;
  blockedBy: number[];
  breakdown: ScoreBreakdown;
}

/**
 * Canonical base scores per priority bucket (issue-score SKILL.md §Formula).
 * `medium` and the no-priority default are both 30 — medium is the explicit
 * label for "this is normal-priority, please rank it normally".
 */
const PRIORITY_SCORES: Record<string, number> = {
  critical: 80,
  high: 60,
  medium: 30,
  low: 10,
};

const DEFAULT_PRIORITY = 30;
const DEPENDENCY_BONUS_PER_DEPENDENT = 5;
const DEPENDENCY_BONUS_CAP_DEPENDENTS = 5; // +25 max
const BLOCKED_PENALTY = -10;
const FRESHNESS_BONUS = 10;
const FRESHNESS_STALE_DAYS = 30;
const FRESHNESS_STALE_MS = FRESHNESS_STALE_DAYS * 24 * 60 * 60 * 1000;
const QUICK_WIN_BONUS = 5;
const RESCOPE_BONUS = 20;

const QUICK_WIN_LABELS = new Set(['low-complexity', 'good first issue', 'good-first-issue', 'quick-win']);
const RESCOPE_LABELS = new Set(['rescoped']);
const BLOCKED_LABELS = new Set(['blocked']);

/**
 * Normalize a label so callers can write either bare (`critical`) or
 * prefixed (`priority:critical`) — both must work during the priority-label
 * transition.
 */
function priorityKey(label: string): string | null {
  const lower = label.toLowerCase().trim();
  if (lower.startsWith('priority:')) {
    return lower.slice('priority:'.length);
  }
  if (lower in PRIORITY_SCORES) return lower;
  return null;
}

/**
 * A cross-repo dependency edge: the issue depends on `<repo>#<number>`, where
 * `repo` is an `owner/name` slug whenever possible (issue #287).
 *
 * - `owner/repo#N` → `{ repo: 'owner/repo', number: N }`
 * - `repo#N` with `defaultRepo='owner/me'` → `{ repo: 'owner/repo', number: N }`
 *   (the owner is inherited from defaultRepo; falls back to bare `repo` if
 *   defaultRepo has no owner)
 * - bare `#N` with `defaultRepo='owner/me'` → `{ repo: 'owner/me', number: N }`
 * - bare `#N` with no defaultRepo → omitted (cannot attribute)
 */
export interface CrossRepoDependency {
  repo: string;
  number: number;
}

/**
 * Single regex covering all three dependency forms (issue #287):
 *   - bare `#N`
 *   - `repo#N` (slug, no owner)
 *   - `owner/repo#N` (full slug)
 *
 * Capture groups:
 *   1 — owner (optional, may be undefined)
 *   2 — repo  (optional)
 *   3 — issue number
 *
 * Slug names must look like a repo (`[A-Za-z0-9._-]+`). The "bare #N" form
 * is the case where both groups 1 and 2 are undefined.
 */
const DEPENDENCY_PATTERN = /(?:blocked\s+by|depends\s+on)\s+(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)?#(\d+)/gi;

/** Extract issue numbers this issue depends on from body text. */
export function parseDependencies(body: string): number[] {
  const seen = new Set<number>();
  // Reset lastIndex so consecutive calls on the same RegExp object work.
  DEPENDENCY_PATTERN.lastIndex = 0;
  let match = DEPENDENCY_PATTERN.exec(body);
  while (match !== null) {
    const captured = match[3];
    if (captured !== undefined) {
      seen.add(Number.parseInt(captured, 10));
    }
    match = DEPENDENCY_PATTERN.exec(body);
  }
  return [...seen];
}

/**
 * Extract cross-repo dependency edges from body text (issue #287).
 *
 * Pass `defaultRepo` to attribute bare `#N` (and owner-less `repo#N`) forms to
 * the issue's own repo context. Without it, bare `#N` is dropped from the
 * cross-repo edge set because we can't attribute it.
 */
export function parseCrossRepoDependencies(body: string, defaultRepo?: string): CrossRepoDependency[] {
  const seen = new Map<string, CrossRepoDependency>();
  const defaultOwner = defaultRepo?.includes('/') ? defaultRepo.split('/')[0] : undefined;

  DEPENDENCY_PATTERN.lastIndex = 0;
  let match = DEPENDENCY_PATTERN.exec(body);
  while (match !== null) {
    const owner = match[1];
    const repo = match[2];
    const numStr = match[3];
    if (numStr === undefined) {
      match = DEPENDENCY_PATTERN.exec(body);
      continue;
    }
    const num = Number.parseInt(numStr, 10);

    let resolvedRepo: string | undefined;
    if (owner !== undefined && repo !== undefined) {
      resolvedRepo = `${owner}/${repo}`;
    } else if (repo !== undefined) {
      // `repo#N` — owner missing. Inherit defaultRepo's owner when available.
      resolvedRepo = defaultOwner !== undefined ? `${defaultOwner}/${repo}` : repo;
    } else {
      // bare `#N`. Only attributable when defaultRepo is set.
      resolvedRepo = defaultRepo;
    }

    if (resolvedRepo !== undefined) {
      const key = `${resolvedRepo}#${num}`;
      if (!seen.has(key)) {
        seen.set(key, { repo: resolvedRepo, number: num });
      }
    }
    match = DEPENDENCY_PATTERN.exec(body);
  }
  return [...seen.values()];
}

function basePriority(issue: Issue): number {
  for (const label of issue.labels) {
    const key = priorityKey(label);
    if (key !== null && key in PRIORITY_SCORES) {
      return PRIORITY_SCORES[key] ?? DEFAULT_PRIORITY;
    }
  }
  return DEFAULT_PRIORITY;
}

function dependencyBonus(issue: Issue, allIssues: Issue[]): number {
  // Count distinct downstream dependents (other issues whose body says
  // "blocked by #self" or "depends on #self"). Cap at the configured limit
  // so a single mega-blocker can't dominate the ranking.
  const dependentNumbers = new Set<number>();
  for (const other of allIssues) {
    if (other.number === issue.number) continue;
    if (parseDependencies(other.body).includes(issue.number)) {
      dependentNumbers.add(other.number);
    }
  }
  const dependentCount = Math.min(dependentNumbers.size, DEPENDENCY_BONUS_CAP_DEPENDENTS);
  return dependentCount * DEPENDENCY_BONUS_PER_DEPENDENT;
}

function blockedPenalty(issue: Issue, allIssues: Issue[]): number {
  // Penalty applies if either:
  //   - the issue has a `blocked` label, OR
  //   - the body says "blocked by #N" AND #N is still in the open set.
  const hasBlockedLabel = issue.labels.some((l) => BLOCKED_LABELS.has(l.toLowerCase()));
  if (hasBlockedLabel) return BLOCKED_PENALTY;

  const deps = parseDependencies(issue.body);
  const openNumbers = new Set(allIssues.map((i) => i.number));
  const isBlocked = deps.some((dep) => openNumbers.has(dep));
  return isBlocked ? BLOCKED_PENALTY : 0;
}

function quickWinBonus(issue: Issue): number {
  const hit = issue.labels.some((l) => QUICK_WIN_LABELS.has(l.toLowerCase()));
  return hit ? QUICK_WIN_BONUS : 0;
}

function rescopeBonus(issue: Issue): number {
  const hit = issue.labels.some((l) => RESCOPE_LABELS.has(l.toLowerCase()));
  return hit ? RESCOPE_BONUS : 0;
}

/**
 * Award `freshness_bonus` (+10) when an issue has gone ≥30 days without
 * activity. Prefers `updatedAt`; falls back to `createdAt` when `updatedAt`
 * is missing (e.g. legacy fixtures). Returns 0 if neither timestamp is set
 * or if either fails to parse — the formula degrades silently for
 * unrequested fields rather than throwing.
 *
 * Canonical formula: see `~/.claude/skills/issue-score/SKILL.md §Formula`.
 */
function freshnessBonus(issue: Issue, now: number): number {
  const ts = issue.updatedAt ?? issue.createdAt;
  if (ts === undefined) return 0;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return 0;
  const ageMs = now - parsed;
  return ageMs >= FRESHNESS_STALE_MS ? FRESHNESS_BONUS : 0;
}

/**
 * Compute the per-factor breakdown for an issue.
 *
 * `now` is injectable for testability — production callers should leave it
 * unset so `Date.now()` is used at call time.
 */
export function scoreBreakdown(issue: Issue, allIssues: Issue[], now: number = Date.now()): ScoreBreakdown {
  return {
    base_priority: basePriority(issue),
    dependency_bonus: dependencyBonus(issue, allIssues),
    blocked_penalty: blockedPenalty(issue, allIssues),
    freshness_bonus: freshnessBonus(issue, now),
    quick_win_bonus: quickWinBonus(issue),
    rescope_bonus: rescopeBonus(issue),
  };
}

/** Compute priority score for a single issue (sum of breakdown factors). */
export function scoreIssue(issue: Issue, allIssues: Issue[], now: number = Date.now()): number {
  const b = scoreBreakdown(issue, allIssues, now);
  return (
    b.base_priority + b.dependency_bonus + b.blocked_penalty + b.freshness_bonus + b.quick_win_bonus + b.rescope_bonus
  );
}

/** Prioritize issues: topological sort by dependencies, then by score descending. */
export function prioritizeIssues(issues: Issue[], now: number = Date.now()): PrioritizedIssue[] {
  if (issues.length === 0) return [];

  const issueMap = new Map<number, Issue>();
  for (const issue of issues) {
    issueMap.set(issue.number, issue);
  }

  // Build dependency graph (only for issues in the set)
  const deps = new Map<number, number[]>();
  for (const issue of issues) {
    deps.set(issue.number, parseDependencies(issue.body));
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<number, number>();
  for (const issue of issues) {
    inDegree.set(issue.number, 0);
  }
  for (const [num, blockers] of deps) {
    let count = 0;
    for (const b of blockers) {
      if (issueMap.has(b)) count++;
    }
    inDegree.set(num, count);
  }

  // Score each issue (with breakdown) for secondary sort
  const breakdowns = new Map<number, ScoreBreakdown>();
  const scores = new Map<number, number>();
  for (const issue of issues) {
    const breakdown = scoreBreakdown(issue, issues, now);
    breakdowns.set(issue.number, breakdown);
    scores.set(
      issue.number,
      breakdown.base_priority +
        breakdown.dependency_bonus +
        breakdown.blocked_penalty +
        breakdown.freshness_bonus +
        breakdown.quick_win_bonus +
        breakdown.rescope_bonus,
    );
  }

  const queue: number[] = [];
  for (const [num, deg] of inDegree) {
    if (deg === 0) queue.push(num);
  }
  // Sort queue by score descending so highest-priority unblocked issues come first
  queue.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));

  const sorted: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    sorted.push(current);

    // Find issues that depend on current
    for (const [num, blockers] of deps) {
      if (blockers.some((b) => b === current) && issueMap.has(current)) {
        const newDeg = (inDegree.get(num) ?? 0) - 1;
        inDegree.set(num, newDeg);
        if (newDeg === 0 && !sorted.includes(num) && !queue.includes(num)) {
          queue.push(num);
          // Re-sort queue
          queue.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
        }
      }
    }
  }

  // Handle cycles: any remaining issues not in sorted
  for (const issue of issues) {
    if (!sorted.includes(issue.number)) {
      sorted.push(issue.number);
    }
  }

  return sorted.flatMap((num) => {
    const issue = issueMap.get(num);
    if (!issue) return [];
    const breakdown = breakdowns.get(num) ?? scoreBreakdown(issue, issues, now);
    return [
      {
        issue,
        score: scores.get(num) ?? 0,
        blockedBy: deps.get(num) ?? [],
        breakdown,
      },
    ];
  });
}
