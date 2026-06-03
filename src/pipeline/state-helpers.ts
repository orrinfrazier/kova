// FixState helpers extracted from fix.ts (issue #435).
//
// Pure helpers used by the orchestrator. None of these touch IO or globals —
// they're separated so fix.ts can stay focused on flow control.

import type { AssessResult, FailedPiece, FixState, Issue } from '../types/index.js';

/**
 * Append a TIEngine-emitted `FailedPiece` to `state.failedPieces`. Issue #432:
 * `FailedPiece` construction lives in `engines/ti.ts:buildFailedPiece`; this
 * helper is the orchestrator's single application point for the APPEND-style
 * accumulator (the only FixState field that cannot use the REPLACE-style
 * `EngineStateDelta`).
 */
export function appendFailedPiece(state: FixState, piece: FailedPiece | undefined): void {
  if (piece == null) return;
  state.failedPieces = [...(state.failedPieces ?? []), piece];
}

/** Create an empty FixState for the start of a run. */
export function createInitialState(issue: Issue, repo: string, repoPath: string, worktree?: string): FixState {
  return {
    issue,
    repo,
    repoPath,
    worktree,
    startedAt: new Date().toISOString(),
    completedWaves: [],
    waveResults: {},
    status: 'running',
  };
}

/** Extract "owner/repo" from a GitHub issue URL. Returns undefined if not parseable. */
export function extractOwnerRepo(issueUrl: string): string | undefined {
  const match = issueUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match?.[1];
}

/** Format the markdown comment posted to the issue when WAVE A grades D/F. */
export function formatSkipComment(assess: AssessResult, _issue: Issue): string {
  const files = assess.surface_area.files.length > 0 ? assess.surface_area.files.join(', ') : 'N/A';
  const recommendation =
    assess.grade === 'F'
      ? 'Break this issue into smaller, independently fixable pieces.'
      : 'Consider rescoping this issue to reduce surface area.';
  return [
    '## Kova Assessment — Skipped',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Grade** | ${assess.grade} |`,
    `| **Risk** | ${assess.risk} |`,
    `| **Estimated lines** | ${assess.surface_area.estimated_lines} |`,
    `| **Files** | ${files} |`,
    `| **Modules** | ${assess.surface_area.modules_affected.join(', ') || 'N/A'} |`,
    '',
    '### Reasoning',
    assess.reasoning,
    '',
    '### Recommendation',
    recommendation,
  ].join('\n');
}
