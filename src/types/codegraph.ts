// Codegraph types — symbol nodes and edges extracted by tree-sitter.
//
// Schema mirrors the codegraph reference design (nodes + edges in SQLite).
// Kinds and edge types are intentionally narrow for the initial TS/JS scope;
// new languages widen the union as they are added.

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'implements' | 'contains' | 'references';

/**
 * A symbol declaration extracted from source code.
 *
 * `id` is a stable identifier shaped as `${filePath}::${name}@${startLine}` so
 * multiple symbols with the same name in the same file (e.g. shadowed locals,
 * overloads) remain distinct without requiring a database round-trip to
 * generate IDs.
 */
export interface SymbolNode {
  id: string;
  kind: SymbolKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
}

/**
 * A directed edge between two symbols (or, for `imports`, between a file and a
 * module path).
 *
 * `source` and `target` are symbol IDs in the form used by SymbolNode. For
 * `imports` edges where the target is an external module (not a symbol we've
 * indexed), `target` is the literal module specifier prefixed with `module:` —
 * e.g. `module:node:fs/promises`.
 */
export interface SymbolEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

/**
 * Output of the extract phase for a single file: the nodes declared in it and
 * the edges originating from it.
 */
export interface ExtractResult {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

/** Result of {@link upsertFile}. */
export interface UpsertResult {
  /** Did the file's content hash change since last index? */
  changed: boolean;
  nodesWritten: number;
  edgesWritten: number;
}
