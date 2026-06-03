// Feedback collector — orchestrates PR review comment collection, classification, and recording.

import { classifyFeedback, recordReviewFeedback } from '../memory/review-feedback-rest.js';
import type { EpisodicMemoryConfig } from '../types/config.js';
import type { ReviewFeedbackRecord } from '../types/memory.js';
import { log } from '../utils/logger.js';
import { fetchPRReviewComments } from '../vcs/github.js';

const BOT_AUTHORS = new Set(['kova', 'github-actions']);

interface CollectPRFeedbackOptions {
  repoPath: string;
  repoName: string;
  prNumber: number;
  episodesConfig: EpisodicMemoryConfig;
  /** Worktree path — where the local sqlite-vec feedback DB lives. */
  workDir?: string | undefined;
}

interface CollectPRFeedbackResult {
  feedbackCount: number;
  patternsDetected: string[];
}

/**
 * Collect feedback from PR review comments, classify each, and record to episodic memory.
 * Graceful degradation: catches all errors, returns empty result on failure.
 */
export async function collectPRFeedback(options: CollectPRFeedbackOptions): Promise<CollectPRFeedbackResult> {
  const { repoPath, repoName, prNumber, episodesConfig, workDir } = options;
  const empty: CollectPRFeedbackResult = { feedbackCount: 0, patternsDetected: [] };

  try {
    const comments = await fetchPRReviewComments(repoPath, prNumber);

    if (comments.length === 0) {
      return empty;
    }

    // Filter out bot comments (defense-in-depth)
    const humanComments = comments.filter((c) => !BOT_AUTHORS.has(c.author));

    if (humanComments.length === 0) {
      return empty;
    }

    // Classify each comment
    const records: ReviewFeedbackRecord[] = [];
    const patterns: Set<string> = new Set();

    for (const comment of humanComments) {
      const feedbackType = classifyFeedback(comment.body);
      patterns.add(feedbackType);
      records.push({
        repo: repoName,
        pr_number: prNumber,
        feedback_type: feedbackType,
        comment_text: comment.body,
        file_path: comment.path,
        author: comment.author,
      });
    }

    // Record classified feedback
    await recordReviewFeedback(episodesConfig, records, workDir);

    return {
      feedbackCount: records.length,
      patternsDetected: [...patterns],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[feedback-collector] Failed to collect PR feedback: ${msg}`);
    return empty;
  }
}
