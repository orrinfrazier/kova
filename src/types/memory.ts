// Shared types for the memory subsystem (REST-endpoint clients under
// src/services/memory/). Lives in src/types/ so that consumers can take a
// type-only import without pulling the REST runtime.

/* ================================================================== */
/*  Code chunks (queryCodeContext / formatCodeChunks / upsertChunks)    */
/* ================================================================== */

export interface CodeChunk {
  file: string;
  content: string;
  score: number;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

/* ================================================================== */
/*  Episodic memory                                                     */
/* ================================================================== */

export interface EpisodeContext {
  issue_number: number;
  issue_title: string;
  approach: string;
  outcome: 'success' | 'partial' | 'failure';
  learnings: string;
  score: number;
  repo?: string | undefined;
}

export interface CrossRepoQueryOptions {
  repo?: string | undefined;
  language?: string | undefined;
}

export interface EpisodeRecord {
  issue_number: number;
  issue_title: string;
  labels: string[];
  repo: string;
  language?: string | undefined;
  approach: string;
  files_changed: string[];
  quality_gates: {
    lint: string;
    typecheck: string;
    tests: string;
    coverage?: number | undefined;
    audit: string;
    all_passing: boolean;
  } | null;
  review_findings: Array<{
    category: string;
    file: string;
    severity: string;
    description: string;
  }>;
  outcome: 'pr_created' | 'failed' | 'skipped';
  error_message?: string | undefined;
  learnings?: string | undefined;
  failed_wave_output?: string | undefined;
  failed_at_wave: string | null;
  diagnosis?: 'SPEC_WRONG' | 'APPROACH_WRONG' | 'MISSING_CONTEXT' | 'STUCK' | undefined;
  thrashing_signal?: 'SAME_FILES' | 'DIFFERENT_FILES' | 'NORMAL' | 'INSUFFICIENT_DATA' | undefined;
  retry_attempts?: number | undefined;
  total_cost: number;
  total_duration: number;
  total_turns: number;
  timestamp: string;
}

/* ================================================================== */
/*  Review feedback                                                     */
/* ================================================================== */

export interface ReviewFeedbackRecord {
  repo: string;
  pr_number: number;
  feedback_type: string;
  comment_text: string;
  file_path?: string | undefined;
  author?: string | undefined;
}

export type ReviewFeedbackInput = ReviewFeedbackRecord;

export interface ReviewFeedbackItem {
  feedback_type: string;
  pr_number: number;
  comment_text: string;
  file_path?: string | undefined;
}

/* ================================================================== */
/*  Playbooks (#299)                                                    */
/* ================================================================== */

/**
 * The shape an episode needs to be considered for playbook clustering.
 * A subset of `EpisodeRecord` — only the fields the cluster needs.
 */
export interface EpisodeForCluster {
  issue_number: number;
  issue_title: string;
  labels: string[];
  language?: string | undefined;
  files_changed: string[];
  approach: string;
  outcome: 'success' | 'partial' | 'failure' | 'pr_created' | 'failed' | 'skipped';
  learnings?: string | undefined;
}

/**
 * A distilled procedural playbook synthesised from a cluster of similar
 * successful episodes. Persisted to the playbooks endpoint, retrieved later
 * to inject into the SPEC wave context.
 */
export interface PlaybookRecord {
  /** What kind of issue this playbook applies to. */
  trigger: {
    /** Labels common to the source cluster — match on intersection. */
    labels: string[];
    /** Language the cluster targets (single value — cluster requires equality). */
    language: string | undefined;
    /** Files whose presence in the issue's surface area implies this playbook applies. */
    file_globs: string[];
  };
  /** Ordered procedural steps distilled from the cluster. */
  steps: string[];
  /** Pitfalls observed across episodes. */
  gotchas: string[];
  /** Files typically touched when this playbook is applied. */
  files_to_touch: string[];
  /** Issue numbers of the source episodes. */
  episode_refs: number[];
  /** Cluster size at synthesis time. */
  synthesized_from_count: number;
  /** ISO-8601 timestamp of synthesis. */
  created_at: string;
}

/**
 * Synthesis function shape — injected so the synthesiser is pure for tests
 * and so the cheap-model call sits behind the same boundary as the rest of
 * the AI surface. The function receives the cluster and returns the
 * distilled fields (the cluster metadata — trigger labels/language/files,
 * episode_refs, count, created_at — is filled in by `synthesizePlaybook`
 * itself; the LLM only owns the distilled human content).
 */
export type SynthesizeFn = (episodes: EpisodeForCluster[]) => Promise<{
  trigger_description: string;
  steps: string[];
  gotchas: string[];
  files_to_touch: string[];
}>;
