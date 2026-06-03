// repo-intel similar-implementation search provider (issue #431).
//
// Mirrors the post-WAVE-A block at fix.ts:1235-1242. Queries the repo-intel
// MCP for similar implementations matching the issue title+body and formats
// them for the spec wave. Gated by `config.repo_intel?.enabled` AND the
// presence of an `owner/repo` slug.

import { formatRepoSearch, queryRepoSearch } from '../../services/repo-intel.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const repoSearchProvider: ContextProvider = {
  name: 'repoSearchText',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    if (!ctx.config.repo_intel?.enabled || !ctx.ownerRepo) return undefined;
    const raw = await queryRepoSearch(ctx.config.repo_intel, ctx.ownerRepo, `${ctx.issue.title}\n\n${ctx.issue.body}`);
    if (raw.length === 0) return undefined;
    return formatRepoSearch(raw);
  },
};
