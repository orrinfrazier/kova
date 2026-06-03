// Consensus disagreement JSONL log (#262).
//
// Whenever the adjudicator in `spawnConsensusWave` overrides the
// consensus/majority of the worker pool, the rejection is appended to
// `.kova/consensus_disagreements.jsonl` as one record per line. The log is the
// signal `/reflect` (and any future "which model disagrees most" analysis)
// consumes — it's an append-only audit trail of pool/adjudicator splits.
//
// Design notes:
//   - JSONL (one record per line) so concurrent appends and partial-file
//     truncation don't corrupt earlier records.
//   - Records carry hashes of pool + adjudicator artifacts rather than the
//     artifacts themselves; the log is for trend analysis, not artifact
//     archival (artifacts live in the per-fix worktree handoffs).
//   - Reader skips malformed lines (parallel to history.jsonl) so a single
//     bad line never blocks downstream tooling.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from '../utils/logger.js';

/**
 * One record per adjudicator-rejection event. Persisted as a single JSON line.
 *
 * Fields:
 *  - `timestamp` — ISO-8601 UTC.
 *  - `wave` — kova wave name (assess|spec|test|impl|quality|review|…).
 *  - `agreement` — pool-artifact agreement class at adjudication time.
 *  - `adjudicator_model` — the round-trip `provider:id` of the adjudicator.
 *  - `pool_size` — pool member count (≥2 by `spawnConsensusWave` invariant).
 *  - `rejected_count` — pool members whose surviving artifact differed
 *    from the adjudicator's reconciled artifact.
 *  - `degraded` — true when any pool member was dropped after retries.
 *  - `rejected_models` — model ids of the rejected pool members (excludes
 *    dropped members, which had no surviving artifact to reject).
 *  - `adjudicator_artifact_hash` — content hash of the adjudicator's artifact.
 *  - `pool_artifact_hashes` — per-pool-member content hash, in pool order.
 *    `null` for dropped members.
 */
export const ConsensusDisagreementRecordSchema = z.object({
  timestamp: z.string().datetime(),
  wave: z.string().min(1),
  agreement: z.enum(['unanimous', 'majority', 'split']),
  adjudicator_model: z.string().min(1),
  pool_size: z.number().int().min(2),
  rejected_count: z.number().int().min(0),
  degraded: z.boolean(),
  rejected_models: z.array(z.string().min(1)),
  adjudicator_artifact_hash: z.string().min(1),
  pool_artifact_hashes: z.array(z.string().min(1).nullable()),
});

export type ConsensusDisagreementRecord = z.infer<typeof ConsensusDisagreementRecordSchema>;

/** Absolute path to the JSONL log inside `<repoPath>/.kova/`. */
export function consensusDisagreementsPath(repoPath: string): string {
  return join(repoPath, '.kova', 'consensus_disagreements.jsonl');
}

/**
 * Append one disagreement record to the JSONL log. Creates `.kova/` if
 * missing. The record is Zod-validated before write — bad records throw
 * rather than silently corrupting the log.
 */
export async function appendConsensusDisagreement(
  repoPath: string,
  record: ConsensusDisagreementRecord,
): Promise<void> {
  // Validate first — fail loudly on malformed records (the alternative is
  // a corrupted JSONL line that the reader silently skips, which would
  // hide bugs in the writer).
  const parsed = ConsensusDisagreementRecordSchema.parse(record);
  await mkdir(join(repoPath, '.kova'), { recursive: true });
  await appendFile(consensusDisagreementsPath(repoPath), `${JSON.stringify(parsed)}\n`);
}

/**
 * Read all valid disagreement records from the log. Returns `[]` when the
 * file does not exist. Malformed lines are skipped with a debug log entry
 * (mirrors `readHistory` in services/history.ts).
 */
export async function readConsensusDisagreements(repoPath: string): Promise<ConsensusDisagreementRecord[]> {
  const filePath = consensusDisagreementsPath(repoPath);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const records: ConsensusDisagreementRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const result = ConsensusDisagreementRecordSchema.safeParse(parsed);
      if (result.success) {
        records.push(result.data);
      } else {
        log.debug(`Skipping malformed consensus-disagreement line: ${line.slice(0, 80)}`);
      }
    } catch {
      log.debug(`Skipping unparseable consensus-disagreement line: ${line.slice(0, 80)}`);
    }
  }
  return records;
}
