// Call-path context provider (issue #431, originally #275).
//
// Mirrors the post-WAVE-A block at fix.ts:1193-1233. Scans the issue's
// surface-area files for HTTP route bindings (`app.get('/x', handler)`) and
// resolves each handler symbol against the codegraph. Sits BELOW
// codegraphContext (symbol-level facts already most precise) and ABOVE
// codebaseContext (framework-resolved beats fuzzy vector neighbors).
//
// Graceful degradation contract (mirrors #273):
//  - No assess artifact / no surface_area files -> undefined.
//  - No route bindings detected in any file -> undefined.
//  - No handler resolves in the graph -> undefined.
//  - Any unexpected error -> warn + undefined.

import { readFileSync } from 'node:fs';
import { isAbsolute, join as joinPath } from 'node:path';
import { openCodegraph } from '../../services/codegraph/index.js';
import { resolveCallPaths } from '../call-path-context.js';
import type { ContextProvider, ContextProviderInput } from './types.js';

export const callPathProvider: ContextProvider = {
  name: 'callPathContext',
  async resolve(ctx: ContextProviderInput): Promise<string | undefined> {
    try {
      const assessFiles = ctx.assessResult?.surface_area.files ?? [];
      if (assessFiles.length === 0) return undefined;
      const dbPath = joinPath(ctx.repoPath, '.kova', 'codegraph.db');
      const cg = openCodegraph(dbPath);
      try {
        const formatted = resolveCallPaths({
          graph: cg,
          files: assessFiles,
          readSource: (relPath) => {
            const abs = isAbsolute(relPath) ? relPath : joinPath(ctx.repoPath, relPath);
            return readFileSync(abs, 'utf8');
          },
        });
        if (formatted.length === 0) return undefined;
        const routeCount = (formatted.match(/^### /gm) ?? []).length;
        ctx.logger.info(`[call-path-context] injected (${routeCount} routes, ${formatted.length} chars)`);
        return formatted;
      } finally {
        cg.close();
      }
    } catch (err) {
      ctx.logger.warn(
        `[call-path-context] degraded — proceeding without call-path context: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  },
};
