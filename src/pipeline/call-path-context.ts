// Issue #275 — framework-resolved call-paths/routes context for spec + impl grounding.
//
// Why this module exists
// ----------------------
// kova grounds spec/impl on semantic similarity (vector chunks) plus codegraph
// symbol-level facts (#273). Neither layer sees that a symbol is the HANDLER
// bound to an HTTP route — `app.get('/users', listUsers)` is just a function
// call from the graph's perspective. On framework code (Express, Fastify,
// router-style libs) that means agents guess the real handler from fuzzy
// matches instead of getting "the answer".
//
// This file adds the missing layer:
//
//   1. `extractRouteBindings(src)` — pure regex over source text. Recognises
//      `app.get/post/put/delete/patch/all('/path', handlerName)` and the
//      `router.*` variant. Skips inline-arrow / inline-function handlers
//      (nothing to resolve in the graph) and `app.use(...)` (middleware mount,
//      not a handler binding).
//   2. `formatCallPathContext({ graph, routeBindings })` — looks each handler
//      symbol up in the codegraph, renders a `## Framework call paths` section
//      with definition span + 1-hop callers + 1-hop callees. Returns `''`
//      when nothing resolves so the caller's `sections.join('\n\n')` filters
//      it out cleanly.
//   3. `resolveCallPaths({ graph, files, readSource })` — convenience wrapper
//      that reads source from a list of files, extracts bindings across all
//      of them, and formats once. Used by `src/pipeline/fix.ts` against
//      `assessArtifact.surface_area.files`.
//
// Design contract
// ---------------
//   * PURE. No filesystem touch, no SQL, no fetch. Tests pass a tiny
//     in-memory `CodegraphLookup` + a `Map<string, string>` reader.
//   * EMPTY ON NO-MATCH. Every helper returns `''` (or `[]`) when nothing
//     resolves — graceful degradation matches the `codegraphContext` (#273)
//     contract. The spec/impl waves continue with just the codegraph + vector
//     channels, behaving exactly as today (AC: "Graph/integration unavailable
//     -> field omitted, waves behave as today").
//   * TOKEN-BUDGETED VIA CALLER. The output is shaped to compose with the
//     existing `truncateToTokenBudget` in `context.ts`. Per-handler bullet
//     lists are capped (default 5 callers / 5 callees) so a fan-out hub does
//     not dominate the section.
//
// Ordering in the prompt
// ----------------------
// `buildSpecContext` / `buildImplContext` render in this order:
//   codegraphContext (#273)  — symbol-level (most precise)
//   callPathContext (#275)   — framework-resolved (this module)
//   codebaseContext          — fuzzy vector neighbors
// Keeps the "most precise first" gradient: a named symbol beats a route
// binding which beats a vector neighbor.

import type { CodegraphLookup } from '../ai/codegraph.js';
import type { SymbolNode } from '../types/codegraph.js';

/**
 * One HTTP route binding extracted from source: e.g. `app.get('/users', listUsers)`
 * produces `{ method: 'GET', path: '/users', handlerName: 'listUsers' }`.
 *
 * `method` is normalised to uppercase. `path` keeps the original string
 * (including `:param` segments). `handlerName` is the symbol name we'll look
 * up in the codegraph — inline arrow/function handlers are filtered out
 * upstream because there's no symbol to resolve.
 */
export interface RouteBinding {
  method: string;
  path: string;
  handlerName: string;
}

/** Methods we recognise as handler bindings. `use` is intentionally absent:
 *  middleware mounts are not what this module is about. `all` IS included
 *  because it binds to a real handler symbol — distinct from `use`. */
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'] as const;

/**
 * Regex matching `<obj>.<method>('<path>', <handler>)`.
 *
 * Capture groups:
 *   1: HTTP method (lowercase)
 *   2: path string (matched without surrounding quotes — quotes are part of
 *      the wider alternation so we accept both `'..'` and `".."`)
 *   3: handler arg (raw — we then test it for "identifier-shape" vs inline)
 *
 * The handler arg is captured greedily up to the closing `)` because handlers
 * may include trailing whitespace / comments. We then trim and test it.
 *
 * `s` flag is required so `.` matches newlines (multi-line bindings are common
 * and showed up in real-world Express code).
 */
