// Cross-repo issue awareness — fetch open issues from sibling repos
// for injection into brainstorm context to prevent duplicate issues.

import { $ } from 'zx';
import type { BrainstormIssue } from '../types/index.js';
import { log } from '../utils/logger.js';
import { titleSimilarity } from './brainstorm-history.js';

$.verbose = false;

export interface CrossRepoIssueSummary {
  title: string;
  labels: string[];
}

export interface CrossRepoEntry {
  repo: string;
  issues: CrossRepoIssueSummary[];
}

/** Minimal config shape — only needs repo paths, not full RepoConfig. */
export interface CrossRepoConfig {
  repos: Record<string, { path: string }>;
}

/**
 * Fetch open issues from all configured repos except the current one.
 * Returns lightweight summaries (titles + labels only).
 */
export async function fetchCrossRepoIssues(
  currentRepoPath: string,
  config: CrossRepoConfig | undefined,
): Promise<CrossRepoEntry[]> {
  if (!config?.repos) {
    return [];
  }

  const entries = Object.entries(config.repos).filter(([, repoConfig]) => repoConfig.path !== currentRepoPath);

  if (entries.length === 0) {
    return [];
  }

  const results: CrossRepoEntry[] = [];

  for (const [name, repoConfig] of entries) {
    try {
      const args = ['issue', 'list', '--state', 'open', '--json', 'number,title,labels', '--limit', '50'];
      const result = await $({ cwd: repoConfig.path })`gh ${args}`;
      const raw = JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
      }>;

      const issues: CrossRepoIssueSummary[] = raw.map((issue) => ({
        title: issue.title,
        labels: issue.labels.map((l) => l.name),
      }));

      results.push({ repo: name, issues });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[cross-repo] Failed to fetch issues from ${name}: ${message}`);
    }
  }

  return results;
}

/**
 * Format cross-repo issues as a context string for injection into brainstorm prompts.
 * Returns empty string if no issues exist across repos.
 */
export function formatCrossRepoContext(entries: CrossRepoEntry[]): string {
  const withIssues = entries.filter((e) => e.issues.length > 0);
  if (withIssues.length === 0) {
    return '';
  }

  const lines: string[] = ['\n\nThese issues already exist in related repos — do NOT suggest duplicates:'];

  for (const entry of withIssues) {
    lines.push(`\n**${entry.repo}:**`);
    for (const issue of entry.issues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
      lines.push(`- ${issue.title}${labels}`);
    }
  }

  return lines.join('\n');
}

/**
 * Fetch open issues from the CURRENT repo only (same-repo dedup).
 * Returns lightweight summaries. On failure, logs and returns [].
 */
export async function fetchSameRepoIssues(repoPath: string): Promise<CrossRepoIssueSummary[]> {
  try {
    const args = ['issue', 'list', '--state', 'open', '--json', 'number,title,labels', '--limit', '100'];
    const result = await $({ cwd: repoPath })`gh ${args}`;
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      labels: Array<{ name: string }>;
    }>;

    return raw.map((issue) => ({
      title: issue.title,
      labels: issue.labels.map((l) => l.name),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[same-repo] Failed to fetch issues from ${repoPath}: ${message}`);
    return [];
  }
}

/**
 * Format same-repo open issues as a context string for injection into brainstorm prompts.
 * Returns empty string when no issues exist.
 */
export function formatSameRepoContext(issues: CrossRepoIssueSummary[]): string {
  if (issues.length === 0) {
    return '';
  }

  const lines: string[] = ['\n\nThese issues are already tracked here in THIS repo — do NOT re-propose them:'];
  for (const issue of issues) {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    lines.push(`- ${issue.title}${labels}`);
  }
  return lines.join('\n');
}

/** Default Jaccard-similarity threshold for same-repo proposal collision. */
export const PROPOSAL_COLLISION_THRESHOLD = 0.7;

export interface ProposalSkipEntry {
  proposal: BrainstormIssue;
  matchedTitle: string;
}

export interface ProposalClassification {
  kept: BrainstormIssue[];
  skipped: ProposalSkipEntry[];
}

/**
 * Classify each brainstorm proposal against the currently-open issues in the same repo.
 *
 * - `kept`     → proposals with no titleSimilarity match ≥ threshold (GAP — net-new work)
 * - `skipped`  → proposals that collide with an existing open issue (OPEN — already tracked)
 *
 * Uses {@link titleSimilarity} (Jaccard on lowercased word sets). Default threshold
 * matches the diminishing-returns heuristic for consistency across both checks.
 */
export function classifyProposalsAgainstOpenIssues(
  proposals: BrainstormIssue[],
  openIssues: CrossRepoIssueSummary[],
  threshold: number = PROPOSAL_COLLISION_THRESHOLD,
): ProposalClassification {
  if (openIssues.length === 0) {
    return { kept: [...proposals], skipped: [] };
  }

  const kept: BrainstormIssue[] = [];
  const skipped: ProposalSkipEntry[] = [];

  for (const proposal of proposals) {
    let bestMatch: { title: string; score: number } | undefined;
    for (const open of openIssues) {
      const score = titleSimilarity(proposal.title, open.title);
      if (score >= threshold && (bestMatch === undefined || score > bestMatch.score)) {
        bestMatch = { title: open.title, score };
      }
    }

    if (bestMatch) {
      skipped.push({ proposal, matchedTitle: bestMatch.title });
    } else {
      kept.push(proposal);
    }
  }

  return { kept, skipped };
}
