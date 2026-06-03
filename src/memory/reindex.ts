// Reindex service — triggers incremental re-embedding of changed files in the vector DB.
// Graceful degradation: if the endpoint is unavailable, returns failure result (warn, don't crash).

import { $ } from 'zx';
import type { VectorDBConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

$.verbose = false;

export interface ReindexResult {
  success: boolean;
  filesSubmitted: number;
  apiCalls: number;
  duration: number;
  error?: string | undefined;
}

interface ReindexResponse {
  indexed?: number;
  api_calls?: number;
}

/**
 * POST a list of changed files to the vector DB reindex endpoint.
 * Returns stats about the reindex operation.
 */
export async function reindexFiles(config: VectorDBConfig, repoPath: string, files: string[]): Promise<ReindexResult> {
  const start = Date.now();

  if (!config.enabled) {
    return { success: true, filesSubmitted: 0, apiCalls: 0, duration: 0 };
  }

  if (!config.reindex_endpoint) {
    return {
      success: false,
      filesSubmitted: 0,
      apiCalls: 0,
      duration: 0,
      error: 'reindex_endpoint not configured',
    };
  }

  if (files.length === 0) {
    log.info('[reindex] No files to reindex — skipping');
    return { success: true, filesSubmitted: 0, apiCalls: 0, duration: 0 };
  }

  try {
    const response = await fetch(config.reindex_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_path: repoPath, files }),
    });

    const duration = Date.now() - start;

    if (!response.ok) {
      const msg = `Reindex endpoint returned ${response.status}`;
      log.warn(`[reindex] ${msg}`);
      return { success: false, filesSubmitted: files.length, apiCalls: 0, duration, error: msg };
    }

    const data = (await response.json()) as ReindexResponse;
    const apiCalls = data.api_calls ?? files.length;

    log.info(`[reindex] Submitted ${files.length} files, ${apiCalls} API calls (${duration}ms)`);

    return { success: true, filesSubmitted: files.length, apiCalls, duration };
  } catch (error) {
    const duration = Date.now() - start;
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[reindex] Failed: ${msg}`);
    return { success: false, filesSubmitted: files.length, apiCalls: 0, duration, error: msg };
  }
}

/**
 * Collect unique changed files from a list of PR URLs using `gh pr diff --name-only`.
 */
export async function collectChangedFilesFromPRs(repoPath: string, prUrls: string[]): Promise<string[]> {
  if (prUrls.length === 0) return [];

  const allFiles = new Set<string>();

  for (const prUrl of prUrls) {
    try {
      const result = await $`gh pr diff ${prUrl} --name-only -R ${repoPath}`;
      for (const file of result.stdout.trim().split('\n').filter(Boolean)) {
        allFiles.add(file);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`[reindex] Failed to get diff for ${prUrl}: ${msg}`);
    }
  }

  return [...allFiles].sort();
}

/**
 * Detect files changed between current HEAD and a base branch.
 * For manual `kova reindex` usage.
 */
export async function collectChangedFiles(repoPath: string, baseBranch = 'main'): Promise<string[]> {
  const result = await $`git -C ${repoPath} diff --name-only ${baseBranch}...HEAD`;
  return result.stdout.trim().split('\n').filter(Boolean);
}
