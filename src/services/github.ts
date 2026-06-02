// GitHub integration — fetch issues, create PRs via gh CLI.

import { $ } from 'zx';
import type { Issue } from '../types/index.js';
import { log } from '../utils/logger.js';

$.verbose = false;

export interface FetchIssuesOptions {
  /** Restrict the result set to issues assigned to the given milestone title. */
  milestone?: string | undefined;
  /**
   * Maximum number of issues to request from `gh issue list --limit`.
   * Defaults to 50. Decoupled from the per-run processing cap so callers can
   * widen the fetch window (and record every fetched issue in the coverage
   * ledger) without raising how many issues are actually processed.
   */
  fetchLimit?: number | undefined;
}

/** Default for `gh issue list --limit` when no caller override is supplied. */
export const DEFAULT_FETCH_LIMIT = 50;

export async function fetchIssues(repoPath: string, filter?: string, options?: FetchIssuesOptions): Promise<Issue[]> {
  const fetchLimit = options?.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,body,labels,url,milestone,createdAt,updatedAt',
    '--limit',
    String(fetchLimit),
  ];

  if (filter) {
    args.push('--label', filter);
  }

  if (options?.milestone) {
    args.push('--milestone', options.milestone);
  }

  const result = await $({ cwd: repoPath })`gh ${args}`;
  const raw = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
    milestone?: { title?: string } | null;
    createdAt?: string;
    updatedAt?: string;
  }>;

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
    milestone: issue.milestone?.title ?? null,
    ...(issue.createdAt !== undefined ? { createdAt: issue.createdAt } : {}),
    ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
  }));
}

export async function fetchIssue(repoPath: string, issueNumber: number): Promise<Issue> {
  const result = await $({
    cwd: repoPath,
  })`gh issue view ${issueNumber} --json number,title,body,labels,url,milestone,createdAt,updatedAt`;
  const raw = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
    milestone?: { title?: string } | null;
    createdAt?: string;
    updatedAt?: string;
  };

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    labels: raw.labels.map((l) => l.name),
    url: raw.url,
    milestone: raw.milestone?.title ?? null,
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
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

export async function fetchOpenIssueCount(repoPath: string): Promise<number> {
  const result = await $({ cwd: repoPath })`gh issue list --state open --json number --limit 1000`;
  const raw = JSON.parse(result.stdout) as Array<{ number: number }>;
  return raw.length;
}

export interface MilestoneCounts {
  open: number;
  closed: number;
}

/**
 * Count open and closed issues assigned to a milestone via `gh issue list`.
 *
 * Returns `{ open: 0, closed: 0 }` if either gh call fails — this is a reporting
 * helper, never a fatal-path operation.
 */
