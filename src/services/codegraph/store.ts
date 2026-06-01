// CodegraphStore — SQLite-backed symbol+edge index.
//
// Schema mirrors the codegraph reference design (nodes + edges with composite
// indexes). The DB lives at `.kova/codegraph.db` in the repo root by default;
// callers pass an explicit path for tests and alt locations.
//
// Incrementality: every file's content hash is stored in `files(path, hash)`.
// upsertFile is a no-op when the hash is unchanged. When the hash differs (or
// no row exists), the file's existing nodes and outgoing edges are deleted
// before the new set is inserted — guarantees no stale rows after re-index.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as DbHandle } from 'better-sqlite3';
import type { SymbolEdge, SymbolNode, UpsertResult } from '../../types/codegraph.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  signature   TEXT NOT NULL,
  is_exported INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);

CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind   TEXT NOT NULL,
  PRIMARY KEY (source, target, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, kind);
`;

export class CodegraphStore {
  private readonly db: DbHandle;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /** Return the previously stored content hash for `filePath`, or null. */
  getStoredHash(filePath: string): string | null {
    const row = this.db.prepare<[string], { hash: string }>('SELECT hash FROM files WHERE path = ?').get(filePath);
    return row?.hash ?? null;
  }

  /**
   * Insert or update a file's nodes and outgoing edges.
   *
   * - If the file's stored hash matches `contentHash`, returns `{changed:false}`
   *   and does nothing.
   * - Otherwise replaces all nodes whose `file_path` equals `filePath` and all
   *   edges whose `source` is one of the file's previous node IDs, then writes
   *   the new nodes and edges atomically.
   */
  upsertFile(filePath: string, contentHash: string, nodes: SymbolNode[], edges: SymbolEdge[]): UpsertResult {
    const existing = this.db.prepare<[string], { hash: string }>('SELECT hash FROM files WHERE path = ?').get(filePath);
    if (existing && existing.hash === contentHash) {
      return { changed: false, nodesWritten: 0, edgesWritten: 0 };
    }

    const tx = this.db.transaction((nodes_: SymbolNode[], edges_: SymbolEdge[]) => {
      // Drop edges originating from any prior node in this file, then drop the nodes themselves.
      this.db.prepare('DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)').run(filePath);
      this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(filePath);

      const insertNode = this.db.prepare(
        'INSERT OR REPLACE INTO nodes (id, kind, name, file_path, start_line, end_line, signature, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const n of nodes_) {
        insertNode.run(n.id, n.kind, n.name, n.filePath, n.startLine, n.endLine, n.signature, n.isExported ? 1 : 0);
      }

      const insertEdge = this.db.prepare('INSERT OR IGNORE INTO edges (source, target, kind) VALUES (?, ?, ?)');
      for (const e of edges_) {
        insertEdge.run(e.source, e.target, e.kind);
      }

      this.db
        .prepare('INSERT INTO files (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash')
        .run(filePath, contentHash);
    });

    tx(nodes, edges);
    return { changed: true, nodesWritten: nodes.length, edgesWritten: edges.length };
  }

  /** Remove a file and all nodes/edges originating from it. */
  removeFile(filePath: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)').run(filePath);
      this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(filePath);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    });
    tx();
  }

  /** Lookup symbols by exact name. */
  findSymbol(name: string): SymbolNode[] {
    return this.db
      .prepare<[string], NodeRow>('SELECT * FROM nodes WHERE name = ? ORDER BY file_path, start_line')
      .all(name)
      .map(rowToNode);
  }

  /** Symbols whose outgoing `calls` edges point at the given node. */
  getCallers(nodeId: string): SymbolNode[] {
    return this.db
      .prepare<[string, string], NodeRow>(
        'SELECT n.* FROM edges e JOIN nodes n ON n.id = e.source WHERE e.target = ? AND e.kind = ?',
      )
      .all(nodeId, 'calls')
      .map(rowToNode);
  }

  /** Symbols that the given node's outgoing `calls` edges point at. */
  getCallees(nodeId: string): SymbolNode[] {
    return this.db
      .prepare<[string, string], NodeRow>(
        'SELECT n.* FROM edges e JOIN nodes n ON n.id = e.target WHERE e.source = ? AND e.kind = ?',
      )
      .all(nodeId, 'calls')
      .map(rowToNode);
  }

  /**
   * Files that import (directly) from the given file path. Walks the `imports`
   * edge kind across all node sources in the file.
   */
  getFileDependents(filePath: string): string[] {
    return this.db
      .prepare<[string, string], { file_path: string }>(
        `SELECT DISTINCT n.file_path
         FROM edges e
         JOIN nodes n ON n.id = e.source
         WHERE e.kind = ? AND e.target = ?`,
      )
      .all('imports', `module:${filePath}`)
      .map((r) => r.file_path);
  }

  /**
   * Transitive set of node IDs reachable via reverse `calls` edges from any
   * symbol in the given file, bounded by `maxDepth` BFS hops. Useful for
   * answering "if I change file X, what else might be affected?".
   */
  getImpactRadius(filePath: string, maxDepth = 3): string[] {
    const seeds = this.db
      .prepare<[string], { id: string }>('SELECT id FROM nodes WHERE file_path = ?')
      .all(filePath)
      .map((r) => r.id);
    if (seeds.length === 0) return [];

    const seen = new Set<string>(seeds);
    let frontier = seeds;
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const placeholders = frontier.map(() => '?').join(',');
      const next = this.db
        .prepare<string[], { id: string }>(
          `SELECT DISTINCT n.id FROM edges e JOIN nodes n ON n.id = e.source WHERE e.kind = 'calls' AND e.target IN (${placeholders})`,
        )
        .all(...frontier)
        .map((r) => r.id)
        .filter((id) => !seen.has(id));
      for (const id of next) seen.add(id);
      frontier = next;
    }
    // Exclude the seeds themselves — caller usually wants "things touched by this file's symbols".
    for (const s of seeds) seen.delete(s);
    return [...seen];
  }
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  is_exported: number;
}

function rowToNode(r: NodeRow): SymbolNode {
  return {
    id: r.id,
    kind: r.kind as SymbolNode['kind'],
    name: r.name,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    signature: r.signature,
    isExported: r.is_exported === 1,
  };
}
