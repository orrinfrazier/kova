// Cross-repo issue awareness — fetch open issues from sibling repos
// for injection into brainstorm context to prevent duplicate issues.

import { $ } from 'zx';
import { log } from '../utils/logger.js';

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
