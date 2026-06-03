// repo-intel context provider (issue #431).
//
// Mirrors the pre-WAVE-A block at fix.ts:1059-1066: queries the repo-intel
// MCP for repository context (top-level standards, recent activity, similar
// code) keyed by issue title+body. Gated by `config.repo_intel?.enabled`
// AND the presence of an `owner/repo` slug.

import { formatRepoContext, queryRepoContext } from '../../services/repo-intel.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const repoIntelProvider: ContextProvider = {
  name: 'repoContextText',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    if (!ctx.config.repo_intel?.enabled || !ctx.ownerRepo) return undefined;
    const raw = await queryRepoContext(ctx.config.repo_intel, ctx.ownerRepo, `${ctx.issue.title}\n\n${ctx.issue.body}`);
    if (raw.length === 0) return undefined;
    return formatRepoContext(raw);
  },
};
