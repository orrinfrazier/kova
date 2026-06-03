// Episodic memory REST client — queries past-issue learnings, formats them
// for prompt injection, builds an EpisodeRecord from completed fix state,
// and persists it back to the episodic memory endpoint.

import type { EpisodicMemoryConfig, FixState } from '../../types/config.js';
import type { CrossRepoQueryOptions, EpisodeContext, EpisodeRecord } from '../../types/memory.js';
import type { AssessResult, QualityResult, ReviewFinding, ReviewResult, SpecResult } from '../../types/waves.js';
import { log } from '../../utils/logger.js';

export type { CrossRepoQueryOptions, EpisodeContext, EpisodeRecord } from '../../types/memory.js';

interface EpisodeContextResponse {
  episodes?: EpisodeContext[];
}

/**
 * Query the episodic memory REST endpoint for past issue learnings similar to the given query.
 * When cross_repo is enabled, searches across all repos with same-repo weighting.
 * When language_filter is enabled, filters by language to avoid irrelevant episodes.
 * Returns an empty array if disabled, on error, or if the response is malformed.
 */
export async function queryEpisodeContext(
  config: EpisodicMemoryConfig,
  query: string,
  options?: CrossRepoQueryOptions,
): Promise<EpisodeContext[]> {
  if (!config.enabled) {
    return [];
  }

  if (!config.endpoint) {
    log.warn('[episodes] Enabled but no endpoint configured — skipping');
    return [];
  }

  try {
    const body: Record<string, unknown> = { query, top_k: config.max_episodes };

    if (options?.repo) {
      body.repo = options.repo;
      body.cross_repo = config.cross_repo;
    }

    if (config.language_filter && options?.language) {
      body.language = options.language;
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      log.warn(`[episodes] Endpoint returned ${response.status} — skipping episodic context`);
      return [];
    }

    const data = (await response.json()) as EpisodeContextResponse;

    if (!data.episodes || !Array.isArray(data.episodes)) {
      log.warn('[episodes] Malformed response (missing episodes array) — skipping');
      return [];
    }

    const capped = data.episodes.slice(0, config.max_episodes);
    log.info(`[episodes] Retrieved ${capped.length} past episodes`);
    return capped;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[episodes] Failed to query endpoint: ${msg} — skipping episodic context`);
    return [];
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
/*  Episode recording — REST endpoint (post-fix persistence)           */
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
 * Record a fix episode to the episodic memory endpoint.
 * Graceful degradation: logs a warning on failure, never throws.
 */
export async function recordEpisode(config: EpisodicMemoryConfig, record: EpisodeRecord): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  if (!config.endpoint) {
    log.warn('[episodes] Enabled but no endpoint configured — skipping recording');
    return false;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });

    if (!response.ok) {
      log.warn(`[episodes] Recording endpoint returned ${response.status} — episode not saved`);
      return false;
    }

    log.info(`[episodes] Recorded episode for #${record.issue_number} (${record.outcome})`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[episodes] Failed to record episode: ${msg}`);
    return false;
  }
}
