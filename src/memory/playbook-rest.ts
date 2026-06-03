// Playbook client + clustering / synthesis primitives (#299, migrated to
// sqlite-vec in #433). Successful episodes cluster by (label ∩, language =,
// file ∩), get distilled by an injected synth fn into a PlaybookRecord, and
// persist to the local sqlite-vec-backed `PlaybookStore` for later spec-wave
// injection. Filename retained as `*-rest.ts` for the duration of #433 →
// #434 to keep the patch minimal; #434's mass rename will fold this in.

import { join as joinPath } from 'node:path';
import type { PlaybooksConfig } from '../types/config.js';
import type { EpisodeForCluster, PlaybookRecord, SynthesizeFn } from '../types/memory.js';
import { log } from '../utils/logger.js';
import { PlaybookStore } from './playbook-store.js';

export type { EpisodeForCluster, PlaybookRecord, SynthesizeFn } from '../types/memory.js';

function resolvePlaybookDbPath(workDir: string): string {
  return joinPath(workDir, '.kova', 'playbooks-vec.db');
}

function openPlaybookStore(workDir: string): PlaybookStore | null {
  try {
    return new PlaybookStore(resolvePlaybookDbPath(workDir));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Failed to open local sqlite-vec store: ${msg}`);
    return null;
  }
}

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
 * Query the local sqlite-vec playbook store for the best-matching playbook.
 * Returns null on disabled, missing workDir, or no sufficiently similar match.
 */
export async function queryPlaybook(
  config: PlaybooksConfig,
  query: string,
  options?: { repo?: string | undefined; language?: string | undefined },
  workDir?: string,
): Promise<PlaybookRecord | null> {
  if (!config.enabled) return null;
  if (!workDir) {
    log.warn('[playbooks] Enabled but no workDir provided — skipping playbook injection');
    return null;
  }

  const store = openPlaybookStore(workDir);
  if (!store) return null;

  try {
    const playbook = store.queryPlaybook(query, options?.repo, options?.language);
    if (playbook) {
      log.info(`[playbooks] Retrieved playbook (${playbook.synthesized_from_count} source episodes)`);
    }
    return playbook;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Failed to query local store: ${msg} — skipping playbook injection`);
    return null;
  } finally {
    store.close();
  }
}

/**
 * Persist a PlaybookRecord to the local sqlite-vec playbook store. Returns
 * true on success, false on any failure mode. Never throws.
 */
export async function recordPlaybook(
  config: PlaybooksConfig,
  playbook: PlaybookRecord,
  workDir?: string,
): Promise<boolean> {
  if (!config.enabled) return false;
  if (!workDir) {
    log.warn('[playbooks] Enabled but no workDir provided — playbook not saved');
    return false;
  }

  const store = openPlaybookStore(workDir);
  if (!store) return false;

  try {
    store.recordPlaybook(playbook);
    log.info(`[playbooks] Recorded playbook (${playbook.synthesized_from_count} source episodes)`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`[playbooks] Failed to record playbook: ${msg}`);
    return false;
  } finally {
    store.close();
  }
}
