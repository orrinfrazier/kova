// Episodic memory client — local sqlite-vec backend (#433).
//
// Previously this module talked to a remote REST endpoint via `fetch`. Per
// ADR 002 (local-first vector search) and issue #433, the embedding endpoints
// are removed; this file now wraps the local sqlite-vec-backed `EpisodeStore`
// while keeping the same public surface (`queryEpisodeContext`, `recordEpisode`,
// `formatEpisodes`, `formatFailedEpisodes`, `buildEpisodeRecord`) so callers
// upstream do not change shape — only the local-DB `workDir` parameter is new.
//
// Filename retained as `*-rest.ts` for the duration of #433 → #434 to keep
// the patch minimal; #434's mass rename of `src/services/` will fold this in.

import { join as joinPath } from 'node:path';
import type { EpisodicMemoryConfig, FixState } from '../../types/config.js';
import type { CrossRepoQueryOptions, EpisodeContext, EpisodeRecord } from '../../types/memory.js';
import type { AssessResult, QualityResult, ReviewFinding, ReviewResult, SpecResult } from '../../types/waves.js';
import { log } from '../../utils/logger.js';
import { EpisodeStore } from './episode-store.js';

export type { CrossRepoQueryOptions, EpisodeContext, EpisodeRecord } from '../../types/memory.js';

/**
 * Resolve the on-disk path of the local episodes DB. Default location is
 * `{workDir}/.kova/episodes-vec.db`.
 */
function resolveEpisodeDbPath(workDir: string): string {
  return joinPath(workDir, '.kova', 'episodes-vec.db');
}

/**
 * Resolve any legacy FTS sidecar that lives alongside the vec DB. The
 * sqlite-vec store consumes it as a one-shot migration source on first
 * construction.
 */
function resolveFTSMigrationPath(workDir: string): string {
  return joinPath(workDir, '.kova', 'episode-fts.db');
}

/**
 * Open the local episode store. Caller is responsible for `close()`.
 */
