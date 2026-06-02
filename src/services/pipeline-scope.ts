// Smart phase detection — pipeline scope (issue #283).
//
// The fix() orchestrator always ran the full Assess → Spec → Test → Impl →
// Quality → Review → Ship chain. For some classes of issue most of those
// waves are wasted work:
//   - "write tests" issues only need Assess → Spec → Test.
//   - Repos with existing failing tests already have the spec encoded in the
//     red tests; we should skip the Test wave and jump straight to Impl.
//   - Pure refactors don't change behavior, so writing new tests is wasted —
//     skip the Test wave and rely on existing tests as the regression net.
//   - Review-only requests (e.g. an external PR being adopted) should only
//     run Review → Ship.
//
// This module is the canonical home for that taxonomy and the detection
// logic. `fix()` calls `detectScope` once at startup, persists the result in
// `FixState`, and gates each wave on `isWaveSkippedByScope`.

import type { FixState, Issue, WaveName } from '../types/index.js';

/**
 * Pipeline scopes recognized by the fix orchestrator.
 *
 *  - `FULL`         — default; run every wave.
 *  - `TEST_ONLY`    — produce failing tests only (skip impl, quality, review,
 *                     ship). Used when the issue is literally "write tests for X".
 *  - `IMPL_ONLY`    — tests already exist and are red; skip the Test wave.
 *  - `REFACTOR`     — no behavior change; skip the Test wave and rely on the
 *                     existing test suite.
 *  - `REVIEW_ONLY`  — review an externally-produced diff; skip assess/spec/test/impl/quality.
 */
export type PipelineScope = 'FULL' | 'TEST_ONLY' | 'IMPL_ONLY' | 'REFACTOR' | 'REVIEW_ONLY';

/**
 * Static map of which waves each scope causes the orchestrator to skip.
 *
 * Kept as a plain readonly literal so callers can also use it for
 * human-readable log output ("Skipping: impl, quality, review, ship").
 */
export const WAVES_SKIPPED_BY_SCOPE: Readonly<Record<PipelineScope, readonly WaveName[]>> = {
  FULL: [],
  TEST_ONLY: ['impl', 'quality', 'review', 'ship'],
  IMPL_ONLY: ['test'],
  REFACTOR: ['test'],
  REVIEW_ONLY: ['assess', 'spec', 'test', 'impl', 'quality'],
} as const;

/**
 * Return true when `wave` is dropped by `scope`. Callers wrap their existing
 * `if (!shouldSkip(wave))` checkpoint-resume gate with an additional
 * `&& !isWaveSkippedByScope(scope, wave)`.
 */
export function isWaveSkippedByScope(scope: PipelineScope, wave: WaveName): boolean {
  return WAVES_SKIPPED_BY_SCOPE[scope].includes(wave);
}

/** Result returned by an optional test-runner probe. */
export interface TestProbeResult {
  hasFailures: boolean;
}

/** Inputs to `detectScope`. */
export interface DetectScopeInput {
  issue: Issue;
  /** The worktree path. Reserved for future probes (e.g. grep for test files). */
  workDir: string;
  /**
   * Optional probe that runs the existing test suite to detect pre-existing
   * red tests. When omitted, the IMPL_ONLY heuristic is not evaluated. Probe
   * errors are swallowed (treated as "no signal") to keep scope detection
   * non-blocking.
   */
  runTests?: (workDir: string) => Promise<TestProbeResult>;
}

/** Result returned by `detectScope`. */
export interface DetectScopeResult {
  scope: PipelineScope;
  reason: string;
}

const TEST_REQUEST_PATTERN = /\b(write|add|create)\s+tests?\b/i;

/**
 * Detect the pipeline scope for an issue. Label-driven scopes take precedence
 * over the runtime test probe (labels are an explicit user signal; the probe
 * is a best-effort heuristic). When no signal applies, returns `FULL`.
 *
 * Detection is intentionally cheap and side-effect-free aside from the
 * caller-supplied `runTests` probe. Callers should record the result in
 * `FixState` and log a single line at startup so the user sees which waves
 * were dropped.
 */
export async function detectScope(input: DetectScopeInput): Promise<DetectScopeResult> {
  const labels = input.issue.labels.map((l) => l.toLowerCase());

  if (labels.includes('review-only')) {
    return { scope: 'REVIEW_ONLY', reason: 'issue carries review-only label' };
  }

  if (labels.includes('test-only')) {
    return { scope: 'TEST_ONLY', reason: 'issue carries test-only label' };
  }

  if (labels.includes('refactor') || labels.includes('refactor-only')) {
    return { scope: 'REFACTOR', reason: 'issue carries refactor label' };
  }

  if (TEST_REQUEST_PATTERN.test(input.issue.title) || TEST_REQUEST_PATTERN.test(input.issue.body)) {
    return { scope: 'TEST_ONLY', reason: 'issue title/body requests writing tests' };
  }

  if (input.runTests) {
    try {
      const probe = await input.runTests(input.workDir);
      if (probe.hasFailures) {
        return { scope: 'IMPL_ONLY', reason: 'existing failing tests detected in worktree' };
      }
    } catch {
      // Probe failures are non-signal — fall through to FULL.
    }
  }

  return { scope: 'FULL', reason: 'no special signals — running full pipeline' };
}

/**
 * Persist the detected scope on `FixState` and mark every wave that the scope
 * drops as already-completed. The synthetic `WaveResult.artifact` carries a
 * `skipped: true, reason: 'pipeline-scope'` marker so downstream consumers
 * (cost report, PR body, history) can distinguish a scope-skip from a real
 * run while still treating the wave as terminal.
 *
 * Idempotent: re-applying the same scope to a state that already has waves
 * recorded does not duplicate entries.
 */
export function applyScopeToState(state: FixState, scope: PipelineScope, reason: string): void {
  state.pipelineScope = scope;
  state.pipelineScopeReason = reason;
  for (const wave of WAVES_SKIPPED_BY_SCOPE[scope]) {
    if (!state.completedWaves.includes(wave)) {
      state.completedWaves.push(wave);
    }
    state.waveResults[wave] = {
      wave,
      success: true,
      artifact: { skipped: true, reason: 'pipeline-scope' },
      duration: 0,
      cost: 0,
      turns: 0,
    };
  }
}

/** Format a one-line log entry describing the scope decision. */
export function formatScopeLogLine(scope: PipelineScope, reason: string): string {
  const skipped = WAVES_SKIPPED_BY_SCOPE[scope];
  const skippedStr = skipped.length === 0 ? 'none' : skipped.join(', ');
  return `Pipeline scope: ${scope}. Skipping: ${skippedStr}. Reason: ${reason}`;
}
