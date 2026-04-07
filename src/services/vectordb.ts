// Vector DB service — two modes:
// 1. REST endpoint client (queryCodeContext / formatCodeChunks) — for pipeline context injection
// 2. pgvector client (VectorDBClient / upsert / query) — for direct DB operations

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VectorDBConfig } from '../types/config.js';
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
