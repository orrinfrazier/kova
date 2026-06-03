// Tests for src/pipeline/call-path-context.ts — issue #275.
//
// The resolver is a pure function: a fake `CodegraphLookup` + an in-memory file
// reader cover every path. No real filesystem, no real codegraph DB.

import { describe, expect, it } from 'vitest';
import type { CodegraphLookup } from '../ai/codegraph.js';
import type { SymbolEdge, SymbolNode } from '../types/codegraph.js';
import {
  extractRouteBindings,
  formatCallPathContext,
  type RouteBinding,
  resolveCallPaths,
} from './call-path-context.js';

// ---- in-memory graph helper (mirrors codegraph.test.ts shape) -----------

function makeLookup(seed: { nodes: SymbolNode[]; edges: SymbolEdge[] }): CodegraphLookup {
  const byName = new Map<string, SymbolNode[]>();
  const byId = new Map<string, SymbolNode>();
  for (const n of seed.nodes) {
    byId.set(n.id, n);
    const arr = byName.get(n.name) ?? [];
    arr.push(n);
    byName.set(n.name, arr);
  }
  const callersOf = new Map<string, SymbolNode[]>();
  const calleesOf = new Map<string, SymbolNode[]>();
  for (const e of seed.edges) {
    if (e.kind !== 'calls') continue;
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) continue;
    const callers = callersOf.get(dst.id) ?? [];
    callers.push(src);
    callersOf.set(dst.id, callers);
    const callees = calleesOf.get(src.id) ?? [];
    callees.push(dst);
    calleesOf.set(src.id, callees);
  }
  return {
    findSymbol: (name) => byName.get(name) ?? [],
    getCallers: (id) => callersOf.get(id) ?? [],
    getCallees: (id) => calleesOf.get(id) ?? [],
  };
}

function makeNode(partial: Partial<SymbolNode> & { name: string; filePath: string }): SymbolNode {
  return {
    id: partial.id ?? `${partial.filePath}::${partial.name}@${partial.startLine ?? 1}`,
    kind: partial.kind ?? 'function',
    name: partial.name,
    filePath: partial.filePath,
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? 10,
    signature: partial.signature ?? `function ${partial.name}()`,
    isExported: partial.isExported ?? true,
  };
}

// ---- extractRouteBindings ----------------------------------------------

describe('extractRouteBindings', () => {
  it('returns [] for empty input', () => {
    expect(extractRouteBindings('')).toEqual([]);
  });

  it('extracts a single Express GET binding with named handler', () => {
    const src = "app.get('/users', listUsers);";
    expect(extractRouteBindings(src)).toEqual<RouteBinding[]>([
      { method: 'GET', path: '/users', handlerName: 'listUsers' },
    ]);
  });

  it('extracts POST/PUT/DELETE/PATCH bindings', () => {
    const src = `
      app.post('/users', createUser);
      app.put('/users/:id', updateUser);
      app.delete('/users/:id', deleteUser);
      app.patch('/users/:id', patchUser);
    `;
    const out = extractRouteBindings(src);
    expect(out.map((b) => b.method)).toEqual(['POST', 'PUT', 'DELETE', 'PATCH']);
    expect(out.map((b) => b.handlerName)).toEqual(['createUser', 'updateUser', 'deleteUser', 'patchUser']);
  });

  it('extracts bindings off `router.*` (not just `app.*`)', () => {
    const src = "router.get('/health', healthHandler);";
    expect(extractRouteBindings(src)).toEqual<RouteBinding[]>([
      { method: 'GET', path: '/health', handlerName: 'healthHandler' },
    ]);
  });

  it('supports double-quoted path strings', () => {
    const src = 'app.get("/users", listUsers);';
    expect(extractRouteBindings(src)).toEqual<RouteBinding[]>([
      { method: 'GET', path: '/users', handlerName: 'listUsers' },
    ]);
  });

  it('skips inline-arrow handlers — no symbol to resolve', () => {
    const src = "app.get('/inline', (req, res) => res.send('ok'));";
    expect(extractRouteBindings(src)).toEqual([]);
  });

  it('skips inline-function handlers (`function (req, res) {}`)', () => {
    const src = "app.get('/inline', function (req, res) { res.send('ok'); });";
    expect(extractRouteBindings(src)).toEqual([]);
  });

  it('skips `app.use(...)` — middleware mounts are not handler bindings', () => {
    const src = "app.use('/api', subRouter);";
    expect(extractRouteBindings(src)).toEqual([]);
  });

  it('handles multiple bindings in one file and preserves order', () => {
    const src = `
      app.get('/a', handlerA);
      app.post('/b', handlerB);
      app.get('/c', handlerC);
    `;
    const out = extractRouteBindings(src);
    expect(out.map((b) => b.handlerName)).toEqual(['handlerA', 'handlerB', 'handlerC']);
  });

  it('dedupes identical bindings', () => {
    const src = `
      app.get('/users', listUsers);
      app.get('/users', listUsers);
    `;
    const out = extractRouteBindings(src);
    expect(out.length).toBe(1);
  });

  it('handles whitespace and newlines between args', () => {
    const src = "app.get(\n  '/users',\n  listUsers\n);";
    expect(extractRouteBindings(src)).toEqual<RouteBinding[]>([
      { method: 'GET', path: '/users', handlerName: 'listUsers' },
    ]);
  });

  it('captures `app.all(...)` as method ALL', () => {
    const src = "app.all('/catchall', catchHandler);";
    expect(extractRouteBindings(src)).toEqual<RouteBinding[]>([
      { method: 'ALL', path: '/catchall', handlerName: 'catchHandler' },
    ]);
  });
});

