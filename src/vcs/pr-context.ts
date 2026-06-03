// PR awareness context — tracks open PRs to avoid conflicts between sequential fixes.

import { $ } from 'zx';
import type { Issue } from '../types/index.js';

$.verbose = false;

export interface OpenPR {
  number: number;
  title: string;
  branch: string;
  files: string[];
}

export async function fetchOpenPRsDetailed(repoPath: string): Promise<OpenPR[]> {
  const result = await $({ cwd: repoPath })`gh pr list --state open --json number,title,headRefName,files --limit 20`;
  const prs = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    files: Array<{ path: string }>;
  }>;

  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    files: pr.files.map((f) => f.path),
  }));
}

export function formatPRContext(prs: OpenPR[]): string {
  if (prs.length === 0) return '';

  const lines = [
    '',
    '## Pending PRs (avoid conflicts)',
    'These PRs are open or were created earlier in this run. Avoid modifying the listed files to prevent merge conflicts.',
    '',
  ];

  for (const pr of prs) {
    const fileList = pr.files.length > 0 ? pr.files.join(', ') : 'unknown';
    lines.push(`- #${pr.number}: ${pr.title} (branch: ${pr.branch}, files: ${fileList})`);
  }

  return lines.join('\n');
}

export function extractPRFromResult(
  issue: Issue,
  result: { success: boolean; prUrl?: string; state: { waveResults: Record<string, unknown> } },
): OpenPR | undefined {
  if (!result.success || !result.prUrl) return undefined;

  const shipArtifact = result.state.waveResults.ship as { artifact?: { filesStaged?: string[] } } | undefined;
  const files = shipArtifact?.artifact?.filesStaged ?? [];

  const prNumberMatch = result.prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : issue.number;

  return {
    number: prNumber,
    title: issue.title,
    branch: `kova/fix-${issue.number}`,
    files,
  };
}
