// repo-intel MCP context injection — calls repo-intel HTTP endpoint
// to enrich pipeline waves with repo architecture, search, and standards.

import type { RepoIntelConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

interface RepoIntelResponse {
  result?: string;
}

/* ------------------------------------------------------------------ */
/*  Internal: POST to repo-intel endpoint                              */
/* ------------------------------------------------------------------ */

async function callRepoIntel(config: RepoIntelConfig, tool: string, params: Record<string, unknown>): Promise<string> {
  if (!config.enabled) {
    return '';
  }

  if (!config.endpoint) {
    log.warn(`[repo-intel] Enabled but no endpoint configured — skipping ${tool}`);
    return '';
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, params }),
    });

    if (!response.ok) {
      log.warn(`[repo-intel] ${tool} returned ${response.status} — skipping`);
      return '';
    }

    const data = (await response.json()) as RepoIntelResponse;

    if (typeof data.result !== 'string' || data.result.length === 0) {
      log.warn(`[repo-intel] ${tool} returned empty or malformed result — skipping`);
      return '';
    }

    log.info(`[repo-intel] ${tool} returned ${data.result.length} chars`);
    return data.result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[repo-intel] Failed to call ${tool}: ${msg} — skipping`);
    return '';
  }
}

/* ------------------------------------------------------------------ */
/*  Query functions                                                    */
/* ------------------------------------------------------------------ */

/**
 * Query repo-intel for full repository context (architecture, standards, trajectory).
 * Injected before the assess wave.
 */
export async function queryRepoContext(config: RepoIntelConfig, repo: string, query: string): Promise<string> {
  return callRepoIntel(config, 'repo_context', {
    repo,
    query,
    limit: config.limit,
  });
}

/**
 * Query repo-intel for semantic code search results.
 * Injected before the spec wave to find similar implementations.
 */
export async function queryRepoSearch(config: RepoIntelConfig, repo: string, query: string): Promise<string> {
  return callRepoIntel(config, 'repo_search', {
    repo,
    query,
    limit: config.limit,
  });
}

/**
 * Query repo-intel for project coding standards and conventions.
 * Injected before the quality wave.
 */
export async function queryRepoStandards(config: RepoIntelConfig, repo: string): Promise<string> {
  return callRepoIntel(config, 'repo_standards', { repo });
}

/* ------------------------------------------------------------------ */
/*  Format functions                                                   */
/* ------------------------------------------------------------------ */

/** Format repo context into a markdown section for wave prompt injection. */
export function formatRepoContext(raw: string): string {
  if (raw.length === 0) return '';
  return `## Repository context\n\n${raw}`;
}

/** Format search results into a markdown section for wave prompt injection. */
export function formatRepoSearch(raw: string): string {
  if (raw.length === 0) return '';
  return `## Similar implementations\n\n${raw}`;
}

/** Format standards into a markdown section for wave prompt injection. */
export function formatRepoStandards(raw: string): string {
  if (raw.length === 0) return '';
  return `## Project standards\n\n${raw}`;
}
