// Index codebase pipeline — chunks source files and upserts embeddings into vectordb.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkFile } from '../services/chunker.js';
import {
  getChangedFilesSince,
  getCurrentHeadSha,
  getLastIndexedSha,
  saveLastIndexedSha,
} from '../services/git-diff.js';
import { upsertChunks } from '../services/vectordb.js';

export interface IndexOptions {
  repoPath: string;
  full?: boolean;
  connectionUrl?: string | undefined;
  repoName?: string | undefined;
}

export interface IndexResult {
  filesIndexed: number;
  chunksUpserted: number;
  duration: number;
  incremental: boolean;
}

export async function indexCodebase(options: IndexOptions): Promise<IndexResult> {
  const { repoPath, full = false } = options;
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

  let totalChunks = 0;

  for (const filePath of filesToIndex) {
    const absolutePath = join(repoPath, filePath);
    const source = await readFile(absolutePath, 'utf-8');
    const chunks = chunkFile(source, filePath);
    if (chunks.length > 0) {
      await upsertChunks(repoPath, filePath, chunks);
      totalChunks += chunks.length;
    }
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
  };
}
