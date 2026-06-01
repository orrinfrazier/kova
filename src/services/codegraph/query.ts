// High-level codegraph API.
//
// The library entry point most callers want is `openCodegraph(path)` followed
// by `indexSource(cg, filePath, source)`. The returned handle re-exposes the
// store's read API (findSymbol, getCallers, getCallees, getImpactRadius)
// alongside the lower-level upsertFile / removeFile escape hatches.

import { createHash } from 'node:crypto';
import type { ExtractResult, UpsertResult } from '../../types/codegraph.js';
import { extractSymbols } from './extract.js';
import { CodegraphStore } from './store.js';

export interface CodegraphHandle {
  readonly path: string;
  findSymbol: CodegraphStore['findSymbol'];
  getCallers: CodegraphStore['getCallers'];
  getCallees: CodegraphStore['getCallees'];
  getFileDependents: CodegraphStore['getFileDependents'];
  getImpactRadius: CodegraphStore['getImpactRadius'];
  upsertFile: CodegraphStore['upsertFile'];
  removeFile: CodegraphStore['removeFile'];
  getStoredHash: CodegraphStore['getStoredHash'];
  close: () => void;
}

/** Open (or create) a codegraph database. */
export function openCodegraph(dbPath: string): CodegraphHandle {
  const store = new CodegraphStore(dbPath);
  return {
    path: dbPath,
    findSymbol: store.findSymbol.bind(store),
    getCallers: store.getCallers.bind(store),
    getCallees: store.getCallees.bind(store),
    getFileDependents: store.getFileDependents.bind(store),
    getImpactRadius: store.getImpactRadius.bind(store),
    upsertFile: store.upsertFile.bind(store),
    removeFile: store.removeFile.bind(store),
    getStoredHash: store.getStoredHash.bind(store),
    close: () => store.close(),
  };
}

/**
 * Extract symbols+edges from `source` and write them to the codegraph.
 * Skips re-extraction when the content hash matches the previously indexed copy.
 */
export async function indexSource(
  cg: CodegraphHandle,
  filePath: string,
  source: string,
): Promise<UpsertResult & { extract: ExtractResult | null }> {
  const hash = sha256(source);
  // Fast-path: skip parsing entirely when the file's hash hasn't changed.
  const stored = cg.getStoredHash(filePath);
  if (stored === hash) {
    return { changed: false, nodesWritten: 0, edgesWritten: 0, extract: null };
  }
  const extract = await extractSymbols(filePath, source);
  const result = cg.upsertFile(filePath, hash, extract.nodes, extract.edges);
  return { ...result, extract };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
