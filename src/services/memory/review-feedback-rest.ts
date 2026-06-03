// Review-feedback REST client — classifies reviewer comments, persists
// them to the episodic memory endpoint, formats them for retry-prompt
// injection, and queries the endpoint for past feedback similar to a query.

import type { EpisodicMemoryConfig } from '../../types/config.js';
import type { ReviewFeedbackItem, ReviewFeedbackRecord } from '../../types/memory.js';
import type { FeedbackType } from '../../types/vectordb.js';
import { log } from '../../utils/logger.js';

export type { ReviewFeedbackInput, ReviewFeedbackItem, ReviewFeedbackRecord } from '../../types/memory.js';

/* ------------------------------------------------------------------ */
/*  classifyFeedback                                                    */
/* ------------------------------------------------------------------ */

const FEEDBACK_KEYWORDS: Array<[RegExp, FeedbackType]> = [
  [/\btest\b/i, 'missing_test'],
  [/\bsecurity\b/i, 'security_concern'],
  [/\binjection\b/i, 'security_concern'],
  [/\bauth\b/i, 'security_concern'],
  [/\bnaming\b/i, 'naming'],
  [/\brename\b/i, 'naming'],
  [/\barchitecture\b/i, 'architecture'],
  [/\bstructure\b/i, 'architecture'],
  [/\bpattern\b/i, 'architecture'],
  [/\bperformance\b/i, 'performance'],
  [/\bslow\b/i, 'performance'],
  [/\bmemory\b/i, 'performance'],
  [/\bdoc\b/i, 'documentation'],
  [/\bcomment\b/i, 'documentation'],
  [/\breadme\b/i, 'documentation'],
  [/\blogic\b/i, 'logic_error'],
  [/\bbug\b/i, 'logic_error'],
  [/\bincorrect\b/i, 'logic_error'],
  [/\bwrong\b/i, 'logic_error'],
  [/\bstyle\b/i, 'style_issue'],
  [/\bformat\b/i, 'style_issue'],
];

export function classifyFeedback(text: string): FeedbackType {
  for (const [regex, type] of FEEDBACK_KEYWORDS) {
    if (regex.test(text)) {
      return type;
    }
  }
  return 'style_issue';
}

/* ------------------------------------------------------------------ */
/*  recordReviewFeedback — REST endpoint (graceful degradation)         */
/* ------------------------------------------------------------------ */

export async function recordReviewFeedback(
  config: EpisodicMemoryConfig,
  records: ReviewFeedbackRecord[],
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  if (!config.endpoint) {
    log.warn('[review-feedback] Enabled but no endpoint configured — skipping recording');
    return false;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(records),
    });

    if (!response.ok) {
      log.warn(`[review-feedback] Recording endpoint returned ${response.status} — feedback not saved`);
      return false;
    }

    log.info(`[review-feedback] Recorded ${records.length} feedback items`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to record feedback: ${msg}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  formatReviewFeedback — markdown output                              */
/* ------------------------------------------------------------------ */

export function formatReviewFeedback(feedback: ReviewFeedbackItem[]): string {
  if (feedback.length === 0) {
    return '';
  }

  const sections = feedback.map((f) => {
    const parts = [`- [${f.feedback_type}] PR #${f.pr_number}: "${f.comment_text}"`];
    if (f.file_path) {
      parts.push(`  file: ${f.file_path}`);
    }
    return parts.join('\n');
  });

  return `## Past reviewer feedback\n\n${sections.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/*  queryReviewFeedbackContext — REST endpoint (pipeline context)        */
/* ------------------------------------------------------------------ */

interface ReviewFeedbackContextResponse {
  feedback?: ReviewFeedbackItem[];
}

/**
 * Query the episodic memory REST endpoint for past review feedback similar to the given query.
 * Returns an empty array if disabled, on error, or if the response is malformed.
 */
export async function queryReviewFeedbackContext(
  config: EpisodicMemoryConfig,
  query: string,
  repo?: string,
): Promise<ReviewFeedbackItem[]> {
  if (!config.enabled) {
    return [];
  }

  if (!config.endpoint) {
    log.warn('[review-feedback] Enabled but no endpoint configured — skipping');
    return [];
  }

  try {
    const body: Record<string, unknown> = { query, type: 'review_feedback', top_k: config.max_episodes };
    if (repo) {
      body.repo = repo;
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      log.warn(`[review-feedback] Endpoint returned ${response.status} — skipping feedback context`);
      return [];
    }

    const data = (await response.json()) as ReviewFeedbackContextResponse;

    if (!data.feedback || !Array.isArray(data.feedback)) {
      log.warn('[review-feedback] Malformed response (missing feedback array) — skipping');
      return [];
    }

    log.info(`[review-feedback] Retrieved ${data.feedback.length} past feedback items`);
    return data.feedback;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to query endpoint: ${msg} — skipping feedback context`);
    return [];
  }
}
