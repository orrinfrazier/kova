// Public barrel for the codegraph service.
//
// External callers should import from `services/codegraph` (this file) rather
// than the individual modules — that keeps the surface area documented in one
// place and decouples consumers from the store/extract/query split.

export type {
  EdgeKind,
  ExtractResult,
  SymbolEdge,
  SymbolKind,
  SymbolNode,
  UpsertResult,
} from '../types/codegraph.js';
export { extractSymbols } from './extract.js';
export type { CodegraphHandle } from './query.js';
export { indexSource, openCodegraph } from './query.js';
export { CodegraphStore } from './store.js';
