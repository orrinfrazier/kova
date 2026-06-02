// Resolve in-batch dependencies on a set of brainstormed issues.
//
// BrainstormIssue.dependencies is an array of free-text sibling titles
// (see src/types/waves.ts). Brainstorm produces those titles; createIssue
// only writes title/body/labels — so without a resolution pass the
// dependency information is dropped on the floor (issue #279).
//
// This module is the resolution pass: between approval and creation, it
//   1. matches each dependency title to a sibling issue in the batch
//      (case-insensitive, trimmed string equality on titles),
//   2. topologically orders the batch so a blocker is filed before any of
//      its dependents (Kahn's algorithm), and
//   3. surfaces titles that don't match any sibling so the caller can warn
//      the user rather than silently discarding them.
//
// On a cycle the implementation degrades gracefully — same shape as the
// existing prioritizeIssues fallback in src/services/prioritize.ts — by
// appending the un-emitted (still-blocked) issues at the end of the
// ordered output. Every issue is emitted exactly once.

import type { BrainstormIssue } from '../types/index.js';

/**
 * Per-issue list of dependency titles that did not match any sibling in
 * the batch. `title` is the issue's own title; `deps` lists the
 * unresolvable strings as they appeared on `issue.dependencies`.
 */
export interface UnresolvableEntry {
  title: string;
  deps: string[];
}

export interface ResolveBrainstormDependenciesResult {
  /** Topologically ordered batch (blockers before dependents). */
  ordered: BrainstormIssue[];
  /**
   * Issues whose `dependencies` referenced one or more titles not present
   * in the batch. The dependent issue is still emitted in `ordered` — only
   * the phantom dep titles are surfaced here.
   */
  unresolvable: UnresolvableEntry[];
}

/** Normalize a title for sibling matching: lowercase + trim. */
function normalize(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Resolve in-batch dependencies and topologically order brainstormed
 * issues. Inputs are not mutated.
 */
export function resolveBrainstormDependencies(issues: BrainstormIssue[]): ResolveBrainstormDependenciesResult {
  if (issues.length === 0) {
    return { ordered: [], unresolvable: [] };
  }

  // Title → index in the input array. Last-one-wins on duplicate titles
  // (consistent with how createIssue would handle them downstream — two
  // siblings sharing a title is a brainstorm bug, not this pass's concern).
  const titleIndex = new Map<string, number>();
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (issue === undefined) continue;
    titleIndex.set(normalize(issue.title), i);
  }

  // Build the resolved dependency graph and the unresolvable report.
  const resolvedDeps: number[][] = issues.map(() => []);
  const unresolvable: UnresolvableEntry[] = [];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (issue === undefined) continue;
    const deps = issue.dependencies ?? [];
    if (deps.length === 0) continue;

    const unresolvedForThisIssue: string[] = [];
    for (const depTitle of deps) {
      const resolved = titleIndex.get(normalize(depTitle));
      if (resolved === undefined || resolved === i) {
        // Self-references are nonsensical; treat them as unresolvable.
        if (resolved !== i) unresolvedForThisIssue.push(depTitle);
        continue;
      }
      const bucket = resolvedDeps[i];
      if (bucket === undefined) continue;
      if (!bucket.includes(resolved)) bucket.push(resolved);
    }

    if (unresolvedForThisIssue.length > 0) {
      unresolvable.push({ title: issue.title, deps: unresolvedForThisIssue });
    }
  }

  // Kahn's algorithm. inDegree[i] = number of unresolved blockers for i.
  const inDegree: number[] = issues.map((_, i) => resolvedDeps[i]?.length ?? 0);

  // Reverse adjacency: blocker → dependents.
  const dependents: number[][] = issues.map(() => []);
  for (let i = 0; i < issues.length; i++) {
    const blockers = resolvedDeps[i];
    if (blockers === undefined) continue;
    for (const blocker of blockers) {
      const bucket = dependents[blocker];
      if (bucket !== undefined) bucket.push(i);
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < issues.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const orderedIdx: number[] = [];
  const emitted = new Set<number>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (emitted.has(current)) continue;
    orderedIdx.push(current);
    emitted.add(current);

    const downstream = dependents[current] ?? [];
    for (const dep of downstream) {
      const remaining = (inDegree[dep] ?? 0) - 1;
      inDegree[dep] = remaining;
      if (remaining <= 0 && !emitted.has(dep)) {
        queue.push(dep);
      }
    }
  }

  // Cycle fallback: append any still-unemitted issues. Matches the
  // prioritizeIssues posture (see src/services/prioritize.ts) — never drop
  // an issue just because the dep graph is malformed.
  for (let i = 0; i < issues.length; i++) {
    if (!emitted.has(i)) orderedIdx.push(i);
  }

  const ordered: BrainstormIssue[] = [];
  for (const i of orderedIdx) {
    const issue = issues[i];
    if (issue !== undefined) ordered.push(issue);
  }

  return { ordered, unresolvable };
}