const ROUTE_BINDING_REGEX = new RegExp(
  // Object prefix — `app`, `router`, `srv`, anything identifier-shaped
  String.raw`\b[A-Za-z_$][\w$]*\.` +
    // HTTP method — lowercase only on purpose; mixed-case in production code is rare
    // and a false match against `.getXxx()` (e.g. `.getUser()`) would be worse than missing one
    String.raw`(${HTTP_METHODS.join('|')})\s*\(\s*` +
    // Path string — single or double quoted
    String.raw`(?:'([^']*)'|"([^"]*)")\s*,\s*` +
    // Handler arg — captured up to the next `,` or `)` at the SAME paren depth.
    // We accept anything here and post-validate. The `\s*[\),]` lookahead
    // bounds the match; the post-trim identifier test does the real filtering.
    String.raw`([^,\)]+?)\s*[,\)]`,
  'gs',
);

/** True when `arg` is a bare identifier (the symbol name we can resolve in
 *  the graph). Drops `(req, res) => …` arrows and `function …` inlines. */
function isResolvableHandler(arg: string): boolean {
  const trimmed = arg.trim();
  // Bare identifier — `listUsers`, `controllers.list`, `users.list` — but for
  // v1 we only resolve unqualified names. Qualified names (`controllers.list`)
  // would need namespace-aware symbol lookup which the current CodegraphLookup
  // doesn't expose; skip them rather than mis-resolve.
  return /^[A-Za-z_$][\w$]*$/.test(trimmed);
}

/**
 * Extract route bindings from a chunk of source text.
 *
 * PURE — no IO. Caller is responsible for reading file contents.
 *
 * The result is deduplicated by `(method, path, handlerName)`. Order is
 * preserved (first occurrence wins).
 */