// ---- formatCallPathContext ---------------------------------------------

describe('formatCallPathContext', () => {
  it('returns empty string when routeBindings is empty', () => {
    const graph = makeLookup({ nodes: [], edges: [] });
    expect(formatCallPathContext({ graph, routeBindings: [] })).toBe('');
  });

  it('returns empty string when no handler resolves in the graph', () => {
    const graph = makeLookup({ nodes: [], edges: [] });
    const bindings: RouteBinding[] = [{ method: 'GET', path: '/users', handlerName: 'listUsers' }];
    expect(formatCallPathContext({ graph, routeBindings: bindings })).toBe('');
  });

  it('renders one section per resolved route handler with definition span', () => {
    const handler = makeNode({
      name: 'listUsers',
      filePath: 'src/api/users.ts',
      startLine: 42,
      endLine: 60,
      signature: 'function listUsers(req, res)',
    });
    const graph = makeLookup({ nodes: [handler], edges: [] });
    const out = formatCallPathContext({
      graph,
      routeBindings: [{ method: 'GET', path: '/users', handlerName: 'listUsers' }],
    });
    expect(out).toContain('## Framework call paths');
    expect(out).toContain('GET /users → listUsers');
    expect(out).toContain('src/api/users.ts');
    expect(out).toContain('L42-L60');
    expect(out).toContain('function listUsers(req, res)');
  });

  it('includes 1-hop callers when the graph has them', () => {
    const handler = makeNode({ name: 'listUsers', filePath: 'src/api/users.ts', startLine: 42 });
    const registerRoutes = makeNode({ name: 'registerRoutes', filePath: 'src/api/index.ts', startLine: 8 });
    const graph = makeLookup({
      nodes: [handler, registerRoutes],
      edges: [{ source: registerRoutes.id, target: handler.id, kind: 'calls' }],
    });
    const out = formatCallPathContext({
      graph,
      routeBindings: [{ method: 'GET', path: '/users', handlerName: 'listUsers' }],
    });
    expect(out).toContain('Callers:');
    expect(out).toContain('registerRoutes');
  });

  it('includes 1-hop callees when the graph has them', () => {
    const handler = makeNode({ name: 'listUsers', filePath: 'src/api/users.ts', startLine: 42 });
    const queryUsers = makeNode({ name: 'queryUsers', filePath: 'src/services/users.ts', startLine: 12 });
    const graph = makeLookup({
      nodes: [handler, queryUsers],
      edges: [{ source: handler.id, target: queryUsers.id, kind: 'calls' }],
    });
    const out = formatCallPathContext({
      graph,
      routeBindings: [{ method: 'GET', path: '/users', handlerName: 'listUsers' }],
    });
    expect(out).toContain('Callees:');
    expect(out).toContain('queryUsers');
  });

  it('caps callers/callees at the configured limit', () => {
    const handler = makeNode({ name: 'h', filePath: 'src/h.ts', startLine: 1 });
    const callers = Array.from({ length: 10 }, (_, i) =>
      makeNode({ name: `caller${i}`, filePath: 'src/c.ts', startLine: i + 1 }),
    );
    const graph = makeLookup({
      nodes: [handler, ...callers],
      edges: callers.map((c) => ({ source: c.id, target: handler.id, kind: 'calls' as const })),
    });
    const out = formatCallPathContext({
      graph,
      routeBindings: [{ method: 'GET', path: '/h', handlerName: 'h' }],
      maxCallersPerHandler: 3,
    });
    // Should include 3 caller names but not all 10
    expect(out).toContain('caller0');
    expect(out).toContain('caller2');
    expect(out).not.toContain('caller9');
  });

  it('renders multiple routes when multiple resolve', () => {
    const listUsers = makeNode({ name: 'listUsers', filePath: 'src/api/users.ts', startLine: 10 });
    const createUser = makeNode({ name: 'createUser', filePath: 'src/api/users.ts', startLine: 50 });
    const graph = makeLookup({ nodes: [listUsers, createUser], edges: [] });
    const out = formatCallPathContext({
      graph,
      routeBindings: [
        { method: 'GET', path: '/users', handlerName: 'listUsers' },
        { method: 'POST', path: '/users', handlerName: 'createUser' },
      ],
    });
    expect(out).toContain('GET /users → listUsers');
    expect(out).toContain('POST /users → createUser');
  });

  it('dedupes routes that point to the same handler symbol', () => {
    const handler = makeNode({ name: 'shared', filePath: 'src/h.ts', startLine: 1 });
    const graph = makeLookup({ nodes: [handler], edges: [] });
    const out = formatCallPathContext({
      graph,
      // Same path + handler appears twice
      routeBindings: [
        { method: 'GET', path: '/x', handlerName: 'shared' },
        { method: 'GET', path: '/x', handlerName: 'shared' },
      ],
    });
    // Header should appear once for the unique route+handler combination
    const matches = out.match(/GET \/x → shared/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ---- resolveCallPaths (end-to-end fixture) -----------------------------

describe('resolveCallPaths', () => {
  it('reads files, extracts bindings, queries graph, returns formatted context', () => {
    const handler = makeNode({
      name: 'listUsers',
      filePath: 'src/api/users.ts',
      startLine: 42,
      signature: 'function listUsers(req, res)',
    });
    const registerRoutes = makeNode({ name: 'registerRoutes', filePath: 'src/api/index.ts', startLine: 8 });
    const queryUsers = makeNode({ name: 'queryUsers', filePath: 'src/services/users.ts', startLine: 12 });
    const graph = makeLookup({
      nodes: [handler, registerRoutes, queryUsers],
      edges: [
        { source: registerRoutes.id, target: handler.id, kind: 'calls' },
        { source: handler.id, target: queryUsers.id, kind: 'calls' },
      ],
    });

    const fileSource = new Map<string, string>([
      ['src/api/routes.ts', "import { listUsers } from './users';\napp.get('/users', listUsers);"],
    ]);

    const out = resolveCallPaths({
      graph,
      files: ['src/api/routes.ts'],
      readSource: (path) => fileSource.get(path) ?? '',
    });

    expect(out).toContain('## Framework call paths');
    expect(out).toContain('GET /users → listUsers');
    expect(out).toContain('registerRoutes');
    expect(out).toContain('queryUsers');
  });

  it('returns empty string when no files contain route bindings', () => {
    const graph = makeLookup({ nodes: [], edges: [] });
    const out = resolveCallPaths({
      graph,
      files: ['src/services/util.ts'],
      readSource: () => 'export function noop() {}',
    });
    expect(out).toBe('');
  });

  it('returns empty string when files list is empty', () => {
    const graph = makeLookup({ nodes: [], edges: [] });
    const out = resolveCallPaths({ graph, files: [], readSource: () => '' });
    expect(out).toBe('');
  });

  it('returns empty string when readSource throws (graceful degrade)', () => {
    const graph = makeLookup({ nodes: [], edges: [] });
    const out = resolveCallPaths({
      graph,
      files: ['src/api/routes.ts'],
      readSource: () => {
        throw new Error('ENOENT');
      },
    });
    expect(out).toBe('');
  });

  it('aggregates bindings across multiple files', () => {
    const a = makeNode({ name: 'handlerA', filePath: 'src/api/a.ts', startLine: 1 });
    const b = makeNode({ name: 'handlerB', filePath: 'src/api/b.ts', startLine: 1 });
    const graph = makeLookup({ nodes: [a, b], edges: [] });
    const sources = new Map<string, string>([
      ['src/api/routesA.ts', "app.get('/a', handlerA);"],
      ['src/api/routesB.ts', "router.post('/b', handlerB);"],
    ]);
    const out = resolveCallPaths({
      graph,
      files: ['src/api/routesA.ts', 'src/api/routesB.ts'],
      readSource: (p) => sources.get(p) ?? '',
    });
    expect(out).toContain('GET /a → handlerA');
    expect(out).toContain('POST /b → handlerB');
  });
});
