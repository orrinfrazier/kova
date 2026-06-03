// Code embedding REST client — queries the vector DB endpoint for code
// chunks relevant to a query, formats them for prompt injection, and
// streams indexer output back to the reindex endpoint.

import type { VectorDBConfig } from '../../types/config.js';
import type { CodeChunk } from '../../types/memory.js';
import { log } from '../../utils/logger.js';
import type { Chunk } from '../chunker.js';

export type { CodeChunk } from '../../types/memory.js';

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
