// Production dispatcher for babysit — wraps runReviewLoop to act on a single
// review thread inside the PR's worktree.
//
// The thread body is synthesized into a tiny Issue (`#${pr.number}-thread`) so
// the existing R→I→T loop can run unchanged. After the loop, any uncommitted
// changes are committed + pushed; the short SHA is returned to the caller so
// review-resolver can reply to the thread.
//
// This is intentionally narrow: one thread → one focused edit pass. Re-running
// the full STIR pipeline (Assess → Spec → ...) per review comment is wasteful.

import { $ } from 'zx';
import type { DispatchEdits, DispatchEditsInput, DispatchEditsResult } from '../services/review-resolver.js';
import { getChangedFiles } from '../services/worktree.js';
import type { Issue, RepoConfig } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface BabysitDispatchOptions {
  config: RepoConfig;
  /** Already-checked-out worktree path for this PR. Caller owns checkout/cleanup. */
  worktreePath: string;
}

/**
 * Build a DispatchEdits callback that turns a review thread into an Issue +
 * runs a focused R→I→T pass inside the supplied worktree.
 */
export function makeRunReviewLoopDispatch(opts: BabysitDispatchOptions): DispatchEdits {
  return async function dispatch(input: DispatchEditsInput): Promise<DispatchEditsResult> {
    const { thread, pr } = input;
    const { worktreePath: wtPath } = opts;

    const issue: Issue = {
      number: pr.number,
      title: `Address review comment by @${thread.author} on PR #${pr.number}`,
      body: buildIssueBody(thread, pr.number),
      labels: ['review-followup'],
      url: '',
    };

    log.info(`[babysit-dispatch] Running review pass for PR #${pr.number} thread ${thread.threadId}`);

    // Lazy-import runReviewLoop to keep the babysit CLI startup path small.
    const { runReviewLoop } = await import('./loops.js');

    try {
      await runReviewLoop({
        issue,
        workDir: wtPath,
        repoConfig: opts.config,
        waveResults: {},
      });
    } catch (error) {
      log.warn(
        `[babysit-dispatch] runReviewLoop threw for PR #${pr.number} thread ${thread.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { changed: false, sha: undefined };
    }

    const changed = await getChangedFiles(wtPath);
    if (changed.length === 0) {
      log.info(`[babysit-dispatch] No file changes for thread ${thread.threadId}`);
      return { changed: false, sha: undefined };
    }

    try {
      await $({ cwd: wtPath })`git add ${changed}`;
      await $({
        cwd: wtPath,
      })`git commit -m ${`fix: address review comment from @${thread.author} on PR #${pr.number}\n\nThread: ${thread.threadId}`}`;
      await $({ cwd: wtPath })`git push origin HEAD`;
      const shaResult = await $({ cwd: wtPath })`git rev-parse --short HEAD`;
      const sha = shaResult.stdout.trim();
      return { changed: true, sha };
    } catch (error) {
      log.warn(
        `[babysit-dispatch] commit/push failed for PR #${pr.number} thread ${thread.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { changed: false, sha: undefined };
    }
  };
}

/** Compose a focused, single-issue body describing the review comment. */
function buildIssueBody(
  thread: { body: string; path: string | undefined; line: number | undefined; author: string },
  prNumber: number,
): string {
  const loc = thread.path ? ` at \`${thread.path}${thread.line !== undefined ? `:${thread.line}` : ''}\`` : '';
  return `## Review feedback on PR #${prNumber}\n\nReviewer @${thread.author}${loc}:\n\n> ${thread.body.replace(/\n/g, '\n> ')}\n\nApply the requested change. Keep the edit minimal and on-topic for this single comment.`;
}

/** A safe default dispatcher used when no real one is wired (preview mode). */
export const previewDispatch: DispatchEdits = async (input) => {
  log.info(
    `[babysit-dispatch] (preview) Would dispatch edits for PR #${input.pr.number} thread ${input.thread.threadId}: ${input.thread.body.slice(0, 80)}`,
  );
  return { changed: false, sha: undefined };
};
