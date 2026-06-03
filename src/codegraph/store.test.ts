import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SymbolEdge, SymbolNode } from '../types/codegraph.js';
import { CodegraphStore } from './store.js';

describe('CodegraphStore', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-codegraph-store-'));
    dbPath = join(tmp, 'codegraph.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const node = (overrides: Partial<SymbolNode> = {}): SymbolNode => ({
    id: 'src/a.ts::foo@1',
    kind: 'function',
    name: 'foo',
    filePath: 'src/a.ts',
    startLine: 1,
    endLine: 3,
    signature: 'function foo()',
    isExported: true,
    ...overrides,
  });

  it('creates schema on first open', () => {
    const store = new CodegraphStore(dbPath);
    store.close();
    // Re-opening should not error and should preserve schema.
    const store2 = new CodegraphStore(dbPath);
    expect(store2.findSymbol('foo')).toEqual([]);
    store2.close();
  });

  it('upsertFile inserts nodes when content hash changes', () => {
    const store = new CodegraphStore(dbPath);
    const result = store.upsertFile('src/a.ts', 'hash-v1', [node()], []);
    expect(result.changed).toBe(true);
    expect(result.nodesWritten).toBe(1);
    expect(store.findSymbol('foo')).toHaveLength(1);
    store.close();
  });

  it('upsertFile is a no-op when content hash is unchanged', () => {
    const store = new CodegraphStore(dbPath);
    store.upsertFile('src/a.ts', 'hash-v1', [node()], []);
    const result = store.upsertFile('src/a.ts', 'hash-v1', [node()], []);
    expect(result.changed).toBe(false);
    expect(result.nodesWritten).toBe(0);
    store.close();
  });

  it('upsertFile removes stale nodes when a file is re-indexed', () => {
    const store = new CodegraphStore(dbPath);
    store.upsertFile(
      'src/a.ts',
      'hash-v1',
      [
        node({ id: 'src/a.ts::foo@1', name: 'foo' }),
        node({ id: 'src/a.ts::bar@5', name: 'bar', startLine: 5, endLine: 7 }),
      ],
      [],
    );
    // Re-index with foo gone and a new symbol baz
    store.upsertFile(
      'src/a.ts',
      'hash-v2',
      [node({ id: 'src/a.ts::baz@5', name: 'baz', startLine: 5, endLine: 6 })],
      [],
    );
    expect(store.findSymbol('foo')).toEqual([]);
    expect(store.findSymbol('bar')).toEqual([]);
    expect(store.findSymbol('baz')).toHaveLength(1);
    store.close();
  });

  it('findSymbol returns file + exact line range', () => {
    const store = new CodegraphStore(dbPath);
    store.upsertFile('src/a.ts', 'h', [node({ name: 'foo', startLine: 10, endLine: 14 })], []);
    const hits = store.findSymbol('foo');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ filePath: 'src/a.ts', startLine: 10, endLine: 14, name: 'foo' });
  });

  it('getCallers / getCallees return correct-direction neighbors', () => {
    const store = new CodegraphStore(dbPath);
    const fooId = 'src/a.ts::foo@1';
    const barId = 'src/a.ts::bar@5';
    store.upsertFile(
      'src/a.ts',
      'h',
      [
        node({ id: fooId, name: 'foo', startLine: 1, endLine: 3 }),
        node({ id: barId, name: 'bar', startLine: 5, endLine: 8 }),
      ],
      [{ source: barId, target: fooId, kind: 'calls' } satisfies SymbolEdge],
    );
    const callersOfFoo = store.getCallers(fooId);
    expect(callersOfFoo.map((n) => n.id)).toEqual([barId]);
    const calleesOfBar = store.getCallees(barId);
    expect(calleesOfBar.map((n) => n.id)).toEqual([fooId]);
    expect(store.getCallers(barId)).toEqual([]);
    store.close();
  });

  it('upserting edges across files resolves cross-file callers', () => {
    const store = new CodegraphStore(dbPath);
    const fooId = 'src/a.ts::foo@1';
    const useFooId = 'src/b.ts::useFoo@1';
    store.upsertFile('src/a.ts', 'h-a', [node({ id: fooId, name: 'foo' })], []);
    store.upsertFile(
      'src/b.ts',
      'h-b',
      [node({ id: useFooId, name: 'useFoo', filePath: 'src/b.ts' })],
      [{ source: useFooId, target: fooId, kind: 'calls' }],
    );
    expect(store.getCallers(fooId).map((n) => n.id)).toEqual([useFooId]);
  });

  it('removing a file removes its edges (no dangling references)', () => {
    const store = new CodegraphStore(dbPath);
    const fooId = 'src/a.ts::foo@1';
    const useFooId = 'src/b.ts::useFoo@1';
    store.upsertFile('src/a.ts', 'h', [node({ id: fooId, name: 'foo' })], []);
    store.upsertFile(
      'src/b.ts',
      'h',
      [node({ id: useFooId, name: 'useFoo', filePath: 'src/b.ts' })],
      [{ source: useFooId, target: fooId, kind: 'calls' }],
    );
    store.removeFile('src/b.ts');
    expect(store.findSymbol('useFoo')).toEqual([]);
    expect(store.getCallers(fooId)).toEqual([]);
  });

  it('upsertFile is idempotent under concurrent re-call with same hash', () => {
    const store = new CodegraphStore(dbPath);
    store.upsertFile('src/a.ts', 'h', [node()], []);
    store.upsertFile('src/a.ts', 'h', [node()], []);
    store.upsertFile('src/a.ts', 'h', [node()], []);
    expect(store.findSymbol('foo')).toHaveLength(1);
  });
});