function openStore(workDir: string): EpisodeStore | null {
  try {
    return new EpisodeStore(resolveEpisodeDbPath(workDir), {
      ftsMigrationPath: resolveFTSMigrationPath(workDir),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[episodes] Failed to open local sqlite-vec store: ${msg}`);
    return null;
  }
}

/**
 * Query the local episode store for past-issue learnings similar to `query`.
 * Returns an empty array when disabled or on any failure mode.
 */
export async function queryEpisodeContext(
  config: EpisodicMemoryConfig,
  query: string,
  options?: CrossRepoQueryOptions,
  workDir?: string,
): Promise<EpisodeContext[]> {
  if (!config.enabled) {
    return [];
  }
  if (!workDir) {
    log.warn('[episodes] Enabled but no workDir provided — skipping episodic context');
    return [];
  }

  const store = openStore(workDir);
  if (!store) return [];

  try {
    const repo = options?.repo ?? '';
    const results = store.queryEpisodes(query, {
      repo,
      top_k: config.max_episodes,
      cross_repo: config.cross_repo,
      language: options?.language,
      language_filter: config.language_filter,
      same_repo_weight: config.same_repo_weight,
    });
    if (results.length > 0) {
      log.info(`[episodes] Retrieved ${results.length} past episodes (sqlite-vec)`);
    }
    return results;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[episodes] Failed to query local store: ${msg} — skipping episodic context`);
    return [];
  } finally {
    store.close();
  }
}

/**
 * Format episodes into a markdown section for injection into assess/spec prompts.
 * Episodes are sorted by score descending (most relevant first).
 * When currentRepo is provided, shows [same-repo] or [cross-repo: X] attribution.
 */
export function formatEpisodes(episodes: EpisodeContext[], currentRepo?: string): string {
  if (episodes.length === 0) {
    return '';
  }

  const sorted = [...episodes].sort((a, b) => b.score - a.score);

  const sections = sorted.map((ep) => {
    const lines = [`### #${ep.issue_number}: ${ep.issue_title}`];

    if (currentRepo && ep.repo) {
      const tag = ep.repo === currentRepo ? '[same-repo]' : `[cross-repo: ${ep.repo}]`;
      lines.push(`- **Source:** ${tag}`);
    }

    lines.push(`- **Approach:** ${ep.approach}`, `- **Outcome:** ${ep.outcome}`, `- **Learning:** ${ep.learnings}`);

    return lines.join('\n');
  });

  return `## Learnings from similar past issues\n\n${sections.join('\n\n')}`;
}

/**
 * Format only failed episodes into a warning section for spec wave injection.
 * Filters to `outcome: 'failure'`, frames each as an approach to avoid.
 */
export function formatFailedEpisodes(episodes: EpisodeContext[], currentRepo?: string): string {
  const failed = episodes.filter((ep) => ep.outcome === 'failure');
  if (failed.length === 0) {
    return '';
  }

  const sorted = [...failed].sort((a, b) => b.score - a.score);

  const sections = sorted.map((ep) => {
    const lines = [`### #${ep.issue_number}: ${ep.issue_title}`];

    if (currentRepo && ep.repo) {
      const tag = ep.repo === currentRepo ? '[same-repo]' : `[cross-repo: ${ep.repo}]`;
      lines.push(`- **Source:** ${tag}`);
    }

    lines.push(
      `- **Approach:** ${ep.approach}`,
      `- **Outcome:** failed — Avoid this decomposition.`,
      `- **Learning:** ${ep.learnings}`,
    );

    return lines.join('\n');
  });

  return `## Past failed approaches — avoid repeating\n\n${sections.join('\n\n')}`;
}

/* ------------------------------------------------------------------ */
/*  Episode recording — local sqlite-vec store                          */
/* ------------------------------------------------------------------ */

/**
 * Build an episode record from completed fix state.
 * Extracts structured data from wave artifacts for persistence.
 */
export function buildEpisodeRecord(state: FixState): EpisodeRecord {
  const assessArtifact = state.waveResults.assess?.artifact as AssessResult | undefined;
  const specArtifact = state.waveResults.spec?.artifact as SpecResult | undefined;
  const implArtifact = state.waveResults.impl?.artifact as
    | { files_modified?: string[]; files_created?: string[] }
    | undefined;
  const qualityArtifact = state.waveResults.quality?.artifact as QualityResult | undefined;
  const reviewArtifact = state.waveResults.review?.artifact as ReviewResult | undefined;
  const shipArtifact = state.waveResults.ship?.artifact as { prUrl?: string } | undefined;

  const filesChanged = [...(implArtifact?.files_modified ?? []), ...(implArtifact?.files_created ?? [])];

  let outcome: EpisodeRecord['outcome'];
  if (shipArtifact?.prUrl) {
    outcome = 'pr_created';
  } else if (state.status === 'failed') {
    outcome = 'failed';
  } else if (assessArtifact && !assessArtifact.should_proceed) {
    outcome = 'skipped';
  } else {
    outcome = state.status === 'completed' ? 'pr_created' : 'failed';
  }

  const failedAtWave = state.status === 'failed' ? lastCompletedOrCurrent(state) : null;
  const isFailed = outcome === 'failed';

  // Approach fallback chain: spec.summary → assess.reasoning → issue.title
  const approach = specArtifact?.summary ?? assessArtifact?.reasoning ?? state.issue.title;

  // Failure context — only populated for failed episodes
  const errorMessage = isFailed ? state.error : undefined;

  const failedWaveOutput = isFailed ? buildFailedWaveOutput(state, failedAtWave) : undefined;

  const learnings = isFailed ? synthesizeLearnings(state) : undefined;

  let totalCost = 0;
  let totalDuration = 0;
  let totalTurns = 0;
  for (const result of Object.values(state.waveResults)) {
    if (result) {
      totalCost += result.cost;
      totalDuration += result.duration;
      totalTurns += result.turns;
    }
  }

  return {
    issue_number: state.issue.number,
    issue_title: state.issue.title,
    labels: state.issue.labels,
    repo: state.repo,
    approach,
    files_changed: filesChanged,
    quality_gates: qualityArtifact
      ? {
          lint: qualityArtifact.lint,
          typecheck: qualityArtifact.typecheck,
          tests: qualityArtifact.tests,
          coverage: qualityArtifact.coverage,
          audit: qualityArtifact.audit,
          all_passing: qualityArtifact.all_passing,
        }
      : null,
    review_findings: (reviewArtifact?.findings ?? []).map((f: ReviewFinding) => ({
      category: f.category,
      file: f.file,
      severity: f.severity,
      description: f.description,
    })),
    outcome,
    ...(errorMessage != null && { error_message: errorMessage }),
    ...(learnings != null && { learnings }),
    ...(failedWaveOutput != null && { failed_wave_output: failedWaveOutput }),
    failed_at_wave: failedAtWave,
    ...(state.diagnosis != null && { diagnosis: state.diagnosis }),
    ...(state.thrashingSignal != null && { thrashing_signal: state.thrashingSignal }),
    ...(state.retryAttempts != null && { retry_attempts: state.retryAttempts }),
    total_cost: totalCost,
    total_duration: totalDuration,
    total_turns: totalTurns,
    timestamp: new Date().toISOString(),
  };
}

function lastCompletedOrCurrent(state: FixState): string | null {
  if (state.completedWaves.length === 0) return 'assess';
  const WAVE_ORDER = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];
  const lastCompleted = state.completedWaves.at(-1);
  if (!lastCompleted) return 'assess';
  const idx = WAVE_ORDER.indexOf(lastCompleted);
  return idx < WAVE_ORDER.length - 1 ? (WAVE_ORDER[idx + 1] ?? lastCompleted) : lastCompleted;
}