export function extractRouteBindings(text: string): RouteBinding[] {
  if (text.length === 0) return [];
  const out: RouteBinding[] = [];
  const seen = new Set<string>();
  // Reset state — RegExp is module-level + sticky-ish via `g` flag.
  ROUTE_BINDING_REGEX.lastIndex = 0;
  let match = ROUTE_BINDING_REGEX.exec(text);
  while (match !== null) {
    const method = (match[1] ?? '').toUpperCase();
    const path = match[2] ?? match[3] ?? '';
    const handlerArg = match[4] ?? '';
    if (method.length > 0 && path.length > 0 && isResolvableHandler(handlerArg)) {
      const handlerName = handlerArg.trim();
      const key = `${method}|${path}|${handlerName}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ method, path, handlerName });
      }
    }
    match = ROUTE_BINDING_REGEX.exec(text);
  }
  return out;
}

/** Options for {@link formatCallPathContext}. */
export interface FormatCallPathContextOptions {
  graph: CodegraphLookup;
  routeBindings: RouteBinding[];
  /** Max 1-hop callers rendered per resolved handler (default 5). */
  maxCallersPerHandler?: number;
  /** Max 1-hop callees rendered per resolved handler (default 5). */
  maxCalleesPerHandler?: number;
}

/**
 * Format the `## Framework call paths` markdown section for prompt injection.
 *
 * For each route binding whose handler symbol resolves in `graph`, renders:
 *
 *   ### {METHOD} {path} → {handlerName}
 *   `{filePath}:L{startLine}-L{endLine}` — {signature}
 *   **Callers:** ref1, ref2, …
 *   **Callees:** ref1, ref2, …
 *
 * Returns `''` when `routeBindings` is empty OR no handler resolves — the
 * empty string is filtered out by `sections.join('\n\n')` in the calling
 * context builder.
 *
 * Dedupes by `${method}|${path}|${handlerName}` so the same `(GET, /x, h)`
 * tuple appearing in multiple files renders once.
 */
export function formatCallPathContext(opts: FormatCallPathContextOptions): string {
  const { graph, routeBindings, maxCallersPerHandler = 5, maxCalleesPerHandler = 5 } = opts;
  if (routeBindings.length === 0) return '';

  const renderedKeys = new Set<string>();
  const sections: string[] = [];

  for (const binding of routeBindings) {
    const key = `${binding.method}|${binding.path}|${binding.handlerName}`;
    if (renderedKeys.has(key)) continue;
    const matches = graph.findSymbol(binding.handlerName);
    if (matches.length === 0) continue;
    // Pick the first match — codegraph's findSymbol already returns ordered
    // results; multi-match disambiguation would need the file path from
    // the binding's source file, which we don't track here. v1 keeps it simple.
    const handler = matches[0];
    if (handler === undefined) continue;
    renderedKeys.add(key);
    sections.push(renderHandlerSection(binding, handler, graph, maxCallersPerHandler, maxCalleesPerHandler));
  }

  if (sections.length === 0) return '';
  return ['## Framework call paths', '', sections.join('\n\n')].join('\n');
}

function renderHandlerSection(
  binding: RouteBinding,
  handler: SymbolNode,
  graph: CodegraphLookup,
  maxCallers: number,
  maxCallees: number,
): string {
  const lines: string[] = [];
  lines.push(`### ${binding.method} ${binding.path} → ${binding.handlerName}`);
  lines.push(`\`${handler.filePath}:L${handler.startLine}-L${handler.endLine}\` — ${handler.signature}`);

  const callers = graph.getCallers(handler.id).slice(0, maxCallers);
  const callees = graph.getCallees(handler.id).slice(0, maxCallees);
  if (callers.length > 0) {
    lines.push(`**Callers:** ${callers.map(renderRef).join(', ')}`);
  }
  if (callees.length > 0) {
    lines.push(`**Callees:** ${callees.map(renderRef).join(', ')}`);
  }

  return lines.join('\n');
}

/** "name (file:Lstart)" — compact link-y inline reference. Mirrors the
 *  format used in `formatCodegraphContext` so the two sections look uniform. */
function renderRef(n: SymbolNode): string {
  return `${n.name} (${n.filePath}:L${n.startLine})`;
}

/** Options for {@link resolveCallPaths}. */
export interface ResolveCallPathsOptions {
  graph: CodegraphLookup;
  /** Files to scan for route bindings — typically `assessArtifact.surface_area.files`. */
  files: string[];
  /** File reader — injected so tests can pass an in-memory map. */
  readSource: (path: string) => string;
  /** Max 1-hop callers per resolved handler (forwarded). */
  maxCallersPerHandler?: number;
  /** Max 1-hop callees per resolved handler (forwarded). */
  maxCalleesPerHandler?: number;
}

/**
 * End-to-end resolver used by the fix pipeline: read each file, extract route
 * bindings, format against the graph.
 *
 * Catches per-file read errors and continues — a stale entry in
 * `surface_area.files` should not blank the whole context. Returns `''` if
 * no file yields any binding OR no binding resolves in the graph (graceful
 * degrade, matches the AC).
 */
export function resolveCallPaths(opts: ResolveCallPathsOptions): string {
  const { graph, files, readSource, maxCallersPerHandler, maxCalleesPerHandler } = opts;
  if (files.length === 0) return '';

  const allBindings: RouteBinding[] = [];
  for (const path of files) {
    let src = '';
    try {
      src = readSource(path);
    } catch {
      // Stale path / read-perm issue / non-existent file — skip and continue.
      // Aligns with the codegraph degradation contract: never throw, just
      // produce less context.
      continue;
    }
    if (src.length === 0) continue;
    const bindings = extractRouteBindings(src);
    for (const b of bindings) {
      allBindings.push(b);
    }
  }

  if (allBindings.length === 0) return '';

  return formatCallPathContext({
    graph,
    routeBindings: allBindings,
    ...(maxCallersPerHandler !== undefined && { maxCallersPerHandler }),
    ...(maxCalleesPerHandler !== undefined && { maxCalleesPerHandler }),
  });
}
