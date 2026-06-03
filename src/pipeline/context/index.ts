// Barrel for the pipeline context-provider module (issue #431).
//
// Two ordered tuples expose the canonical pre-assess and post-assess provider
// groups that the fix orchestrator consumes. They mirror the original
// fix.ts:1020-1257 ordering 1:1 so injected context strings land in the same
// keys downstream (`episodicContext`, `repoContextText`, `patternContext`,
// then `codebaseContext`, `codegraphContext`, `callPathContext`,
// `repoSearchText`, `playbookContext`).
//
// Callers receive the merged result via `gatherContext()` keyed by the names
// each provider chooses (see `types.ts:MultiContextOutput` for the multi-key
// case episodic uses).

export { gatherContext } from './gather.js';
export type {
  ContextProvider,
  ContextProviderInput,
  ContextProviderResult,
  MultiContextOutput,
} from './types.js';

import { callPathProvider } from './call-path-provider.js';
import { codegraphProvider } from './codegraph-provider.js';
import { episodicProvider } from './episodic-provider.js';
import { patternProvider } from './pattern-provider.js';
import { playbookProvider } from './playbook-provider.js';
import { repoIntelProvider } from './repo-intel-provider.js';
import { repoSearchProvider } from './repo-search-provider.js';
import type { ContextProvider } from './types.js';
import { vectordbProvider } from './vectordb-provider.js';

export {
  callPathProvider,
  codegraphProvider,
  episodicProvider,
  patternProvider,
  playbookProvider,
  repoIntelProvider,
  repoSearchProvider,
  vectordbProvider,
};

/**
 * Providers that run BEFORE WAVE A (assess). They feed the assess wave's
 * user-message context. Order matches the original fix.ts:1020-1077 block.
 */
export const PRE_ASSESS_CONTEXT_PROVIDERS: readonly ContextProvider[] = [
  episodicProvider,
  repoIntelProvider,
  patternProvider,
];

/**
 * Providers that run AFTER WAVE A. They feed the spec/impl wave context and
 * can consult `ctx.assessResult.surface_area.files` (call-path uses this).
 * Order matches the original fix.ts:1154-1257 block.
 */
export const POST_ASSESS_CONTEXT_PROVIDERS: readonly ContextProvider[] = [
  vectordbProvider,
  codegraphProvider,
  callPathProvider,
  repoSearchProvider,
  playbookProvider,
];