export async function fetchMilestoneCounts(repoPath: string, milestone: string): Promise<MilestoneCounts> {
  const countByState = async (state: 'open' | 'closed'): Promise<number> => {
    try {
      const result = await $({
        cwd: repoPath,
      })`gh issue list --state ${state} --milestone ${milestone} --json number --limit 1000`;
      const raw = JSON.parse(result.stdout) as Array<{ number: number }>;
      return raw.length;
    } catch (err) {
      log.warn(
        `[github] failed to fetch ${state} issues for milestone "${milestone}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  };

  const [open, closed] = await Promise.all([countByState('open'), countByState('closed')]);
  return { open, closed };
}

export interface KovaPR {
  number: number;
  title: string;
  branch: string;
  url: string;
}

export async function fetchKovaPRs(repoPath: string): Promise<KovaPR[]> {
  const result = await $({ cwd: repoPath })`gh pr list --state open --json number,title,headRefName,url --limit 50`;
  const prs = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    url: string;
  }>;

  return prs
    .filter((pr) => pr.headRefName.startsWith('kova/') || pr.headRefName.startsWith('fix/issue-'))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
    }));
}

/** Create a comment on an issue via the GitHub API. Returns the comment ID for later edits. */
export async function createIssueComment(ownerRepo: string, issueNumber: number, body: string): Promise<number> {
  const result = await $`gh api repos/${ownerRepo}/issues/${issueNumber}/comments -f body=${body}`;
  const parsed = JSON.parse(result.stdout) as { id: number };
  log.info(`Created progress comment on #${issueNumber} (id: ${parsed.id})`);
  return parsed.id;
}

/** Edit an existing issue comment by ID via the GitHub API. */
export async function editIssueComment(ownerRepo: string, commentId: number, body: string): Promise<void> {
  await $`gh api repos/${ownerRepo}/issues/comments/${commentId} -X PATCH -f body=${body}`;
  log.info(`Updated progress comment (id: ${commentId})`);
}

export interface KovaPRWithStatus extends KovaPR {
  ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
}

export async function fetchKovaPRsWithStatus(repoPath: string): Promise<KovaPRWithStatus[]> {
  const result = await $({ cwd: repoPath })`gh pr list --state open --json number,title,headRefName,url --limit 50`;
  const prs = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    url: string;
  }>;

  const kovaPRs = prs.filter((pr) => pr.headRefName.startsWith('kova/') || pr.headRefName.startsWith('fix/issue-'));

  return Promise.all(
    kovaPRs.map(async (pr) => {
      const viewResult = await $({ cwd: repoPath })`gh pr view ${pr.number} --json statusCheckRollup`;
      const viewData = JSON.parse(viewResult.stdout) as {
        statusCheckRollup: Array<{ state: string }>;
      };

      const rollup = viewData.statusCheckRollup ?? [];
      let ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
      if (rollup.length === 0) {
        ciStatus = 'unknown';
      } else if (rollup.some((c) => c.state === 'FAILURE')) {
        ciStatus = 'failure';
      } else if (rollup.some((c) => c.state === 'PENDING')) {
        ciStatus = 'pending';
      } else {
        ciStatus = 'success';
      }

      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        url: pr.url,
        ciStatus,
      };
    }),
  );
}

export async function mergePR(repoPath: string, prNumber: number): Promise<{ merged: boolean; sha: string }> {
  const result = await $({ cwd: repoPath })`gh pr merge ${prNumber} --squash --delete-branch`;
  const sha = result.stdout.trim();
  return { merged: true, sha };
}

export async function rebasePROnDefault(repoPath: string, prNumber: number): Promise<void> {
  await $({ cwd: repoPath })`gh pr update-branch ${prNumber}`;
}

export function fetchPRDependencies(body: string): number[] {
  const pattern = /(?:depends on|closes)\s+#(\d+)/gi;
  const matches = [...body.matchAll(pattern)];
  const numbers = matches.map((m) => Number(m[1]));
  return [...new Set(numbers)];
}

export interface PRReviewComment {
  author: string;
  body: string;
  path: string | undefined;
  line: number | undefined;
  createdAt: string;
}

const BOT_AUTHORS = new Set(['kova', 'github-actions']);

/** Represents the latest review state and any unresolved blocking review threads on a PR. */
export interface PRReviewState {
  /**
   * GitHub-level review decision: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | undefined.
   * `undefined` when no reviews exist or gh returned null.
   */
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | undefined;
  /**
   * Unresolved review threads that block the merge. Each entry carries enough
   * context to dispatch a resolution pass (path/line/body) and to reply when
   * the thread is addressed (threadId / first comment id).
   */
  blockingThreads: PRReviewThread[];
}

export interface PRReviewThread {
  /** GraphQL thread id — required when calling resolveReviewThread. */
  threadId: string;
  /** First (root) comment id — used to reply via REST `pulls/comments/:id/replies`. */
  rootCommentId: number | undefined;
  path: string | undefined;
  line: number | undefined;
  body: string;
  author: string;
}

/**
 * Fetch latest review decision + any unresolved blocking review threads for a PR.
 *
 * Uses `gh pr view --json reviewDecision,reviewThreads` to get both decision and
 * thread state in one call. A thread is "blocking" when it's not resolved and not
 * outdated. Bot-authored threads are excluded (same filter as fetchPRReviewComments).
 */
export async function fetchPRReviewState(repoPath: string, prNumber: number): Promise<PRReviewState> {
  try {
    const result = await $({
      cwd: repoPath,
    })`gh pr view ${prNumber} --json reviewDecision,reviewThreads`;
    const raw = JSON.parse(result.stdout) as {
      reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
      reviewThreads?: Array<{
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        comments: {
          nodes?: Array<{
            databaseId?: number;
            author?: { login?: string };
            body?: string;
            path?: string | null;
            line?: number | null;
          }>;
        };
      }>;
    };

    const decision: PRReviewState['decision'] = raw.reviewDecision ?? undefined;
    const threads = raw.reviewThreads ?? [];

    const blockingThreads: PRReviewThread[] = threads
      .filter((t) => !t.isResolved && !t.isOutdated)
      .flatMap((t) => {
        const nodes = t.comments?.nodes ?? [];
        const root = nodes[0];
        if (!root) return [];
        const author = root.author?.login ?? 'unknown';
        if (BOT_AUTHORS.has(author)) return [];
        return [
          {
            threadId: t.id,
            rootCommentId: root.databaseId ?? undefined,
            path: root.path ?? undefined,
            line: root.line ?? undefined,
            body: root.body ?? '',
            author,
          },
        ];
      });

    return { decision, blockingThreads };
  } catch {
    return { decision: undefined, blockingThreads: [] };
  }
}

/** Reply to a review thread via the REST endpoint. Returns silently on failure. */
export async function replyToReviewComment(
  repoPath: string,
  ownerRepo: string,
  prNumber: number,
  rootCommentId: number,
  body: string,
): Promise<void> {
  try {
    await $({
      cwd: repoPath,
    })`gh api repos/${ownerRepo}/pulls/${prNumber}/comments/${rootCommentId}/replies -f body=${body}`;
  } catch (error) {
    log.warn(
      `[github] Failed to reply to review comment ${rootCommentId} on PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function fetchPRReviewComments(repoPath: string, prNumber: number): Promise<PRReviewComment[]> {
  try {
    const result = await $({ cwd: repoPath })`gh pr view ${prNumber} --json comments --jq .comments`;
    const raw = JSON.parse(result.stdout) as Array<{
      author: { login: string };
      body: string;
      path: string | null;
      line: number | null;
      createdAt: string;
    }>;

    return raw
      .filter((c) => !BOT_AUTHORS.has(c.author.login))
      .map((c) => ({
        author: c.author.login,
        body: c.body,
        path: c.path ?? undefined,
        line: c.line ?? undefined,
        createdAt: c.createdAt,
      }));
  } catch {
    return [];
  }
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
