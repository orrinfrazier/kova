// Vector DB service — two modes:
// 1. REST endpoint client (queryCodeContext / formatCodeChunks) — for pipeline context injection
// 2. pgvector client (VectorDBClient / upsert / query) — for direct DB operations

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EpisodicMemoryConfig, FixState, VectorDBConfig } from '../types/config.js';
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
}

interface EpisodeContextResponse {
  episodes?: EpisodeContext[];
}

/**
 * Query the episodic memory REST endpoint for past issue learnings similar to the given query.
 * Returns an empty array if disabled, on error, or if the response is malformed.
 */
export async function queryEpisodeContext(config: EpisodicMemoryConfig, query: string): Promise<EpisodeContext[]> {
  if (!config.enabled) {
    return [];
  }

  if (!config.endpoint) {
    log.warn('[episodes] Enabled but no endpoint configured — skipping');
    return [];
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: config.max_episodes }),
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
 */
export function formatEpisodes(episodes: EpisodeContext[]): string {
  if (episodes.length === 0) {
    return '';
  }

  const sorted = [...episodes].sort((a, b) => b.score - a.score);

  const sections = sorted.map((ep) =>
    [
      `### #${ep.issue_number}: ${ep.issue_title}`,
      `- **Approach:** ${ep.approach}`,
      `- **Outcome:** ${ep.outcome}`,
      `- **Learning:** ${ep.learnings}`,
    ].join('\n'),
  );

  return `## Learnings from similar past issues\n\n${sections.join('\n\n')}`;
}

/* ------------------------------------------------------------------ */
/*  Episode recording — REST endpoint (post-fix persistence)           */
/* ------------------------------------------------------------------ */

export interface EpisodeRecord {
  issue_number: number;
  issue_title: string;
  labels: string[];
  repo: string;
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
  failed_at_wave: string | null;
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
    approach: specArtifact?.summary ?? '',
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
    failed_at_wave: failedAtWave,
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
INSERT INTO episodes (repo, issue_number, issue_title, approach, outcome, files_changed, embedding)
VALUES ($1, $2, $3, $4, $5, $6, $7)
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

export async function queryEpisodes(
  client: VectorDBClient,
  repo: string,
  query: string,
  limit = 5,
): Promise<unknown[]> {
  const embedding = await client.embed(query);
  const result = await client.pool.query(QUERY_EPISODES_SQL, [repo, JSON.stringify(embedding), limit]);
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

/* ------------------------------------------------------------------ */
/*  runMigration                                                        */
/* ------------------------------------------------------------------ */

export async function runMigration(client: VectorDBClient): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // Resolve relative to the service file → ../../migrations/ (project root)
  const sqlPath = join(thisDir, '..', '..', 'migrations', '001_pgvector_schema.sql');
  const sql = await readFile(sqlPath, 'utf-8');
  await client.pool.query(sql);
}

/* ------------------------------------------------------------------ */
/*  upsertChunks — simplified interface for index-codebase pipeline    */
/* ------------------------------------------------------------------ */

/**
 * Upserts raw Chunk objects for a single file into the vectordb.
 * This is a simplified stub; in production wire a real VectorDBClient.
 */
export async function upsertChunks(_repoPath: string, _filePath: string, _chunks: Chunk[]): Promise<void> {
  // No-op stub — the index-codebase pipeline tests mock this entire module.
  // Real implementation would use a VectorDBClient injected via options.
}
