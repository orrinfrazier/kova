// Review resolver — act on human PR review comments, not just record them.
//
// Pipeline per PR:
//   1. Fetch unresolved blocking review threads via fetchPRReviewState.
//   2. Record feedback episodically (collectPRFeedback) so signal isn't lost.
//   3. For each thread, classify it. Non-actionable kinds (architectural,
//      stylistic preferences with no clear fix) are surfaced — not resolved.
//   4. For actionable threads, invoke a `dispatchEdits` callback that owns
//      the actual code change + git push. The callback returns `{ changed, sha }`.
//      When `changed=true && sha`, reply to the thread's root comment with
//      "Fixed in <sha>". When `changed=false`, record an error and leave the
//      thread alone so a human can re-engage.
//   5. Bounded by `maxIterations` (default 2). Re-orchestration across many
//      iterations belongs in the orchestrator (/babysit WAVE 3), not here.
//
// The `dispatchEdits` callback is injected so this module stays decoupled
// from the full STIR loop (which requires an Issue object the merge pipeline
// does not have). Tests inject a stub; production wires a thin adapter to
// the existing runReviewLoop / Claude SDK.

import type { EpisodicMemoryConfig } from '../types/config.js';
import { log } from '../utils/logger.js';
import { collectPRFeedback } from './feedback-collector.js';
import { fetchPRReviewState, type KovaPR, type PRReviewThread, replyToReviewComment } from './github.js';
import { classifyFeedback } from './memory/review-feedback-rest.js';

/** Default feedback types treated as non-actionable (surface, do not auto-resolve). */
export const DEFAULT_NON_ACTIONABLE_TYPES: readonly string[] = [
  'architectural_concern',
  'design_preference',
  'discussion',
];

export interface DispatchEditsInput {
  repoPath: string;
  repoName: string;
  pr: Pick<KovaPR, 'number' | 'branch'>;
  thread: PRReviewThread;
}

export interface DispatchEditsResult {
  /** Whether the dispatch produced a commit pushed to the PR branch. */
  changed: boolean;
  /** Short SHA of the pushed commit when `changed=true`. */
  sha: string | undefined;
}

export type DispatchEdits = (input: DispatchEditsInput) => Promise<DispatchEditsResult>;

export interface ResolvePRReviewThreadsOptions {
  repoPath: string;
  repoName: string;
  pr: Pick<KovaPR, 'number' | 'branch'>;
  dispatchEdits: DispatchEdits;
  /** Feedback-type strings to surface rather than auto-resolve. */
  nonActionableTypes?: readonly string[];
  /** Hard cap on dispatch attempts across all threads for this PR. */
  maxIterations?: number;
  /** When supplied, also record feedback episodically (best-effort). */
  episodesConfig?: EpisodicMemoryConfig;
}

export interface ResolvedThreadRecord {
  threadId: string;
  rootCommentId: number | undefined;
  sha: string;
  path: string | undefined;
  line: number | undefined;
}

export interface NonActionableRecord {
  threadId: string;
  rootCommentId: number | undefined;
  reason: string;
  body: string;
  path: string | undefined;
}

export interface ResolverErrorRecord {
  threadId: string;
  message: string;
}

export interface ResolvePRReviewThreadsResult {
  threadsResolved: ResolvedThreadRecord[];
  nonActionable: NonActionableRecord[];
  errors: ResolverErrorRecord[];
}

const DEFAULT_MAX_ITERATIONS = 2;

/**
 * Act on unresolved review threads for a single PR.
 *
 * Returns counts, never throws. Episodic recording, classification, and
 * per-thread dispatch are all best-effort — a failure in any one is captured
 * in `errors` so the next PR can still be processed.
 */
export async function resolvePRReviewThreads(
  options: ResolvePRReviewThreadsOptions,
): Promise<ResolvePRReviewThreadsResult> {
  const {
    repoPath,
    repoName,
    pr,
    dispatchEdits,
    nonActionableTypes = DEFAULT_NON_ACTIONABLE_TYPES,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    episodesConfig,
  } = options;

  const result: ResolvePRReviewThreadsResult = {
    threadsResolved: [],
    nonActionable: [],
    errors: [],
  };

  // Episodic recording — best-effort, never blocks. Done first so we capture
  // signal even if the actionable pass later errors out.
  if (episodesConfig?.enabled) {
    try {
      await collectPRFeedback({
        repoPath,
        repoName,
        prNumber: pr.number,
        episodesConfig,
      });
    } catch (error) {
      log.warn(
        `[review-resolver] collectPRFeedback failed for PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let state: { blockingThreads: PRReviewThread[] };
  try {
    state = await fetchPRReviewState(repoPath, pr.number);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-resolver] Failed to fetch review state for PR #${pr.number}: ${msg}`);
    return result;
  }

  if (state.blockingThreads.length === 0) {
    return result;
  }

  const nonActionableSet = new Set(nonActionableTypes);

  let iterations = 0;
  for (const thread of state.blockingThreads) {
    if (iterations >= maxIterations) {
      result.errors.push({
        threadId: thread.threadId,
        message: `Skipped — maxIterations (${maxIterations}) reached before processing this thread`,
      });
      continue;
    }

    // Classify — non-actionable kinds are surfaced rather than auto-fixed.
    let feedbackType = 'unclassified';
    try {
      feedbackType = classifyFeedback(thread.body);
    } catch {
      // classifyFeedback should never throw, but if it does we treat as actionable
      // so a human still gets a fix attempt.
    }

    if (nonActionableSet.has(feedbackType)) {
      result.nonActionable.push({
        threadId: thread.threadId,
        rootCommentId: thread.rootCommentId,
        reason: feedbackType,
        body: thread.body,
        path: thread.path,
      });
      continue;
    }

    iterations++;

    let dispatchResult: DispatchEditsResult;
    try {
      dispatchResult = await dispatchEdits({
        repoPath,
        repoName,
        pr,
        thread,
      });
    } catch (error) {
      result.errors.push({
        threadId: thread.threadId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!dispatchResult.changed || !dispatchResult.sha) {
      result.errors.push({
        threadId: thread.threadId,
        message: 'dispatchEdits reported no change — leaving thread unresolved for human follow-up',
      });
      continue;
    }

    const sha = dispatchResult.sha;
    result.threadsResolved.push({
      threadId: thread.threadId,
      rootCommentId: thread.rootCommentId,
      sha,
      path: thread.path,
      line: thread.line,
    });

    if (thread.rootCommentId !== undefined) {
      try {
        await replyToReviewComment(repoPath, repoName, pr.number, thread.rootCommentId, `Fixed in ${sha} by kova.`);
      } catch (error) {
        // The thread IS resolved (commit pushed); failing to reply doesn't undo
        // that. Just log — caller can re-attempt the reply if desired.
        log.warn(
          `[review-resolver] Reply failed for thread ${thread.threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return result;
}
