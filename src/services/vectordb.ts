// Vector DB service — two modes:
// 1. REST endpoint client (queryCodeContext / formatCodeChunks) — for pipeline context injection
// 2. pgvector client (VectorDBClient / upsert / query) — for direct DB operations

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EpisodicMemoryConfig, FixState, VectorDBConfig } from '../types/config.js';
import type { FeedbackType } from '../types/vectordb.js';
import type { AssessResult, QualityResult, ReviewFinding, ReviewResult, SpecResult } from '../types/waves.js';
import { log } from '../utils/logger.js';
import type { Chunk } from './chunker.js';

/* ================================================================== */
/*  REST endpoint client (used by pipeline waves)                      */
/* ================================================================== */

export interface CodeChunk {
  file: string;
  content: string;
  score: number;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

interface VectorDBResponse {
  chunks?: CodeChunk[];
}

/**
 * Query the vector DB for code chunks relevant to the given query text.
 * Returns an empty array if disabled, on error, or if the response is malformed.
 */
export async function queryCodeContext(config: VectorDBConfig, query: string): Promise<CodeChunk[]> {
  if (!config.enabled) {
    return [];
  }

  if (!config.endpoint) {
    log.warn('[vectordb] Enabled but no endpoint configured — skipping');
    return [];
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: config.top_k }),
    });

    if (!response.ok) {
      log.warn(`[vectordb] Endpoint returned ${response.status} — skipping context injection`);
      return [];
    }

    const data = (await response.json()) as VectorDBResponse;

    if (!data.chunks || !Array.isArray(data.chunks)) {
      log.warn('[vectordb] Malformed response (missing chunks array) — skipping');
      return [];
    }

    log.info(`[vectordb] Retrieved ${data.chunks.length} code chunks`);
    return data.chunks;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[vectordb] Failed to query endpoint: ${msg} — skipping context injection`);
    return [];
  }
}

/**
 * Format code chunks into a markdown section for injection into wave prompts.
 * Chunks are sorted by score descending (most relevant first).
 */
export function formatCodeChunks(chunks: CodeChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }

  const sorted = [...chunks].sort((a, b) => b.score - a.score);

  const sections = sorted.map((chunk) => {
    const lineInfo = chunk.startLine != null && chunk.endLine != null ? ` (L${chunk.startLine}-${chunk.endLine})` : '';
    return `### ${chunk.file}${lineInfo}\n\n\`\`\`\n${chunk.content}\n\`\`\``;
  });

  return `## Relevant code from the codebase\n\n${sections.join('\n\n')}`;
}

/* ================================================================== */
/*  Episodic memory — REST endpoint (pipeline context injection)       */
/* ================================================================== */

export interface EpisodeContext {
  issue_number: number;
  issue_title: string;
  approach: string;
  outcome: 'success' | 'partial' | 'failure';
  learnings: string;
  score: number;
  repo?: string | undefined;
}

interface EpisodeContextResponse {
  episodes?: EpisodeContext[];
}

