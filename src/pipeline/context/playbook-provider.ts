// Playbook synthesis context provider (issue #431, originally #299).
//
// Mirrors the post-WAVE-A block at fix.ts:1244-1257. Queries the playbook
// store for a distilled playbook matching this issue and formats it for the
// spec wave. Default off; gated by `config.playbooks?.enabled`. Graceful
// degradation — never blocks the fix on failure.

import { formatPlaybook, queryPlaybook } from '../../services/vectordb.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const playbookProvider: ContextProvider = {
  name: 'playbookContext',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    if (!ctx.config.playbooks?.enabled) return undefined;
    const query = `${ctx.issue.title}\n\n${ctx.issue.body}`;
    const playbook = await queryPlaybook(ctx.config.playbooks, query, {
      repo: ctx.repoName,
      language: ctx.language !== 'unknown' ? ctx.language : undefined,
    });
    if (!playbook) return undefined;
    return formatPlaybook(playbook);
  },
};