const MAX_WAVE_OUTPUT_LENGTH = 500;

function buildFailedWaveOutput(state: FixState, failedAtWave: string | null): string | undefined {
  if (!failedAtWave) return undefined;

  // Get the last wave that actually ran — either the failed wave itself or the last completed one
  const waveResult = state.waveResults[failedAtWave as keyof typeof state.waveResults];
  const lastCompleted = state.completedWaves.at(-1);
  const targetResult = waveResult ?? (lastCompleted ? state.waveResults[lastCompleted] : undefined);

  if (!targetResult?.artifact) return undefined;

  const raw = JSON.stringify(targetResult.artifact);
  return raw.length > MAX_WAVE_OUTPUT_LENGTH ? raw.slice(-MAX_WAVE_OUTPUT_LENGTH) : raw;
}

function synthesizeLearnings(state: FixState): string | undefined {
  const pieces = state.failedPieces;
  if (pieces && pieces.length > 0) {
    return pieces
      .map((p) => {
        const diag = p.diagnosis;
        const failing =
          diag.tests_still_failing.length > 0 ? ` Tests still failing: ${diag.tests_still_failing.join(', ')}` : '';
        return `[${diag.category}] ${diag.theory}${failing}`;
      })
      .join('; ');
  }

  // Fallback: use state.error if present
  if (state.error) {
    const failedWave = lastCompletedOrCurrent(state);
    return `Failed at ${failedWave ?? 'unknown'}: ${state.error}`;
  }

  return undefined;
}

/**
 * Record a fix episode to the local sqlite-vec store. Graceful: returns false
 * and logs a warning on failure (never throws).
 */
export async function recordEpisode(
  config: EpisodicMemoryConfig,
  record: EpisodeRecord,
  workDir?: string,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }
  if (!workDir) {
    log.warn('[episodes] Enabled but no workDir provided — skipping recording');
    return false;
  }

  const store = openStore(workDir);
  if (!store) return false;
  try {
    store.upsertEpisode(record);
    log.info(`[episodes] Recorded episode for #${record.issue_number} (${record.outcome})`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[episodes] Failed to record episode: ${msg}`);
    return false;
  } finally {
    store.close();
  }
}
