// gatherContext — parallel provider runner with defense-in-depth graceful-degrade
// (issue #431).
//
// Replaces the 8 sequential context-resolution blocks at fix.ts:1020-1257. Each
// provider's `resolve()` is awaited inside its own try/catch so a thrown error
// from one provider can never block another. Returning a multi-key output
// (e.g. episodic-provider returning `{episodicContext, failedEpisodicContext}`)
// is flattened into the final record.

import type { ContextProvider, ContextProviderInput, MultiContextOutput } from './types.js';

/**
 * Run every provider in parallel and assemble a flat `key → text` map.
 *
 * - A provider returning `undefined` contributes nothing.
 * - A provider returning a plain `string` contributes `{ [provider.name]: str }`.
 * - A provider returning a `MultiContextOutput` contributes its raw key/value
 *   pairs (overriding `provider.name`); `undefined` values are filtered out.
 * - A provider that THROWS contributes nothing; the error is logged via
 *   `ctx.logger.warn` and the run continues. This is the defense-in-depth
 *   layer — most providers already swallow internally, but a thrown error
 *   must never reach the wave dispatch path.
 */
export async function gatherContext(
  providers: readonly ContextProvider[],
  ctx: ContextProviderInput,
): Promise<Record<string, string | undefined>> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const out = await provider.resolve(ctx);
        return { provider, out } as const;
      } catch (err) {
        ctx.logger.warn(
          `[context:${provider.name}] degraded — proceeding without context: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { provider, out: undefined } as const;
      }
    }),
  );

  const merged: Record<string, string | undefined> = {};
  for (const { provider, out } of results) {
    if (out === undefined) continue;
    if (typeof out === 'string') {
      if (out.length > 0) merged[provider.name] = out;
      continue;
    }
    // Multi-key output: copy each non-undefined entry.
    for (const [key, value] of Object.entries(out as MultiContextOutput)) {
      if (typeof value === 'string' && value.length > 0) merged[key] = value;
    }
  }
  return merged;
}
