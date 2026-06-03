// Index codebase pipeline — chunks source files and upserts embeddings into vectordb.
// Also populates the per-repo codegraph DB at `.kova/codegraph.db` with tree-sitter
// extracted symbol nodes + call/import edges (TS/JS only for now). Codegraph
// failures degrade gracefully: a parser/db error logs a warning and continues
// the vectordb pass — context indexing should not block on the symbol index.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkFile } from '../services/chunker.js';
import { type CodegraphHandle, indexSource, openCodegraph } from '../services/codegraph/index.js';
import {
  getChangedFilesSince,
  getCurrentHeadSha,
  getLastIndexedSha,
  saveLastIndexedSha,
} from '../services/git-diff.js';
import { upsertChunks } from '../services/memory/code-rest.js';
import type { VectorDBConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

export interface IndexOptions {
  repoPath: string;
  full?: boolean;
  connectionUrl?: string | undefined;
  repoName?: string | undefined;
  /**
   * VectorDB config — when supplied (and enabled with a reindex_endpoint), chunks
   * for each indexed file are POSTed to the real embedding sink so the index
   * reflects in subsequent `queryCodeContext` lookups. When omitted, upsertChunks
   * degrades to a no-op, preserving the existing CLI behavior for callers that
   * have not yet wired through their config.
   */
  vectordb?: VectorDBConfig | undefined;
}

export interface IndexResult {
  filesIndexed: number;
  chunksUpserted: number;
  duration: number;
  incremental: boolean;
  /** Number of files written to the codegraph (0 when the codegraph pass failed or was skipped). */
  codegraphFilesIndexed: number;
}

/** Languages the codegraph extractor currently supports. */
const CODEGRAPH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isCodegraphCandidate(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return CODEGRAPH_EXTENSIONS.has(filePath.slice(dot));
}

export async function indexCodebase(options: IndexOptions): Promise<IndexResult> {
  const { repoPath, full = false, vectordb } = options;
  const start = Date.now();

  const incremental = !full;

  // Determine which files to index
  let filesToIndex: string[];
  if (full) {
    // Full index: all files (since=null means all)
    filesToIndex = await getChangedFilesSince(repoPath, null);
  } else {
    // Incremental: only changed files since last indexed SHA
    const lastSha = await getLastIndexedSha(repoPath);
    filesToIndex = await getChangedFilesSince(repoPath, lastSha);
  }

  // Open the codegraph lazily — only when we actually have at least one
  // TS/JS file to index. Avoids creating an empty .kova/codegraph.db on
  // every no-op incremental run.
  let codegraph: CodegraphHandle | null = null;
  let codegraphFilesIndexed = 0;

  let totalChunks = 0;

  try {
    for (const filePath of filesToIndex) {
      const absolutePath = join(repoPath, filePath);
      const source = await readFile(absolutePath, 'utf-8');
      const chunks = chunkFile(source, filePath);
      if (chunks.length > 0) {
        await upsertChunks(repoPath, filePath, chunks, vectordb);
        totalChunks += chunks.length;
      }

      if (isCodegraphCandidate(filePath)) {
        if (codegraph === null) {
          try {
            codegraph = openCodegraph(join(repoPath, '.kova', 'codegraph.db'));
          } catch (err) {
            log.warn(
              `[codegraph] Failed to open DB — skipping symbol index: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (codegraph) {
          try {
            const result = await indexSource(codegraph, filePath, source);
            if (result.changed) codegraphFilesIndexed++;
          } catch (err) {
            log.warn(`[codegraph] Failed to extract ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  } finally {
    codegraph?.close();
  }

  // Save current HEAD SHA for next incremental run
  const currentSha = await getCurrentHeadSha(repoPath);
  await saveLastIndexedSha(repoPath, currentSha);

  const duration = Date.now() - start;

  return {
    filesIndexed: filesToIndex.length,
    chunksUpserted: totalChunks,
    duration,
    incremental,
    codegraphFilesIndexed,
  };
}
