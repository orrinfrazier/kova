// File-footprint prediction and tier partitioning for concurrent fix scheduling.
//
// Two pure functions:
//   1. extractFootprint(issue) — best-effort file-path extraction from issue body.
//   2. partitionTierByFootprint(tier, getFootprint) — splits a concurrency tier
//      into sub-tiers where overlapping-footprint issues are serialized while
//      disjoint-footprint issues stay parallel.
//
// Used by issue-scheduler.runFixesWithConcurrency when concurrency > 1.

import type { Issue } from '../types/index.js';

/**
 * Matches plausible source-file paths in prose. Heuristics:
 *  - At least one slash (avoids matching bare "foo.ts" sentence words).
 *  - Path-safe chars only ([A-Za-z0-9_./-]).
 *  - Ends with a common code extension.
 *  - Optional trailing :N or :N-M line-range suffix (stripped before return).
 *
 * Anchored with a left lookbehind that rejects characters indicating the path
 * is part of a URL (`/`, `:`, `=`) — URLs like https://x/foo.ts wouldn't match
 * anyway because the leading "://" disqualifies them, but this guards
 * fragments like "...com/path/file.ts" inside URLs that have been split.
 */
const PATH_REGEX =
  /(?<![A-Za-z0-9/:=._-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|yml|yaml|toml|rs|go|py|java|rb|sh))(?::\d+(?:-\d+)?)?/g;

/** URL prefixes whose hostnames/paths we should not mine for footprints. */
const URL_PREFIX = /(?:https?|ftp|file|git|ssh):\/\/[^\s]+/g;

/**
 * Extract a best-effort file footprint from an issue body.
 *
 * Returns deduplicated source-file paths mentioned in the body, with any
 * trailing `:N` or `:N-M` line-range suffix stripped. URLs are removed from
 * the body before path mining so URL path segments don't pollute the result.
 *
 * Returns `[]` when the body has no file-like paths (treated by the scheduler
 * as "unknown footprint — allow parallel").
 */
export function extractFootprint(issue: Issue): string[] {
  const body = issue.body ?? '';
  if (body.length === 0) return [];

  // Strip URLs first — they contain slashes and extensions and would otherwise
  // be mined as file paths.
  const cleaned = body.replace(URL_PREFIX, ' ');

  const seen = new Set<string>();
  for (const match of cleaned.matchAll(PATH_REGEX)) {
    const path = match[1];
    if (path) seen.add(path);
  }

  return Array.from(seen);
}

/**
 * Partition a tier of issue-indices into sub-tiers such that within each
 * sub-tier no two issues share any file in their footprints.
 *
 * Greedy first-fit coloring: iterate issues in input order; place each into
 * the first sub-tier whose accumulated file set is disjoint from the issue's
 * footprint. If no sub-tier fits, start a new one.
 *
 * Empty footprints are treated as "no known overlap" — those issues are
 * always placed in the FIRST sub-tier (they never block parallelism with
 * anyone, including each other).
 *
 * @param tier         Array of indices (into the issues[] array) for one
 *                     dependency tier.
 * @param getFootprint Function returning the file footprint for a given
 *                     tier-index value.
 * @returns            Array of sub-tiers; sub-tiers run sequentially, but
 *                     indices within a sub-tier may run in parallel.
 */
export function partitionTierByFootprint(tier: number[], getFootprint: (idx: number) => string[]): number[][] {
  if (tier.length === 0) return [];

  const subTiers: Array<{ files: Set<string>; members: number[] }> = [];

  for (const idx of tier) {
    const footprint = getFootprint(idx);

    if (footprint.length === 0) {
      // Unknown footprint → never blocks parallelism. Drop into sub-tier 0
      // (or create it if none exists yet).
      let first = subTiers[0];
      if (!first) {
        first = { files: new Set<string>(), members: [] };
        subTiers.push(first);
      }
      first.members.push(idx);
      continue;
    }

    let placed = false;
    for (const sub of subTiers) {
      let conflicts = false;
      for (const f of footprint) {
        if (sub.files.has(f)) {
          conflicts = true;
          break;
        }
      }
      if (!conflicts) {
        for (const f of footprint) sub.files.add(f);
        sub.members.push(idx);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const fresh = { files: new Set<string>(footprint), members: [idx] };
      subTiers.push(fresh);
    }
  }

  return subTiers.map((s) => s.members);
}
