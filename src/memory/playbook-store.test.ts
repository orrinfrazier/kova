// Tests for PlaybookStore — sqlite-vec-backed record + query of distilled playbooks.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybookRecord } from '../types/memory.js';
import { PlaybookStore } from './playbook-store.js';

function makePlaybook(overrides: Partial<PlaybookRecord> = {}): PlaybookRecord {
  return {
    trigger: {
      labels: ['bug', 'database'],
      language: 'typescript',
      file_globs: ['src/db.ts'],
    },
    steps: ['Open a connection', 'Run the query', 'Close it'],
    gotchas: ['Pool exhaustion'],
    files_to_touch: ['src/db.ts'],
    episode_refs: [1, 2, 3],
    synthesized_from_count: 3,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('PlaybookStore', () => {
  let tmp: string;
  let store: PlaybookStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-playbook-store-'));
    store = new PlaybookStore(join(tmp, 'playbooks-vec.db'));
  });

  afterEach(() => {
    store.close();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('records and queries a playbook', () => {
    store.recordPlaybook(makePlaybook({ steps: ['database fix step one', 'connection pool tuning'] }));
    const result = store.queryPlaybook('database connection pool');
    expect(result).not.toBeNull();
    expect(result?.steps.length).toBeGreaterThan(0);
  });

  it('returns null when no playbook exists', () => {
    expect(store.queryPlaybook('nothing')).toBeNull();
  });

  it('returns null on empty query', () => {
    store.recordPlaybook(makePlaybook());
    expect(store.queryPlaybook('')).toBeNull();
  });

  it('preserves all fields on roundtrip', () => {
    const original = makePlaybook({
      trigger: {
        labels: ['bug'],
        language: 'rust',
        file_globs: ['src/main.rs'],
      },
      steps: ['unique step about rust async runtime tokio'],
      gotchas: ['watch the await'],
      files_to_touch: ['src/main.rs'],
      episode_refs: [42, 43],
      synthesized_from_count: 2,
    });
    store.recordPlaybook(original);
    const got = store.queryPlaybook('rust async runtime tokio');
    expect(got).not.toBeNull();
    expect(got?.trigger.language).toBe('rust');
    expect(got?.episode_refs).toEqual([42, 43]);
    expect(got?.synthesized_from_count).toBe(2);
  });

  it('returns null after close', () => {
    store.recordPlaybook(makePlaybook());
    store.close();
    expect(store.queryPlaybook('anything')).toBeNull();
  });
});
