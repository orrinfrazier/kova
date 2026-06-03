// Context-provider interface (issue #431).
//
// Each provider encapsulates one of the 8 context-resolution blocks that
// previously lived inline in `src/pipeline/fix.ts:1020-1257`:
//   episodic, repo-intel, pattern, vectordb, codegraph, call-path, repo-search,
//   playbook.
//
// All providers preserve the existing graceful-degrade contract: a thrown error
// or empty result MUST resolve to `undefined`, never throw upward. The shared
// `gatherContext()` helper enforces this with a defense-in-depth try/catch.
//
// Some providers historically produced two output strings from a single
// resolution path (episodic → `episodicContext` + `failedEpisodicContext`).
// We model that by letting providers return either a single string OR a
// `MultiContextOutput` of named keys; gatherContext flattens both shapes into
// the final `Record<string, string | undefined>` keyed by `name`.

import type { AssessResult, Issue, RepoConfig } from '../../types/index.js';

/**
 * Everything a provider may consult while resolving its context. Every field
 * is required so providers stay independently testable — gather builds the
 * input once per fix and passes it to every provider unchanged.
 *
 * `assessResult` is populated only AFTER WAVE A has completed. The pre-assess
 * providers (episodic, repo-intel, pattern) see `undefined`; the post-assess
 * providers (vectordb, codegraph, call-path, repo-search, playbook) get the
 * concrete artifact when available.
 */
export interface ContextProviderInput {
  /** The issue being fixed — provides title/body/url for query construction. */
  issue: Issue;
  /** Repo-level config (gates each provider via `config.<feature>.enabled`). */
  config: RepoConfig;
  /** `owner/repo` slug for repo-intel-backed providers. May be `undefined`. */
  ownerRepo: string | undefined;
  /** `owner/repo`-style short name used by episodes for repo scoping. */
  repoName: string;
  /** The user's repo checkout — used by providers reading the codegraph DB. */
  repoPath: string;
  /** The worktree path — used by providers reading `.kova/*` DBs. */
  workDir: string;
  /** Detected language (or `'unknown'`) — episodic + playbook scope by language. */
  language: string;
  /** WAVE A's parsed assess artifact — `undefined` if the wave was skipped or low confidence. */
  assessResult: AssessResult | undefined;
  /**
   * Pluggable logger (info + warn) — providers emit info on injection and
   * warn on degraded paths. Threaded through so tests can capture log lines
   * without touching the global logger module.
   */
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Multi-key output shape — used by providers that produce more than one named
 * context section from a single resolution path. Keys MAY include `undefined`
 * values; gather discards them.
 */
export type MultiContextOutput = Record<string, string | undefined>;

/**
 * Discriminated return type for `resolve()`.
 *  - `undefined` — provider produced nothing (disabled, empty, or degraded).
 *  - `string` — single named output keyed by the provider's `name`.
 *  - `MultiContextOutput` — multiple named outputs (e.g. `episodicContext` +
 *    `failedEpisodicContext`); keys override `name`.
 */
export type ContextProviderResult = string | MultiContextOutput | undefined;

/**
 * The contract every context provider implements. The `name` doubles as the
 * default output key when `resolve()` returns a single string.
 */
export interface ContextProvider {
  readonly name: string;
  resolve(ctx: ContextProviderInput): Promise<ContextProviderResult>;
}