export interface CrossRepoQueryOptions {
  repo?: string | undefined;
  language?: string | undefined;
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

export interface EpisodeRecord {
  issue_number: number;
  issue_title: string;
  labels: string[];
  repo: string;
  language?: string | undefined;
  approach: string;
  files_changed: string[];
  quality_gates: {
    lint: string;
    typecheck: string;
    tests: string;
    coverage?: number | undefined;
    audit: string;
    all_passing: boolean;
  } | null;
  review_findings: Array<{
    category: string;
    file: string;
    severity: string;
    description: string;
  }>;
  outcome: 'pr_created' | 'failed' | 'skipped';
  error_message?: string | undefined;
  learnings?: string | undefined;
  failed_wave_output?: string | undefined;
  failed_at_wave: string | null;
  diagnosis?: 'SPEC_WRONG' | 'APPROACH_WRONG' | 'MISSING_CONTEXT' | 'STUCK' | undefined;
  thrashing_signal?: 'SAME_FILES' | 'DIFFERENT_FILES' | 'NORMAL' | 'INSUFFICIENT_DATA' | undefined;
  retry_attempts?: number | undefined;
  total_cost: number;
  total_duration: number;
  total_turns: number;
  timestamp: string;
}

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
    log.warn('[episodes] Enabled but no endpoint configured \u2014 skipping recording');
    return false;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });

    if (!response.ok) {
      log.warn(`[episodes] Recording endpoint returned ${response.status} \u2014 episode not saved`);
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

/* ================================================================== */
/*  pgvector client (direct DB operations)                             */
/* ================================================================== */

export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface VectorDBClient {
  pool: PoolLike;
  embed: (text: string) => Promise<number[]>;
}

export interface VectorDBClientConfig {
  connectionString?: string;
  embedFn: (text: string) => Promise<number[]>;
}

export interface EmbeddingChunk {
  filePath: string;
  text: string;
}

export interface EpisodeInput {
  repo: string;
  issue_number: number;
  issue_title: string;
  approach: string;
  outcome: 'success' | 'fail';
  files_changed: string[];
  language?: string | undefined;
}

export interface PatternInput {
  repo: string;
  pattern_description: string;
  frequency: number;
  success_rate: number;
}

/* ------------------------------------------------------------------ */
/*  createVectorDBClient                                                */
/* ------------------------------------------------------------------ */

export function createVectorDBClient(config: VectorDBClientConfig): VectorDBClient {
  const connectionString = config.connectionString ?? 'postgresql://localhost:5433/kova';

  // Pool is not created eagerly — callers provide their own pool via
  // the client interface in tests, and production code will supply a real
  // pg.Pool. The factory just stores the connection string for later use.
  const pool: PoolLike = {
    async query(): Promise<{ rows: unknown[] }> {
      throw new Error(
        `pg pool not initialised. Call initPool() or provide a pool. connectionString=${connectionString}`,
      );
    },
  };

  return {
    pool,
    embed: config.embedFn,
  };
}

/* ------------------------------------------------------------------ */
/*  upsertCodeEmbeddings                                               */
/* ------------------------------------------------------------------ */

const UPSERT_CODE_SQL = `
INSERT INTO code_embeddings (repo, file_path, chunk_text, embedding)
VALUES ($1, $2, $3, $4)
ON CONFLICT (repo, file_path, chunk_text)
DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now()
`;

export async function upsertCodeEmbeddings(
  client: VectorDBClient,
  repo: string,
  chunks: EmbeddingChunk[],
): Promise<number> {
  if (chunks.length === 0) {
    return 0;
  }

  for (const chunk of chunks) {
    const embedding = await client.embed(chunk.text);
    await client.pool.query(UPSERT_CODE_SQL, [repo, chunk.filePath, chunk.text, JSON.stringify(embedding)]);
  }

  return chunks.length;
}

/* ------------------------------------------------------------------ */
/*  queryCodeEmbeddings                                                */
/* ------------------------------------------------------------------ */

const QUERY_CODE_SQL = `
SELECT id, repo, file_path, chunk_text, updated_at
FROM code_embeddings
WHERE repo = $1
ORDER BY embedding <-> $2
LIMIT $3
`;

export async function queryCodeEmbeddings(
  client: VectorDBClient,
  repo: string,
  query: string,
  limit = 10,
): Promise<unknown[]> {
  const embedding = await client.embed(query);
  const result = await client.pool.query(QUERY_CODE_SQL, [repo, JSON.stringify(embedding), limit]);
  return result.rows;
}

/* ------------------------------------------------------------------ */
/*  insertEpisode                                                       */
/* ------------------------------------------------------------------ */

const INSERT_EPISODE_SQL = `
INSERT INTO episodes (repo, issue_number, issue_title, approach, outcome, files_changed, embedding, language)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

export async function insertEpisode(client: VectorDBClient, episode: EpisodeInput): Promise<void> {
  const text = `${episode.issue_title} ${episode.approach} ${episode.outcome} ${episode.files_changed.join(' ')}`;
  const embedding = await client.embed(text);
  await client.pool.query(INSERT_EPISODE_SQL, [
    episode.repo,
    episode.issue_number,
    episode.issue_title,
    episode.approach,
    episode.outcome,
    episode.files_changed,
    JSON.stringify(embedding),
    episode.language ?? null,
  ]);
}

/* ------------------------------------------------------------------ */
/*  queryEpisodes                                                       */
/* ------------------------------------------------------------------ */

const QUERY_EPISODES_SQL = `
SELECT id, repo, issue_number, issue_title, approach, outcome, files_changed, created_at
FROM episodes
WHERE repo = $1
ORDER BY embedding <-> $2
LIMIT $3
`;

export interface CrossRepoEpisodeOptions {
  crossRepo?: boolean | undefined;
  language?: string | undefined;
  sameRepoWeight?: number | undefined;
}

export async function queryEpisodes(
  client: VectorDBClient,
  repo: string,
  query: string,
  limit = 5,
  options?: CrossRepoEpisodeOptions,
): Promise<unknown[]> {
  const embedding = await client.embed(query);
  const embeddingJson = JSON.stringify(embedding);

  if (options?.crossRepo) {
    const weight = options.sameRepoWeight ?? 1.5;

    if (options.language) {
      const sql = `
SELECT id, repo, issue_number, issue_title, approach, outcome, files_changed, created_at,
  CASE WHEN repo = $1 THEN (embedding <-> $2) / ${weight} ELSE embedding <-> $2 END AS weighted_distance
FROM episodes
WHERE language = $4
ORDER BY weighted_distance
LIMIT $3
`;
      const result = await client.pool.query(sql, [repo, embeddingJson, limit, options.language]);
      return result.rows;
    }

    const sql = `
SELECT id, repo, issue_number, issue_title, approach, outcome, files_changed, created_at,
  CASE WHEN repo = $1 THEN (embedding <-> $2) / ${weight} ELSE embedding <-> $2 END AS weighted_distance
FROM episodes
ORDER BY weighted_distance
LIMIT $3
`;
    const result = await client.pool.query(sql, [repo, embeddingJson, limit]);
    return result.rows;
  }

  const result = await client.pool.query(QUERY_EPISODES_SQL, [repo, embeddingJson, limit]);
  return result.rows;
}

/* ------------------------------------------------------------------ */
/*  upsertPattern                                                       */
/* ------------------------------------------------------------------ */

const UPSERT_PATTERN_SQL = `
INSERT INTO patterns (repo, pattern_description, frequency, success_rate, embedding)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (repo, pattern_description)
DO UPDATE SET frequency = EXCLUDED.frequency, success_rate = EXCLUDED.success_rate, embedding = EXCLUDED.embedding, updated_at = now()
`;

export async function upsertPattern(client: VectorDBClient, pattern: PatternInput): Promise<void> {
  const text = pattern.pattern_description;
  const embedding = await client.embed(text);
  await client.pool.query(UPSERT_PATTERN_SQL, [
    pattern.repo,
    pattern.pattern_description,
    pattern.frequency,
    pattern.success_rate,
    JSON.stringify(embedding),
  ]);
}

/* ------------------------------------------------------------------ */
/*  queryPatterns                                                       */
/* ------------------------------------------------------------------ */

const QUERY_PATTERNS_SQL = `
SELECT id, repo, pattern_description, frequency, success_rate, updated_at
FROM patterns
WHERE repo = $1
ORDER BY embedding <-> $2
LIMIT $3
`;

export async function queryPatterns(
  client: VectorDBClient,
  repo: string,
  query: string,
  limit = 5,
): Promise<unknown[]> {
  const embedding = await client.embed(query);
  const result = await client.pool.query(QUERY_PATTERNS_SQL, [repo, JSON.stringify(embedding), limit]);
  return result.rows;
}

/* ================================================================== */
/*  Review feedback — classification, recording, pgvector ops          */
/* ================================================================== */

export interface ReviewFeedbackRecord {
  repo: string;
  pr_number: number;
  feedback_type: string;
  comment_text: string;
  file_path?: string | undefined;
  author?: string | undefined;
}

export type ReviewFeedbackInput = ReviewFeedbackRecord;

export interface ReviewFeedbackItem {
  feedback_type: string;
  pr_number: number;
  comment_text: string;
  file_path?: string | undefined;
}

/* ------------------------------------------------------------------ */
/*  classifyFeedback                                                    */
/* ------------------------------------------------------------------ */

const FEEDBACK_KEYWORDS: Array<[RegExp, FeedbackType]> = [
  [/\btest\b/i, 'missing_test'],
  [/\bsecurity\b/i, 'security_concern'],
  [/\binjection\b/i, 'security_concern'],
  [/\bauth\b/i, 'security_concern'],
  [/\bnaming\b/i, 'naming'],
  [/\brename\b/i, 'naming'],
  [/\barchitecture\b/i, 'architecture'],
  [/\bstructure\b/i, 'architecture'],
  [/\bpattern\b/i, 'architecture'],
  [/\bperformance\b/i, 'performance'],
  [/\bslow\b/i, 'performance'],
  [/\bmemory\b/i, 'performance'],
  [/\bdoc\b/i, 'documentation'],
  [/\bcomment\b/i, 'documentation'],
  [/\breadme\b/i, 'documentation'],
  [/\blogic\b/i, 'logic_error'],
  [/\bbug\b/i, 'logic_error'],
  [/\bincorrect\b/i, 'logic_error'],
  [/\bwrong\b/i, 'logic_error'],
  [/\bstyle\b/i, 'style_issue'],
  [/\bformat\b/i, 'style_issue'],
];

export function classifyFeedback(text: string): FeedbackType {
  for (const [regex, type] of FEEDBACK_KEYWORDS) {
    if (regex.test(text)) {
      return type;
    }
  }
  return 'style_issue';
}

/* ------------------------------------------------------------------ */
/*  recordReviewFeedback — REST endpoint (graceful degradation)         */
/* ------------------------------------------------------------------ */

export async function recordReviewFeedback(
  config: EpisodicMemoryConfig,
  records: ReviewFeedbackRecord[],
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  if (!config.endpoint) {
    log.warn('[review-feedback] Enabled but no endpoint configured — skipping recording');
    return false;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(records),
    });

    if (!response.ok) {
      log.warn(`[review-feedback] Recording endpoint returned ${response.status} — feedback not saved`);
      return false;
    }

    log.info(`[review-feedback] Recorded ${records.length} feedback items`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to record feedback: ${msg}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  insertReviewFeedback — pgvector INSERT                              */
/* ------------------------------------------------------------------ */

const INSERT_REVIEW_FEEDBACK_SQL = `
INSERT INTO review_feedback (repo, pr_number, feedback_type, comment_text, file_path, author, embedding)
VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

export async function insertReviewFeedback(client: VectorDBClient, feedback: ReviewFeedbackInput): Promise<void> {
  const text = `${feedback.feedback_type} ${feedback.comment_text} ${feedback.file_path ?? ''}`;
  const embedding = await client.embed(text);
  await client.pool.query(INSERT_REVIEW_FEEDBACK_SQL, [
    feedback.repo,
    feedback.pr_number,
    feedback.feedback_type,
    feedback.comment_text,
    feedback.file_path ?? null,
    feedback.author ?? null,
    JSON.stringify(embedding),
  ]);
}

/* ------------------------------------------------------------------ */
/*  queryReviewFeedback — pgvector SELECT                               */
/* ------------------------------------------------------------------ */

const QUERY_REVIEW_FEEDBACK_SQL = `
SELECT id, repo, pr_number, feedback_type, comment_text, file_path, author, created_at
FROM review_feedback
WHERE repo = $1
ORDER BY embedding <-> $2
LIMIT $3
`;

export async function queryReviewFeedback(
  client: VectorDBClient,
  repo: string,
  query: string,
  limit = 10,
): Promise<unknown[]> {
  const embedding = await client.embed(query);
  const result = await client.pool.query(QUERY_REVIEW_FEEDBACK_SQL, [repo, JSON.stringify(embedding), limit]);
  return result.rows;
}

/* ------------------------------------------------------------------ */
/*  formatReviewFeedback — markdown output                              */
/* ------------------------------------------------------------------ */

export function formatReviewFeedback(feedback: ReviewFeedbackItem[]): string {
  if (feedback.length === 0) {
    return '';
  }

  const sections = feedback.map((f) => {
    const parts = [`- [${f.feedback_type}] PR #${f.pr_number}: "${f.comment_text}"`];
    if (f.file_path) {
      parts.push(`  file: ${f.file_path}`);
    }
    return parts.join('\n');
  });

  return `## Past reviewer feedback\n\n${sections.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/*  queryReviewFeedbackContext — REST endpoint (pipeline context)        */
/* ------------------------------------------------------------------ */

interface ReviewFeedbackContextResponse {
  feedback?: ReviewFeedbackItem[];
}

/**
 * Query the episodic memory REST endpoint for past review feedback similar to the given query.
 * Returns an empty array if disabled, on error, or if the response is malformed.
 */
export async function queryReviewFeedbackContext(
  config: EpisodicMemoryConfig,
  query: string,
  repo?: string,
): Promise<ReviewFeedbackItem[]> {
  if (!config.enabled) {
    return [];
  }

  if (!config.endpoint) {
    log.warn('[review-feedback] Enabled but no endpoint configured — skipping');
    return [];
  }

  try {
    const body: Record<string, unknown> = { query, type: 'review_feedback', top_k: config.max_episodes };
    if (repo) {
      body.repo = repo;
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      log.warn(`[review-feedback] Endpoint returned ${response.status} — skipping feedback context`);
      return [];
    }

    const data = (await response.json()) as ReviewFeedbackContextResponse;

    if (!data.feedback || !Array.isArray(data.feedback)) {
      log.warn('[review-feedback] Malformed response (missing feedback array) — skipping');
      return [];
    }

    log.info(`[review-feedback] Retrieved ${data.feedback.length} past feedback items`);
    return data.feedback;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to query endpoint: ${msg} — skipping feedback context`);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  runMigration                                                        */
/* ------------------------------------------------------------------ */

export async function runMigration(client: VectorDBClient): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const migrationsDir = join(thisDir, '..', '..', 'migrations');

  const sql001 = await readFile(join(migrationsDir, '001_pgvector_schema.sql'), 'utf-8');
  await client.pool.query(sql001);

  const sql002 = await readFile(join(migrationsDir, '002_episodes_language.sql'), 'utf-8');
  await client.pool.query(sql002);

  const sql003 = await readFile(join(migrationsDir, '003_review_feedback.sql'), 'utf-8');
  await client.pool.query(sql003);
}

