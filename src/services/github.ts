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
