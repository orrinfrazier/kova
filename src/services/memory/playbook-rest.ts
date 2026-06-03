// Playbook REST client + clustering / synthesis primitives (#299) — closes
// the learning loop. Successful episodes cluster by (label ∩, language =,
// file ∩), get distilled by an injected synth fn into a PlaybookRecord,
// and persist to the playbooks endpoint for later spec-wave injection.

import type { PlaybooksConfig } from '../../types/config.js';
import type { EpisodeForCluster, PlaybookRecord, SynthesizeFn } from '../../types/memory.js';
import { log } from '../../utils/logger.js';

export type { EpisodeForCluster, PlaybookRecord, SynthesizeFn } from '../../types/memory.js';

/**
 * Group successful episodes into clusters that share enough context to be
 * worth synthesising together. The cluster predicate is:
 *  - at least one label in common across every pair,
 *  - identical `language`,
 *  - at least one file in common across every pair.
 *
 * Only `outcome === 'success'` episodes are eligible (failures and partials
 * are noise for procedural distillation — they go through the
 * `formatFailedEpisodes` injection instead).
 *
 * Returns only clusters of size >= `minSize`. Returns [] if `minSize < 2`
 * (a single-episode "cluster" is just the episode itself; no pattern to
 * distill).
 */
export function clusterEpisodes(episodes: EpisodeForCluster[], minSize: number): EpisodeForCluster[][] {
  if (minSize < 2 || episodes.length === 0) {
    return [];
  }

  const successes = episodes.filter((e) => e.outcome === 'success');
  const clusters: EpisodeForCluster[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < successes.length; i++) {
    const seed = successes[i];
    if (!seed || assigned.has(i)) continue;
    const cluster: EpisodeForCluster[] = [seed];
    const clusterIdxs: number[] = [i];

    for (let j = i + 1; j < successes.length; j++) {
      const candidate = successes[j];
      if (!candidate || assigned.has(j)) continue;
      // Every member of the cluster must share label + language + at least
      // one file with the candidate. Pairwise check against current members.
      const compatible = cluster.every((member) => sharePairContext(member, candidate));
      if (compatible) {
        cluster.push(candidate);
        clusterIdxs.push(j);
      }
    }

    if (cluster.length >= minSize) {
      for (const idx of clusterIdxs) assigned.add(idx);
      clusters.push(cluster);
    }
  }

  return clusters;
}

function sharePairContext(a: EpisodeForCluster, b: EpisodeForCluster): boolean {
  if (a.language !== b.language) return false;
  const sharedLabel = a.labels.some((l) => b.labels.includes(l));
  if (!sharedLabel) return false;
  const sharedFile = a.files_changed.some((f) => b.files_changed.includes(f));
  if (!sharedFile) return false;
  return true;
}

/**
 * Distill a cluster of successful episodes into a single PlaybookRecord
 * via the injected `synthesizeFn`. Returns `null` (with a warning logged)
 * on any failure — synthesis NEVER blocks the calling fix.
 *
 * Returns `null` when:
 *  - the cluster has fewer than 2 episodes (no pattern to extract),
 *  - the synth fn throws,
 *  - the synth fn returns malformed output (missing/invalid steps array).
 */
