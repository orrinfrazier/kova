// Issue prioritization — score issues and order by dependency + priority.

import type { Issue } from '../types/index.js';

export interface PrioritizedIssue {
  issue: Issue;
  score: number;
  blockedBy: number[];
}

const PRIORITY_SCORES: Record<string, number> = {
  critical: 80,
  high: 60,
  medium: 40,
  low: 20,
};

const QUICK_WIN_LABELS = new Set(['low-complexity', 'good first issue']);

/** Extract issue numbers this issue depends on from body text. */
export function parseDependencies(body: string): number[] {
  const pattern = /(?:blocked\s+by|depends\s+on)\s+#(\d+)/gi;
  const seen = new Set<number>();
  let match = pattern.exec(body);
  while (match !== null) {
    const captured = match[1];
    if (captured !== undefined) {
      seen.add(Number.parseInt(captured, 10));
    }
    match = pattern.exec(body);
  }
  return [...seen];
}

/** Compute priority score for a single issue. */
export function scoreIssue(issue: Issue, allIssues: Issue[]): number {
  // Base score from priority label
  let score = 40; // default when no priority label
  for (const label of issue.labels) {
    const labelLower = label.toLowerCase();
    if (labelLower in PRIORITY_SCORES) {
      score = PRIORITY_SCORES[labelLower] ?? 40;
      break;
    }
  }

  // +10 if this issue blocks others
  const blocksOthers = allIssues.some((other) => {
    if (other.number === issue.number) return false;
    return parseDependencies(other.body).includes(issue.number);
  });
  if (blocksOthers) score += 10;

  // -10 if blocked by an open issue in the set
  const deps = parseDependencies(issue.body);
  const openNumbers = new Set(allIssues.map((i) => i.number));
  const isBlocked = deps.some((dep) => openNumbers.has(dep));
  if (isBlocked) score -= 10;

  // +5 for quick wins
  const isQuickWin = issue.labels.some((l) => QUICK_WIN_LABELS.has(l.toLowerCase()));
  if (isQuickWin) score += 5;

  return score;
}

/** Prioritize issues: topological sort by dependencies, then by score descending. */
export function prioritizeIssues(issues: Issue[]): PrioritizedIssue[] {
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

  // Score each issue for secondary sort
  const scores = new Map<number, number>();
  for (const issue of issues) {
    scores.set(issue.number, scoreIssue(issue, issues));
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
    return [{ issue, score: scores.get(num) ?? 0, blockedBy: deps.get(num) ?? [] }];
  });
}
