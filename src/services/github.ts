// GitHub integration — fetch issues, create PRs via gh CLI.

import { $ } from 'zx';
import type { Issue } from '../types/index.js';
import { log } from '../utils/logger.js';

$.verbose = false;

export async function fetchIssues(repoPath: string, filter?: string): Promise<Issue[]> {
  const args = ['issue', 'list', '--state', 'open', '--json', 'number,title,body,labels,url', '--limit', '50'];

  if (filter) {
    args.push('--label', filter);
  }

  const result = await $({ cwd: repoPath })`gh ${args}`;
  const raw = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
  }>;

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
  }));
}

export async function fetchIssue(repoPath: string, issueNumber: number): Promise<Issue> {
  const result = await $({ cwd: repoPath })`gh issue view ${issueNumber} --json number,title,body,labels,url`;
  const raw = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
  };

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    labels: raw.labels.map((l) => l.name),
    url: raw.url,
  };
}

export async function commentOnIssue(repoPath: string, issueNumber: number, body: string): Promise<void> {
  await $({ cwd: repoPath })`gh issue comment ${issueNumber} --body ${body}`;
  log.info(`Commented on #${issueNumber}`);
}

export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string }> {
  const args = ['issue', 'create', '--title', title, '--body', body, '--json', 'number,url'];
  for (const label of labels) {
    args.push('--label', label);
  }
  const result = await $({ cwd: repoPath })`gh ${args}`;
  const parsed = JSON.parse(result.stdout) as { number: number; url: string };
  log.info(`Issue created: #${parsed.number} ${parsed.url}`);
  return parsed;
}

export async function createPR(repoPath: string, branch: string, title: string, body: string): Promise<string> {
  const result = await $({ cwd: repoPath })`gh pr create --title ${title} --body ${body} --head ${branch}`;
  const prUrl = result.stdout.trim();
  log.info(`PR created: ${prUrl}`);
  return prUrl;
}

export async function listOpenPRs(repoPath: string): Promise<string[]> {
  const result = await $({ cwd: repoPath })`gh pr list --state open --json number,title,headRefName --limit 20`;
  const prs = JSON.parse(result.stdout) as Array<{ number: number; title: string; headRefName: string }>;
  return prs.map((pr) => `#${pr.number}: ${pr.title} (${pr.headRefName})`);
}

export async function branchExistsOnRemote(repoPath: string, branch: string): Promise<boolean> {
  try {
    await $({ cwd: repoPath })`git ls-remote --exit-code --heads origin ${branch}`;
    return true;
  } catch {
    return false;
  }
}

export async function findOpenPR(repoPath: string, branch: string): Promise<string | undefined> {
  const result = await $({ cwd: repoPath })`gh pr list --state open --head ${branch} --json url --limit 1`;
  const prs = JSON.parse(result.stdout) as Array<{ url: string }>;
  return prs[0]?.url;
}

export interface ExistingWork {
  reason: string;
  prUrl?: string;
}

export async function hasExistingWork(repoPath: string, issueNumber: number): Promise<ExistingWork | undefined> {
  const branch = `kova/fix-${issueNumber}`;
  const [branchExists, prUrl] = await Promise.all([
    branchExistsOnRemote(repoPath, branch),
    findOpenPR(repoPath, branch),
  ]);

  if (prUrl) {
    return { reason: `Open PR exists for ${branch}: ${prUrl}`, prUrl };
  }
  if (branchExists) {
    return { reason: `Branch ${branch} already exists on remote` };
  }
  return undefined;
}
