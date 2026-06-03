// Tree-sitter symbol+edge extraction.
//
// TypeScript-first (also handles JSX/TSX). The parser is initialized lazily and
// the loaded Language object is cached for the lifetime of the process — first
// extraction pays the WASM-load cost (~10ms), subsequent ones are fast.
//
// Edge model:
//  - `calls`     : caller-symbol -> callee-symbol (best-effort, same-file resolves first)
//  - `imports`   : caller-symbol -> `module:<specifier>` (preserves the literal specifier
//                  so the store can answer "who imports node:fs?" without re-parsing)
//  - `contains`  : class/interface -> method/field (lets findDefinitions traverse hierarchies)
//
// Out of scope (initial cut): cross-file symbol resolution for calls, type-only
// references, dynamic `require()` / `import()`. Those are addressable follow-ups.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node as TsNode } from 'web-tree-sitter';
import type { ExtractResult, SymbolEdge, SymbolKind, SymbolNode } from '../types/codegraph.js';

let parserPromise: Promise<{ parser: Parser; language: Language }> | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const localRequire = createRequire(import.meta.url);

/** Locate the bundled WASM grammar regardless of dist/src layout. */
function findGrammarPath(): string {
  // Walk up looking for node_modules — works both during `vitest` (src/) and after `npm run build` (dist/).
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, 'node_modules', 'tree-sitter-typescript', 'tree-sitter-typescript.wasm');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fall back to require.resolve, which works when running inside an installed package.
  return localRequire.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
}

async function getParser(): Promise<{ parser: Parser; language: Language }> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const grammarPath = findGrammarPath();
      const buf = await readFile(grammarPath);
      const language = await Language.load(new Uint8Array(buf));
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, language };
    })();
  }
  return parserPromise;
}

/** Reset cached parser/language. Test-only — production keeps the cache hot. */
export function _resetParserCacheForTesting(): void {
  parserPromise = null;
}

/**
 * Parse `source` and return its symbol nodes + outgoing edges.
 *
 * For empty/whitespace-only input the parser still runs but no symbols are
 * emitted — we short-circuit to keep the cost predictable.
 */
