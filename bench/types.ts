// Shared types for the kova fix-success benchmark/eval harness.
//
// The harness lives in parallel to `src/` — it imports `fix()` lazily from
// `bench/fixApply.ts` so the runner, loader, and scorer modules don't pull
// the kova runtime into harness self-tests. The schema below is the
// contract between loader → runner → scorer.

import { z } from 'zod';

/**
 * A single fixture manifest stored as `fixture.json` under each fixture
 * directory. The shape is intentionally narrow — we want fixtures to be
 * easy to hand-author and easy to diff in review.
 */
export const FixtureManifestSchema = z.object({
  /** Stable identifier (used as filename, sort key, and JSONL fixtureId). */
  id: z.string().min(1),
  /** Short human-readable title. */
  title: z.string().min(1),
  /** Longer description shown in the report and passed to the agent. */
  description: z.string(),
  /**
   * Subdirectory (relative to the fixture dir) containing the seed repo.
   * Default `repo` keeps the on-disk layout uniform.
   */
  repoDir: z.string().default('repo'),
  /**
   * Issue passed to `fixApply` — the harness shapes this into a kova
   * `Issue` (number: 0, url: '', labels: []) when invoking real `fix()`.
   */
  issue: z.object({
    title: z.string().min(1),
    body: z.string(),
  }),
  /**
   * Shell command run inside the fixture worktree (post-fixApply) to
   * decide pass/fail. Exit 0 = pass, non-zero = fail. Default is `sh`,
   * so use POSIX-portable scripts.
   */
  acceptance: z.string().min(1),
  /**
   * Wall-clock cap for the acceptance command. Defaults to 10 minutes —
   * matches kova's per-wave default ballpark.
   */
  timeoutMs: z.number().int().positive().default(600_000),
  /**
   * Optional sanity list — files we expect to exist after a correct fix.
   * Not enforced; surfaced in the report.
   */
  expectedFiles: z.array(z.string()).optional(),
});

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

/**
 * The result of resolving a fixture on disk — manifest + absolute paths.
 * Returned from `loadFixtures` and consumed by `runFixture`.
 */
export interface LoadedFixture {
  manifest: FixtureManifest;
  /** Absolute path to the fixture directory (parent of `repo/` + `fixture.json`). */
  fixtureDir: string;
  /** Absolute path to the seed repo dir (copied into the workdir on each run). */
  repoSeedDir: string;
  /** The acceptance command, lifted out for runner convenience. */
  acceptanceCommand: string;
}

/**
 * Per-wave timing + cost emitted by `fixApply`. Lets the report break
 * down where time/cost went without requiring fixApply to surface the
 * full kova handoff structure.
 */
export interface WaveRecord {
  name: string;
  durationMs: number;
  cost: number;
}

/**
 * What `fixApply` returns to the runner. Cost is the dollar cost of the
 * underlying fix invocation; waves is an optional per-wave breakdown.
 */
export interface FixApplyResult {
  cost: number;
  waves: WaveRecord[];
}

/**
 * Context passed into `fixApply`. The workdir is the per-run temp copy of
 * the seed repo — fixApply should treat it as the kova "repo path".
 */
export interface FixApplyContext {
  workdir: string;
  issue: FixtureManifest['issue'];
  fixtureId: string;
}

/** The injection contract between runner and the real-or-fake fixer. */
export type FixApply = (ctx: FixApplyContext) => Promise<FixApplyResult>;

/**
 * One JSONL record per fixture run. `schemaVersion` lets downstream
 * consumers (later dashboards, regression diffs) detect breaking
 * shape changes.
 */
export interface FixtureRunResult {
  schemaVersion: 1;
  fixtureId: string;
  passed: boolean;
  durationMs: number;
  cost: number;
  waves: WaveRecord[];
  error?: string;
  acceptanceStdout?: string;
  acceptanceStderr?: string;
}

/** Aggregated summary printed at the end of a bench run. */
export interface BenchSummary {
  total: number;
  passed: number;
  failed: number;
  /** passed / total, or 0 when total is 0. */
  passRate: number;
  meanCost: number;
  meanDurationMs: number;
  perWaveMeans: Record<string, { durationMs: number; cost: number }>;
  costByFixture: Record<string, number>;
}
