/**
 * Buffer-then-classify pass for review-wave findings.
 *
 * Borrowed from claude-code-action `classify_inline_comments`
 * (oss/claude-code-action/action.yml:116-119). The review wave can be chatty —
 * low-confidence "this might be" probes mixed with real findings at the same
 * severity. We partition them so only the real ones flow to PR comments;
 * probes go to telemetry.
 *
 * Heuristics (kept simple — false-negative-tolerant by design; when unsure
 * we leave it as `real` so a flaky classifier never silently drops critical
 * feedback):
 *
 *   1. severity ∈ {critical, high}                → real (never hide it)
 *   2. category = needs_new_tests AND test_code   → real (concrete repro)
 *   3. description contains a hedge phrase AND
 *      severity ∈ {low, medium}                   → probe
 *   4. default                                    → real
 *
 * The opt-in switch lives at `repos.yaml` `review.classify_inline`; callers
 * read it via the canonical `RepoConfig` shape.
 */

import type { ReviewFinding } from '../types/index.js';

const HEDGE_PATTERNS: readonly RegExp[] = [
  /\bmight\b/i,
  /\bmay\b/i,
  /\bmaybe\b/i,
  /\bpossibly\b/i,
  /\bperhaps\b/i,
  /\bcould\b/i,
  /\bunclear\b/i,
  /\bconsider\b/i,
  /\byou might want to\b/i,
  /\bnot sure\b/i,
];

function hasHedge(description: string): boolean {
  return HEDGE_PATTERNS.some((re) => re.test(description));
}

/**
 * Classify a single finding as a probe (true) or a real review item (false).
 * Pure: no I/O, no mutation.
 */
export function isProbe(finding: ReviewFinding): boolean {
  // Rule 1: never hide critical/high severity.
  if (finding.severity === 'critical' || finding.severity === 'high') {
    return false;
  }

  // Rule 2: needs_new_tests with concrete test code is always real.
  if (finding.category === 'needs_new_tests' && finding.test_code && finding.test_code.trim().length > 0) {
    return false;
  }

  // Rule 3: hedged low/medium description.
  if ((finding.severity === 'low' || finding.severity === 'medium') && hasHedge(finding.description)) {
    return true;
  }

  return false;
}

export interface ClassifiedFindings {
  real: ReviewFinding[];
  probe: ReviewFinding[];
}

/**
 * Partition a finding list into "real" (post to PR) and "probe" (log only).
 * Preserves order within each bucket. Does not mutate inputs.
 */
export function classifyReviewFindings(findings: readonly ReviewFinding[]): ClassifiedFindings {
  const real: ReviewFinding[] = [];
  const probe: ReviewFinding[] = [];
  for (const finding of findings) {
    if (isProbe(finding)) {
      probe.push(finding);
    } else {
      real.push(finding);
    }
  }
  return { real, probe };
}
