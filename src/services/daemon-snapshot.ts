// Daemon snapshot persistence (issue #291).
//
// The daemon owns an in-memory queue; if the process restarts (crash, host
// reboot, deploy) the queue would vanish without an on-disk record. The
// snapshot is a tiny JSON file written after every queue mutation:
//
//   ~/.kova/daemon-snapshot.json
//
// Atomic write-then-rename mirrors `run-registry.ts` so a concurrent reader
// (e.g. a status probe) never observes a torn write.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixRequest } from './fix-queue.js';

export interface DaemonSnapshot {
  /** Snapshot schema version — bumped on breaking format changes. */
  version: 1;
  /** ISO timestamp the snapshot was written. */
  savedAt: string;
  /** Requests waiting for a worker. */
  pending: FixRequest[];
  /** Requests currently being processed when the snapshot was taken. */
  inFlight: FixRequest[];
}

/** Absolute path of the snapshot file for a given home directory. */
export function snapshotPath(homeDir: string): string {
  return join(homeDir, '.kova', 'daemon-snapshot.json');
}

function snapshotDir(homeDir: string): string {
  return join(homeDir, '.kova');
}

/** Load the snapshot from disk. Returns null when missing or malformed. */
export async function loadSnapshot(homeDir: string): Promise<DaemonSnapshot | null> {
  try {
    const content = await readFile(snapshotPath(homeDir), 'utf-8');
    const parsed = JSON.parse(content) as DaemonSnapshot;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the snapshot to disk atomically. Creates the .kova dir if missing. */
export async function saveSnapshot(homeDir: string, snap: DaemonSnapshot): Promise<void> {
  await mkdir(snapshotDir(homeDir), { recursive: true });
  // Tmp suffix is crypto-random so two concurrent writers cannot stomp each
  // other on the same path (defensive — single daemon process should be the
  // only writer in practice).
  const suffix = randomBytes(6).toString('hex');
  const finalPath = snapshotPath(homeDir);
  const tmp = `${finalPath}.${suffix}.tmp`;
  await writeFile(tmp, JSON.stringify(snap, null, 2));
  await rename(tmp, finalPath);
}
