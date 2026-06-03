// Daemon snapshot persistence — tests.
//
// Verifies the round-trip + atomic-write + missing-file + malformed-file
// behavior. The snapshot file is what lets the daemon resume work after a
// process restart (issue #291 acceptance criterion: "Snapshot persisted +
// reloaded on restart").

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DaemonSnapshot, loadSnapshot, saveSnapshot, snapshotPath } from './daemon-snapshot.js';

describe('daemon-snapshot', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kova-daemon-snap-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('snapshotPath', () => {
    it('points at ~/.kova/daemon-snapshot.json', () => {
      const p = snapshotPath('/home/u');
      expect(p).toBe('/home/u/.kova/daemon-snapshot.json');
    });
  });

  describe('loadSnapshot', () => {
    it('returns null when the file does not exist', async () => {
      const result = await loadSnapshot(homeDir);
      expect(result).toBeNull();
    });

    it('returns null for a malformed JSON file', async () => {
      const dir = join(homeDir, '.kova');
      await writeFile(join(dir, '..', 'placeholder'), '', { flag: 'a' }).catch(() => {});
      // Force-create the .kova dir then write garbage.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'daemon-snapshot.json'), 'not json{{{');
      const result = await loadSnapshot(homeDir);
      expect(result).toBeNull();
    });

    it('returns the parsed snapshot when the file is well-formed', async () => {
      const snap: DaemonSnapshot = {
        version: 1,
        savedAt: '2026-06-03T00:00:00Z',
        pending: [
          { issueNumber: 1, repoPath: '/p', repoName: 'r1' },
          { issueNumber: 2, repoPath: '/p', repoName: 'r2' },
        ],
        inFlight: [],
      };
      await saveSnapshot(homeDir, snap);
      const loaded = await loadSnapshot(homeDir);
      expect(loaded).toEqual(snap);
    });
  });

  describe('saveSnapshot', () => {
    it('creates the .kova directory if missing', async () => {
      const snap: DaemonSnapshot = {
        version: 1,
        savedAt: '2026-06-03T00:00:00Z',
        pending: [],
        inFlight: [],
      };
      await saveSnapshot(homeDir, snap);
      const content = await readFile(join(homeDir, '.kova', 'daemon-snapshot.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual(snap);
    });

    it('overwrites the previous snapshot', async () => {
      const a: DaemonSnapshot = {
        version: 1,
        savedAt: '2026-06-03T00:00:00Z',
        pending: [{ issueNumber: 1, repoPath: '/p', repoName: 'r' }],
        inFlight: [],
      };
      const b: DaemonSnapshot = {
        version: 1,
        savedAt: '2026-06-03T00:01:00Z',
        pending: [],
        inFlight: [{ issueNumber: 1, repoPath: '/p', repoName: 'r' }],
      };
      await saveSnapshot(homeDir, a);
      await saveSnapshot(homeDir, b);
      const loaded = await loadSnapshot(homeDir);
      expect(loaded).toEqual(b);
    });

    it('does not leave behind .tmp files after a successful write', async () => {
      const snap: DaemonSnapshot = {
        version: 1,
        savedAt: '2026-06-03T00:00:00Z',
        pending: [],
        inFlight: [],
      };
      await saveSnapshot(homeDir, snap);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(join(homeDir, '.kova'));
      const tmpFiles = entries.filter((e) => e.includes('.tmp'));
      expect(tmpFiles).toEqual([]);
    });
  });
});