export async function extractSymbols(filePath: string, source: string): Promise<ExtractResult> {
  if (source.trim().length === 0) return { nodes: [], edges: [] };

  const { parser } = await getParser();
  const tree = parser.parse(source);
  if (!tree) return { nodes: [], edges: [] };

  const nodes: SymbolNode[] = [];
  const edges: SymbolEdge[] = [];
  // Map of name -> node ID, scoped to the current file. Lets us resolve same-file
  // call edges without a second pass.
  const localSymbols = new Map<string, string>();

  const makeId = (name: string, startLine: number) => `${filePath}::${name}@${startLine}`;

  const pushNode = (n: TsNode, name: string, kind: SymbolKind, isExported: boolean) => {
    // For exported declarations, treat the wrapping `export_statement` as the
    // signature anchor so the captured first line includes the `export` keyword.
    const anchor = isExported && n.parent?.type === 'export_statement' ? n.parent : n;
    const startLine = anchor.startPosition.row + 1;
    const endLine = anchor.endPosition.row + 1;
    const id = makeId(name, startLine);
    const signature = signatureFor(anchor, source);
    nodes.push({ id, kind, name, filePath, startLine, endLine, signature, isExported });
    // Only register the first occurrence under a given name — later shadows still
    // get distinct IDs but call edges resolve to the first declaration, matching
    // JS lexical-scope intuition for the simple case.
    if (!localSymbols.has(name)) localSymbols.set(name, id);
    return id;
  };

  /**
   * Walk the tree. Tracks the enclosing symbol so call_expression / new_expression
   * can attribute the edge to its caller.
   */
  const walk = (node: TsNode, enclosing: string | null) => {
    let nextEnclosing = enclosing;

    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const exported = isInExport(node);
          nextEnclosing = pushNode(node, nameNode.text, 'function', exported);
        }
        break;
      }
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const classId = pushNode(node, nameNode.text, 'class', isInExport(node));
          nextEnclosing = classId;
          // extends edge
          const heritage = firstChildOfType(node, 'class_heritage');
          if (heritage) {
            for (const id of identifiersIn(heritage)) {
              edges.push({ source: classId, target: `unresolved:${id}`, kind: 'extends' });
            }
          }
        }
        break;
      }
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          pushNode(node, nameNode.text, 'interface', isInExport(node));
        }
        break;
      }
      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          pushNode(node, nameNode.text, 'type', isInExport(node));
        }
        break;
      }
      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const methodId = pushNode(node, nameNode.text, 'method', false);
          if (enclosing) edges.push({ source: enclosing, target: methodId, kind: 'contains' });
          nextEnclosing = methodId;
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // const foo = () => {}, const Bar = class {} — treat as function/class
        // when the initializer is a function/arrow/class expression.
        const exported = isInExport(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const decl = node.namedChild(i);
          if (!decl || decl.type !== 'variable_declarator') continue;
          const nameNode = decl.childForFieldName('name');
          const valueNode = decl.childForFieldName('value');
          if (!nameNode || nameNode.type !== 'identifier') continue;
          const kind = inferDeclaratorKind(valueNode);
          if (kind) pushNode(decl, nameNode.text, kind, exported);
        }
        break;
      }
      case 'import_statement': {
        // The import lives at module-scope; attribute the edge to the file itself
        // via a synthetic source. The store + query layer treat any source that
        // starts with `file:` as "the file" rather than a symbol.
        const sourceNode = node.childForFieldName('source');
        if (sourceNode) {
          const moduleName = stripQuotes(sourceNode.text);
          edges.push({
            source: `file:${filePath}`,
            target: `module:${moduleName}`,
            kind: 'imports',
          });
        }
        break;
      }
      case 'call_expression': {
        if (enclosing) {
          const fn = node.childForFieldName('function');
          if (fn) {
            const callee =
              fn.type === 'identifier'
                ? fn.text
                : fn.type === 'member_expression'
                  ? fn.childForFieldName('property')?.text
                  : null;
            if (callee) {
              const target = localSymbols.get(callee) ?? `unresolved:${callee}`;
              edges.push({ source: enclosing, target, kind: 'calls' });
            }
          }
        }
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, nextEnclosing);
    }
  };

  // Two-pass: first pass collects top-level symbol IDs into `localSymbols` so call
  // edges in the same file can resolve forward references. We get this for free by
  // visiting declarations during the same walk and emitting `unresolved:` for
  // identifiers not yet registered; a second pass rewrites those.
  walk(tree.rootNode, null);

  // Resolve unresolved: targets that point at names declared later in the file.
  const resolvedEdges = edges.map<SymbolEdge>((e) => {
    if (!e.target.startsWith('unresolved:')) return e;
    const name = e.target.slice('unresolved:'.length);
    const resolved = localSymbols.get(name);
    return resolved ? { ...e, target: resolved } : e;
  });

  return { nodes, edges: dedupeEdges(resolvedEdges) };
}

function signatureFor(node: TsNode, source: string): string {
  // First line of the declaration is enough for "where is this defined" UX, and
  // stays small. We do NOT store the full body — that would bloat the DB.
  const start = node.startIndex;
  const newlineAt = source.indexOf('\n', start);
  const line = source.slice(start, newlineAt === -1 ? source.length : newlineAt).trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function isInExport(node: TsNode): boolean {
  // export function / export class wrap the declaration in an `export_statement`.
  const parent = node.parent;
  return parent?.type === 'export_statement';
}

function firstChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === type) return c;
  }
  return null;
}

function identifiersIn(node: TsNode): string[] {
  const out: string[] = [];
  const visit = (n: TsNode) => {
    if (n.type === 'identifier' || n.type === 'type_identifier') out.push(n.text);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(node);
  return out;
}

function inferDeclaratorKind(valueNode: TsNode | null): SymbolKind | null {
  if (!valueNode) return null;
  switch (valueNode.type) {
    case 'arrow_function':
    case 'function_expression':
      return 'function';
    case 'class':
      return 'class';
    default:
      return null;
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'") || s.startsWith('`'))) {
    return s.slice(1, -1);
  }
  return s;
}

function dedupeEdges(edges: SymbolEdge[]): SymbolEdge[] {
  const seen = new Set<string>();
  const out: SymbolEdge[] = [];
  for (const e of edges) {
    const k = `${e.source} ${e.target} ${e.kind}` as const satisfies string;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
