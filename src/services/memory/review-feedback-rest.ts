// Review-feedback client — classifies reviewer comments, persists them to
// the local sqlite-vec store, formats them for retry-prompt injection, and
// queries the local store for past feedback similar to a query (#433 — was
// REST, now sqlite-vec per ADR 002). Filename retained as `*-rest.ts` for
// the duration of #433 → #434 to keep the patch minimal.

import { join as joinPath } from 'node:path';
import type { EpisodicMemoryConfig } from '../../types/config.js';
import type { ReviewFeedbackItem, ReviewFeedbackRecord } from '../../types/memory.js';
import type { FeedbackType } from '../../types/vectordb.js';
import { log } from '../../utils/logger.js';
import { ReviewFeedbackStore } from './review-feedback-store.js';

export type { ReviewFeedbackInput, ReviewFeedbackItem, ReviewFeedbackRecord } from '../../types/memory.js';

function resolveFeedbackDbPath(workDir: string): string {
  return joinPath(workDir, '.kova', 'review-feedback-vec.db');
}

function openFeedbackStore(workDir: string): ReviewFeedbackStore | null {
  try {
    return new ReviewFeedbackStore(resolveFeedbackDbPath(workDir));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to open local sqlite-vec store: ${msg}`);
    return null;
  }
}

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
/*  recordReviewFeedback — local sqlite-vec store                       */
/* ------------------------------------------------------------------ */

export async function recordReviewFeedback(
  config: EpisodicMemoryConfig,
  records: ReviewFeedbackRecord[],
  workDir?: string,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }
  if (!workDir) {
    log.warn('[review-feedback] Enabled but no workDir provided — skipping recording');
    return false;
  }

  const store = openFeedbackStore(workDir);
  if (!store) return false;

  try {
    store.recordFeedback(records);
    log.info(`[review-feedback] Recorded ${records.length} feedback items`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to record feedback: ${msg}`);
    return false;
  } finally {
    store.close();
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
/*  queryReviewFeedbackContext — local sqlite-vec store                 */
/* ------------------------------------------------------------------ */

/**
 * Query the local sqlite-vec store for past review feedback similar to the
 * given query. Returns an empty array on disabled / missing workDir / no match.
 */
export async function queryReviewFeedbackContext(
  config: EpisodicMemoryConfig,
  query: string,
  repo?: string,
  workDir?: string,
): Promise<ReviewFeedbackItem[]> {
  if (!config.enabled) {
    return [];
  }
  if (!workDir) {
    log.warn('[review-feedback] Enabled but no workDir provided — skipping');
    return [];
  }

  const store = openFeedbackStore(workDir);
  if (!store) return [];

  try {
    const results = store.queryFeedback(query, config.max_episodes, repo);
    if (results.length > 0) {
      log.info(`[review-feedback] Retrieved ${results.length} past feedback items`);
    }
    return results;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[review-feedback] Failed to query local store: ${msg} — skipping feedback context`);
    return [];
  } finally {
    store.close();
  }
}
