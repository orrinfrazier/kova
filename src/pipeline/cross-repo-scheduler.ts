// Cross-repo dependency scheduler (issue #287).
//
// Companion to `issue-scheduler.ts` (intra-repo). Where `buildDependencyTiers`
// orders ISSUES within a single repo, this module orders REPOS in a
// multi-repo auto run so that a blocker repo runs to completion before any
// dependent repo starts.
//
// Why a separate module: `runAutoMultiRepoParallel` drives whole-repo
// `runAuto` calls — the unit of scheduling is the repo, not an issue. The
// per-issue tier logic still runs inside each repo's `fixLoop`.

import { parseCrossRepoDependencies } from '../services/prioritize.js';
import type { Issue } from '../types/index.js';

/** One repo's slice in a cross-repo tier. */
export interface RepoTierEntry {
  repoName: string;
  issues: Issue[];
}

export interface BuildCrossRepoTiersInput {
  /** Issues fetched per repo, keyed by the repo's config name. */
  reposByName: Map<string, Issue[]>;
  /**
   * `owner/name` slug per repo (used to resolve `owner/repo#N` deps to a
   * configured repo). Repos without a slug can still appear in the tiering;
   * they just won't be the target of cross-repo edges.
   */
  slugByName: Map<string, string>;
}

/**
 * Build tiers of repos such that every repo in tier N has no cross-repo
 * blockers among repos in tier N+1 or later.
 *
 * - Same-repo dependencies are NOT considered here — they are handled
 *   per-repo by `buildDependencyTiers` inside `fixLoop`.
 * - References to repos not present in `reposByName` are ignored (external
 *   repos can't be sequenced by this run).
 * - Cycles are broken by collapsing the unresolved remainder into a single
 *   final tier (matches `buildDependencyTiers`' behavior).
 *
 * Returns an empty array when given no repos.
 */
export function buildCrossRepoTiers(input: BuildCrossRepoTiersInput): RepoTierEntry[][] {
  const { reposByName, slugByName } = input;
  if (reposByName.size === 0) return [];

  // Invert the slug map so dep-edges (`owner/repo#N`) can resolve to a repo name.
  const nameBySlug = new Map<string, string>();
  for (const [name, slug] of slugByName) {
    nameBySlug.set(slug, name);
  }

  // For each repo, compute the set of OTHER configured repo names this repo
  // depends on (any issue in this repo references an issue in that other repo).
  const blockerNamesByRepo = new Map<string, Set<string>>();
  for (const [repoName, issues] of reposByName) {
    const blockers = new Set<string>();
    const defaultRepo = slugByName.get(repoName);
    for (const issue of issues) {
      const deps = parseCrossRepoDependencies(issue.body, defaultRepo);
      for (const dep of deps) {
        const otherName = nameBySlug.get(dep.repo);
        if (otherName !== undefined && otherName !== repoName) {
          blockers.add(otherName);
        }
      }
    }
    blockerNamesByRepo.set(repoName, blockers);
  }

  // Tier by inverse topo: place all repos whose blockers are already placed.
  const placed = new Set<string>();
  const tiers: RepoTierEntry[][] = [];
  const allRepoNames = [...reposByName.keys()];

  while (placed.size < allRepoNames.length) {
    const tierNames: string[] = [];
    for (const name of allRepoNames) {
      if (placed.has(name)) continue;
      const blockers = blockerNamesByRepo.get(name) ?? new Set<string>();
      const ready = [...blockers].every((b) => placed.has(b));
      if (ready) tierNames.push(name);
    }

    if (tierNames.length === 0) {
      // Cycle remainder — collapse into a single final tier.
      for (const name of allRepoNames) {
        if (!placed.has(name)) tierNames.push(name);
      }
    }

    const tier: RepoTierEntry[] = [];
    for (const name of tierNames) {
      const issues = reposByName.get(name) ?? [];
      tier.push({ repoName: name, issues });
      placed.add(name);
    }
    tiers.push(tier);
  }

  return tiers;
}
