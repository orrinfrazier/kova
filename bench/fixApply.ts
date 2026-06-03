// Real fixApply — invokes kova's real `fix()` against the per-fixture workdir.
//
// This module is the ONLY place in `bench/` that imports from `../src`,
// keeping the runner/loader/scorer (and their tests) free of the kova
// runtime dependency. The CLI lazy-imports this so a `--dry-run` or a
// future stub-fixApply mode never pulls in the agent stack.

import { type RepoConfig, RepoConfigSchema } from '../src/types/index.js';
import type { FixApply, FixApplyResult, WaveRecord } from './types.js';

/**
 * Build a defaulted in-memory `RepoConfig` for bench fixtures.
 *
 * Bench fixture seed repos under `bench/fixtures/<id>/repo/` are
 * intentionally minimal and do NOT ship a `repos.yaml` — see issue
 * #373. This builder produces a fully-defaulted `RepoConfig` (Zod
 * fills in `rules`, `model`, `isolation`) without touching the
 * filesystem, so `npm run bench` works against bare fixture repos.
 *
 * Pass a `configOverride` to override any field. The `path` argument
 * is used unless overridden explicitly.
 *
 * Note: the default config implies that any provider not configured
 * (no `providers.ollama` in the override) will fall back to the
 * Anthropic API. `ANTHROPIC_API_KEY` must be set for `npm run bench`
 * unless you pass an override that pins models to a local provider.
 */
export function buildDefaultBenchConfig(workdir: string, configOverride?: Partial<RepoConfig>): RepoConfig {
  const base = { path: workdir, ...(configOverride ?? {}) };
  return RepoConfigSchema.parse(base);
}

/**
 * Build a `FixApply` that drives kova's real `fix()` end-to-end inside
 * the bench workdir. Each call mints an in-memory `Issue` (number 0,
 * url '', labels []) from the fixture's title+body.
 *
 * The optional `configOverride` is merged on top of
 * `buildDefaultBenchConfig` — useful for pinning the bench to a local
 * model provider or tweaking rules (coverage, concurrency) per run.
 * When omitted, the fully-defaulted bench config is used.
 *
 * The returned FixApply ALWAYS resolves — even on `fix()` failure — so
 * the harness scores the run as failed via the acceptance command,
 * never via a thrown promise. (The runner already wraps fixApply in a
 * try/catch, but emitting a structured result here makes the per-wave
 * cost/timing breakdown available even on failure.)
 */
export function createRealFixApply(repoName: string, configOverride?: Partial<RepoConfig>): FixApply {
  return async ({ workdir, issue, fixtureId }): Promise<FixApplyResult> => {
    // Lazy import keeps `import('./fixApply.js')` from pulling in the
    // entire kova runtime when the harness is only running self-tests.
    const { fix } = await import('../src/pipeline/fix.js');

    const startedAt = Date.now();
    const config = buildDefaultBenchConfig(workdir, configOverride);
    const issuePayload = {
      number: 0,
      title: issue.title,
      body: issue.body,
      labels: [],
      url: '',
    };

    let totalCost = 0;
    const waves: WaveRecord[] = [];
    try {
      const result = await fix({
        issue: issuePayload,
        repoPath: workdir,
        repoName,
        config,
        fresh: true,
        noComment: true,
      });

      // Pull per-wave cost/duration out of the state for the JSONL line.
      for (const [name, wr] of Object.entries(result.state.waveResults)) {
        if (!wr) continue;
        const cost = typeof wr.cost === 'number' ? wr.cost : 0;
        const duration = typeof wr.duration === 'number' ? wr.duration : 0;
        totalCost += cost;
        waves.push({ name, durationMs: duration, cost });
      }
      return { cost: totalCost, waves };
    } catch (err) {
      // Surface failure as a single error wave so the JSONL line still
      // carries the timing info. The runner will mark passed:false from
      // the acceptance command.
      waves.push({
        name: 'error',
        durationMs: Date.now() - startedAt,
        cost: 0,
      });
      // Re-throw so the runner records the error message — it already
      // catches and stores it on the result.
      throw new Error(`real fix() failed on fixture ${fixtureId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
