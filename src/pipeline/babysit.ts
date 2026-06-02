// Babysit pipeline — iterate open kova PRs, act on unresolved human review comments.
//
// This is the orchestration layer above review-resolver.ts:
//   - Fetch open kova PRs (or a single specified PR).
//   - For each one, call resolvePRReviewThreads with the injected dispatch.
//   - Aggregate per-PR results into a single summary the CLI can print.
//
// The actual code edits + push happen inside the dispatchEdits callback the
// caller supplies (production wires this to runReviewLoop in a worktree; tests
// inject a stub).

import { fetchKovaPRsWithStatus, type KovaPR } from '../services/github.js';
import {
  type DispatchEdits,
  type ResolvePRReviewThreadsResult,
  resolvePRReviewThreads,
} from '../services/review-resolver.js';
import type { RepoConfig } from '../types/config.js';
import { log } from '../utils/logger.js';

export interface BabysitOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  dispatchEdits: DispatchEdits;
  /** Process a single PR instead of every open kova PR. */
  prNumber?: number | undefined;
  /** Forwarded to resolvePRReviewThreads. */
  maxIterations?: number | undefined;
}

export interface PerPRBabysitResult {
  prNumber: number;
  branch: string;
  url: string;
  result: ResolvePRReviewThreadsResult;
}

export interface BabysitErrorRecord {
  prNumber: number;
  message: string;
}

export interface BabysitResult {
  prsProcessed: number;
  totalResolved: number;
  totalNonActionable: number;
  totalErrors: number;
  perPR: PerPRBabysitResult[];
  errors: BabysitErrorRecord[];
}

export async function runBabysit(options: BabysitOptions): Promise<BabysitResult> {
  const { repoPath, repoName, config, dispatchEdits, prNumber, maxIterations } = options;

  const result: BabysitResult = {
    prsProcessed: 0,
    totalResolved: 0,
    totalNonActionable: 0,
    totalErrors: 0,
    perPR: [],
    errors: [],
  };

  const allPRs = await fetchKovaPRsWithStatus(repoPath);
  if (allPRs.length === 0) {
    log.info('[babysit] No open kova PRs.');
    return result;
  }

  let candidates: KovaPR[];
  if (prNumber !== undefined) {
    candidates = allPRs.filter((pr) => pr.number === prNumber);
    if (candidates.length === 0) {
      result.errors.push({ prNumber, message: `PR #${prNumber} not found among kova PRs` });
      return result;
    }
  } else {
    candidates = [...allPRs];
  }

  for (const pr of candidates) {
    try {
      const resolverResult = await resolvePRReviewThreads({
        repoPath,
        repoName,
        pr,
        dispatchEdits,
        ...(maxIterations !== undefined && { maxIterations }),
        ...(config.episodes?.enabled && { episodesConfig: config.episodes }),
      });
      result.perPR.push({
        prNumber: pr.number,
        branch: pr.branch,
        url: pr.url,
        result: resolverResult,
      });
      result.prsProcessed++;
      result.totalResolved += resolverResult.threadsResolved.length;
      result.totalNonActionable += resolverResult.nonActionable.length;
      result.totalErrors += resolverResult.errors.length;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push({ prNumber: pr.number, message: msg });
      result.prsProcessed++;
      log.warn(`[babysit] PR #${pr.number} failed: ${msg}`);
    }
  }

  return result;
}
