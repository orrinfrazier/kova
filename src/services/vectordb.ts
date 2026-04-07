// Vector DB service — queries an external vector DB REST endpoint for relevant code chunks.
// Graceful degradation: if the endpoint is unavailable, returns empty results (warn, don't fail).

import type { VectorDBConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

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
