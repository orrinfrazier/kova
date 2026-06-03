// Codegraph context provider (issue #431, originally #273).
//
// Mirrors the post-WAVE-A block at fix.ts:1164-1191. Resolves exact definition
// spans + callers/callees + call paths for symbols named in the issue. Sits
// ABOVE the fuzzy codebase chunks (see `context.ts` ordering).
//
// Graceful degradation: any failure leaves `codegraphContext` undefined and
// downstream waves proceed with only the fuzzy `codebaseContext`. The provider
// catches errors locally so a transient codegraph DB failure cannot abort the
// fix — matching the original behavior exactly.

import { join as joinPath } from 'node:path';
import { extractSymbolCandidates, formatCodegraphContext } from '../../ai/codegraph.js';
import { openCodegraph } from '../../codegraph/index.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const codegraphProvider: ContextProvider = {
  name: 'codegraphContext',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    try {
      const symbolNames = extractSymbolCandidates(`${ctx.issue.title}\n\n${ctx.issue.body}`);
      if (symbolNames.length === 0) return undefined;
      const dbPath = joinPath(ctx.repoPath, '.kova', 'codegraph.db');
      const cg = openCodegraph(dbPath);
      try {
        const formatted = formatCodegraphContext({ graph: cg, symbolNames });
        if (formatted.length === 0) return undefined;
        ctx.logger.info(
          `[codegraph-context] injected (${symbolNames.length} candidate symbols, ${formatted.length} chars)`,
        );
        return formatted;
      } finally {
        cg.close();
      }
    } catch (err) {
      ctx.logger.warn(
        `[codegraph-context] degraded — proceeding without graph context: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  },
};