/* ------------------------------------------------------------------ */
/*  upsertChunks — simplified interface for index-codebase pipeline    */
/* ------------------------------------------------------------------ */

/**
 * Upserts raw Chunk objects for a single file into the vectordb.
 *
 * Wires the incremental indexer (src/pipeline/index-codebase.ts) to the SAME
 * REST endpoint that `queryCodeContext` reads from — i.e. the `reindex_endpoint`
 * configured in vectordb config. The endpoint is expected to accept
 * `{ repo_path, file_path, chunks }` and persist embeddings so that subsequent
 * `queryCodeContext` calls return the newly-indexed symbols.
 *
 * Graceful degradation:
 *   - config undefined → no-op (preserves backward compat with existing call sites)
 *   - !config.enabled → no-op
 *   - !config.reindex_endpoint → no-op (logged warning)
 *   - empty chunks array → no-op
 *   - network error or non-200 response → warning logged, returns without throwing
 *
 * Issue #255: previously a no-op stub; the incremental indexer was effectively
 * silent in production. This version is wired to the real embedding sink.
 */
export async function upsertChunks(
  repoPath: string,
  filePath: string,
  chunks: Chunk[],
  config?: VectorDBConfig,
): Promise<void> {
  if (!config) {
    // No config supplied — preserve no-op behavior for existing callers that
    // haven't migrated to passing vectordb config through yet.
    return;
  }

  if (!config.enabled) {
    return;
  }

  if (!config.reindex_endpoint) {
    log.warn('[vectordb] upsertChunks: vectordb enabled but reindex_endpoint not configured — skipping');
    return;
  }

  if (chunks.length === 0) {
    return;
  }

  try {
    const response = await fetch(config.reindex_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_path: repoPath, file_path: filePath, chunks }),
    });

    if (!response.ok) {
      log.warn(`[vectordb] upsertChunks: reindex endpoint returned ${response.status} for ${filePath} — skipping`);
      return;
    }

    log.info(`[vectordb] upsertChunks: indexed ${chunks.length} chunks for ${filePath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[vectordb] upsertChunks: failed to POST ${filePath} chunks: ${msg} — skipping`);
  }
}
