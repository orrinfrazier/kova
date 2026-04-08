// Merge pipeline — process kova PR stack in dependency order.

import { resolveNonOverlappingConflicts } from '../services/conflict-resolver.js';
import { fetchKovaPRsWithStatus, type KovaPRWithStatus, mergePR, rebasePROnDefault } from '../services/github.js';
import { detectDefaultBranch } from '../services/worktree.js';
import type { RepoConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

export interface MergeOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  prNumber?: number | undefined;
  dryRun?: boolean | undefined;
  ciOverride?: 'require' | 'warn' | undefined;
}

export interface MergeResult {
  merged: number[];
  skipped: number[];
  failed: Array<{ number: number; reason: string }>;
  dryRun: boolean;
}

/** Topological sort using Kahn's algorithm. Falls back to ascending PR number on cycle. */
function topoSort(prs: KovaPRWithStatus[], deps: Map<number, number[]>): KovaPRWithStatus[] {
  const prNumbers = new Set(prs.map((pr) => pr.number));

  // Build adjacency list (only include edges between known PRs)
  const inDegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();
  for (const pr of prs) {
    inDegree.set(pr.number, 0);
    adjacency.set(pr.number, []);
  }

  for (const pr of prs) {
    const prDeps = deps.get(pr.number) ?? [];
    for (const dep of prDeps) {
      if (prNumbers.has(dep)) {
        adjacency.get(dep)?.push(pr.number);
        inDegree.set(pr.number, (inDegree.get(pr.number) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: number[] = [];
  for (const [num, degree] of inDegree) {
    if (degree === 0) queue.push(num);
  }
  queue.sort((a, b) => a - b); // deterministic: ascending within same level

  const sorted: number[] = [];
  while (queue.length > 0) {
    // queue.length > 0 is guaranteed by the while condition
    const current = queue.shift();
    if (current === undefined) break;
    sorted.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        // Insert in sorted position to maintain ascending order within level
        const insertIdx = queue.findIndex((n) => n > neighbor);
        if (insertIdx === -1) queue.push(neighbor);
        else queue.splice(insertIdx, 0, neighbor);
      }
    }
  }

  // Cycle detected: some PRs not in sorted output
  if (sorted.length < prs.length) {
    log.warn('[merge] Dependency cycle detected, falling back to ascending PR number order');
    return [...prs].sort((a, b) => a.number - b.number);
  }

  const prMap = new Map(prs.map((pr) => [pr.number, pr]));
  return sorted.flatMap((num) => {
    const pr = prMap.get(num);
    return pr !== undefined ? [pr] : [];
  });
}

export async function runMerge(options: MergeOptions): Promise<MergeResult> {
  const { repoPath, config, prNumber, dryRun = false } = options;
  const ciPolicy = options.ciOverride ?? config.rules.ci_merge ?? 'require';

  const result: MergeResult = { merged: [], skipped: [], failed: [], dryRun };

  const allPRs = await fetchKovaPRsWithStatus(repoPath);

  if (allPRs.length === 0) return result;

  // Filter to single PR if specified
  let candidates: KovaPRWithStatus[];
  if (prNumber !== undefined) {
    candidates = allPRs.filter((pr) => pr.number === prNumber);
    if (candidates.length === 0) {
      result.failed.push({ number: prNumber, reason: 'PR not found among kova PRs' });
      return result;
    }
  } else {
    candidates = [...allPRs];
  }

  // Build dependency map from PR objects (populated by fetchKovaPRsWithStatus or test fixtures)
  const deps = new Map<number, number[]>();
  for (const pr of candidates) {
    const prDeps =
      'dependencies' in pr ? ((pr as KovaPRWithStatus & { dependencies?: number[] }).dependencies ?? []) : [];
    deps.set(pr.number, prDeps);
  }

  // Sort by dependency order
  const ordered = topoSort(candidates, deps);

  if (dryRun) {
    log.info(
      `[merge] Dry run — would merge ${ordered.length} PR(s) in order: ${ordered.map((pr) => `#${pr.number}`).join(', ')}`,
    );
    result.skipped = ordered.map((pr) => pr.number);
    return result;
  }

  const remainingPRNumbers = new Set(ordered.map((pr) => pr.number));
  const branchMap = new Map(ordered.map((pr) => [pr.number, pr.branch]));
  const defaultBranch = await detectDefaultBranch(repoPath);

  for (const pr of ordered) {
    // CI status check
    if (ciPolicy === 'require' && pr.ciStatus !== 'success' && pr.ciStatus !== 'unknown') {
      result.failed.push({ number: pr.number, reason: `CI status is '${pr.ciStatus}'` });
      remainingPRNumbers.delete(pr.number);
      continue;
    }

    if (ciPolicy === 'warn' && pr.ciStatus !== 'success' && pr.ciStatus !== 'unknown') {
      log.warn(`[merge] PR #${pr.number} has CI status '${pr.ciStatus}', proceeding anyway (ci_merge: warn)`);
    }

    try {
      await mergePR(repoPath, pr.number);
      result.merged.push(pr.number);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error(`[merge] Failed to merge PR #${pr.number}: ${reason}`);
      result.failed.push({ number: pr.number, reason });
    }
    remainingPRNumbers.delete(pr.number);

    // Rebase remaining unmerged PRs onto updated default branch
    for (const remaining of remainingPRNumbers) {
      try {
        await rebasePROnDefault(repoPath, remaining);
      } catch {
        // gh pr update-branch failed — try local conflict resolution
        const branch = branchMap.get(remaining);
        if (branch) {
          try {
            const resolution = await resolveNonOverlappingConflicts(repoPath, branch, defaultBranch);
            if (resolution.resolved) {
              log.info(
                `[merge] Auto-resolved non-overlapping conflicts for PR #${remaining}: ${resolution.autoResolvedFiles.join(', ')}`,
              );
            } else {
              log.warn(
                `[merge] True conflicts in PR #${remaining}: ${resolution.trueConflictFiles.join(', ')}`,
              );
            }
          } catch (resolveError) {
            log.warn(
              `[merge] Failed to resolve conflicts for PR #${remaining}: ${resolveError instanceof Error ? resolveError.message : String(resolveError)}`,
            );
          }
        }
      }
    }
  }

  return result;
}
