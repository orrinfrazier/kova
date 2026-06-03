// Vector DB code-chunk context provider (issue #431).
//
// Mirrors the post-WAVE-A block at fix.ts:1154-1162. Queries the configured
// vector store for fuzzy code chunks relevant to the issue and formats them
// for injection into the spec/impl wave context. Gated by
// `config.vectordb?.enabled`; empty results produce `undefined`.

import { formatCodeChunks, queryCodeContext } from '../../memory/code-rest.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const vectordbProvider: ContextProvider = {
  name: 'codebaseContext',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    if (!ctx.config.vectordb?.enabled) return undefined;
    const query = `${ctx.issue.title}\n\n${ctx.issue.body}`;
    const chunks = await queryCodeContext(ctx.config.vectordb, query);
    if (chunks.length === 0) return undefined;
    return formatCodeChunks(chunks);
  },
};