export async function synthesizePlaybook(
  episodes: EpisodeForCluster[],
  synthesizeFn: SynthesizeFn,
): Promise<PlaybookRecord | null> {
  if (episodes.length < 2) {
    return null;
  }

  let synthOut: Awaited<ReturnType<SynthesizeFn>>;
  try {
    synthOut = await synthesizeFn(episodes);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Synthesis failed: ${msg} — skipping playbook generation`);
    return null;
  }

  if (
    !synthOut ||
    !Array.isArray(synthOut.steps) ||
    !Array.isArray(synthOut.gotchas) ||
    !Array.isArray(synthOut.files_to_touch)
  ) {
    log.warn('[playbooks] Synthesis returned malformed output — skipping');
    return null;
  }

  // Cluster metadata: intersect labels (only labels common to ALL episodes),
  // language is consistent by cluster invariant, files = union of all touched.
  const commonLabels = intersectAll(episodes.map((e) => e.labels));
  const language = episodes[0]?.language;
  const allFiles = Array.from(new Set(episodes.flatMap((e) => e.files_changed)));

  return {
    trigger: {
      labels: commonLabels,
      language,
      file_globs: allFiles,
    },
    steps: synthOut.steps,
    gotchas: synthOut.gotchas,
    files_to_touch: synthOut.files_to_touch,
    episode_refs: episodes.map((e) => e.issue_number),
    synthesized_from_count: episodes.length,
    created_at: new Date().toISOString(),
  };
}

function intersectAll(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  if (!first) return [];
  return first.filter((item) => rest.every((other) => other.includes(item)));
}

/**
 * Render a PlaybookRecord as a Markdown section ready for injection into
 * the SPEC wave prompt. Returns '' for null (graceful, mirrors
 * `formatEpisodes`).
 */
export function formatPlaybook(playbook: PlaybookRecord | null): string {
  if (!playbook) return '';

  const labelLine = playbook.trigger.labels.length > 0 ? `labels=${playbook.trigger.labels.join(',')}` : 'labels=any';
  const langLine = `language=${playbook.trigger.language ?? 'any'}`;
  const triggerFiles =
    playbook.trigger.file_globs.length > 0
      ? `\n\n**Surface area:**\n${playbook.trigger.file_globs.map((f) => `- ${f}`).join('\n')}`
      : '';

  const steps =
    playbook.steps.length > 0 ? playbook.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '_(no steps recorded)_';

  const gotchas = playbook.gotchas.length > 0 ? playbook.gotchas.map((g) => `- ${g}`).join('\n') : '_(none recorded)_';

  const filesToTouch =
    playbook.files_to_touch.length > 0 ? playbook.files_to_touch.map((f) => `- ${f}`).join('\n') : '_(none recorded)_';

  return [
    `## Playbook: distilled from ${playbook.synthesized_from_count} similar past fixes (issues ${playbook.episode_refs.map((n) => `#${n}`).join(', ')})`,
    '',
    `**Trigger:** ${labelLine}; ${langLine}${triggerFiles}`,
    '',
    '### Steps',
    steps,
    '',
    '### Gotchas',
    gotchas,
    '',
    '### Files to touch',
    filesToTouch,
  ].join('\n');
}

/**
 * Query the playbooks endpoint for a playbook matching the given query
 * (issue title + body, typically). Returns null on disabled, missing
 * endpoint, network error, non-200, or malformed response.
 *
 * The endpoint contract: POST `{query, repo?, language?}`, returns
 * `{playbook: PlaybookRecord | null}`.
 */
export async function queryPlaybook(
  config: PlaybooksConfig,
  query: string,
  options?: { repo?: string | undefined; language?: string | undefined },
): Promise<PlaybookRecord | null> {
  if (!config.enabled) return null;
  if (!config.endpoint) {
    log.warn('[playbooks] Enabled but no endpoint configured — skipping');
    return null;
  }

  try {
    const body: Record<string, unknown> = { query };
    if (options?.repo) body.repo = options.repo;
    if (options?.language) body.language = options.language;

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      log.warn(`[playbooks] Endpoint returned ${response.status} — skipping playbook injection`);
      return null;
    }

    const data = (await response.json()) as { playbook?: PlaybookRecord | null };
    if (!data || !('playbook' in data) || !data.playbook) {
      return null;
    }

    log.info(`[playbooks] Retrieved playbook (${data.playbook.synthesized_from_count} source episodes)`);
    return data.playbook;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Failed to query endpoint: ${msg} — skipping playbook injection`);
    return null;
  }
}

/**
 * Persist a PlaybookRecord to the playbooks endpoint. Returns true on
 * 200-class response, false on any failure mode (disabled, missing
 * endpoint, network error, non-200). Never throws.
 */
export async function recordPlaybook(config: PlaybooksConfig, playbook: PlaybookRecord): Promise<boolean> {
  if (!config.enabled) return false;
  if (!config.endpoint) {
    log.warn('[playbooks] Enabled but no endpoint configured — playbook not saved');
    return false;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(playbook),
    });

    if (!response.ok) {
      log.warn(`[playbooks] Recording endpoint returned ${response.status} — playbook not saved`);
      return false;
    }

    log.info(`[playbooks] Recorded playbook (${playbook.synthesized_from_count} source episodes)`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Failed to record playbook: ${msg}`);
    return false;
  }
}
