// Tests for src/ai/codegraph.ts — wrappers around the external `codegraph` CLI.
// Helpers are dep-injected (the optional `exec` arg) so tests inject a fake
// without vi.mock'ing child_process. Real execFile is exercised by the integration
// path in fix.ts (manually verified) — kept out of unit tests to stay hermetic.

import { describe, expect, it } from 'vitest';
import type { SymbolNode } from '../types/codegraph.js';
import {
  type CodegraphLookup,
  extractSymbolCandidates,
  formatCodegraphContext,
  initCodegraph,
  isCodegraphOnPath,
  probeCodegraphStatus,
  shouldWithholdCodegraphTools,
  syncCodegraph,
} from './codegraph.js';

type FakeExecResult = { stdout: string; stderr: string; code: number };
type FakeExec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<FakeExecResult>;

function makeExec(map: Record<string, FakeExecResult | Error>): FakeExec {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    const v = map[key];
    if (v === undefined) {
      // Default: missing command -> ENOENT-like rejection
      throw Object.assign(new Error(`command not found: ${cmd}`), { code: 'ENOENT' });
    }
    if (v instanceof Error) throw v;
    if (v.code !== 0) {
      // Match Node's execFile error shape: rejected error with code/stdout/stderr
      throw Object.assign(new Error(`exit ${v.code}: ${v.stderr || v.stdout}`), {
        code: v.code,
        stdout: v.stdout,
        stderr: v.stderr,
      });
    }
    return v;
  };
}

describe('isCodegraphOnPath', () => {
  it('returns true when `codegraph --version` exits 0', async () => {
    const exec = makeExec({ 'codegraph --version': { stdout: 'codegraph 1.2.3', stderr: '', code: 0 } });
    expect(await isCodegraphOnPath(exec)).toBe(true);
  });

  it('returns false when codegraph is not installed (ENOENT)', async () => {
    const exec = makeExec({});
    expect(await isCodegraphOnPath(exec)).toBe(false);
  });

  it('returns false when codegraph errors out', async () => {
    const exec = makeExec({ 'codegraph --version': { stdout: '', stderr: 'boom', code: 2 } });
    expect(await isCodegraphOnPath(exec)).toBe(false);
  });
});

describe('initCodegraph', () => {
  it('runs `codegraph init <workDir> --index` and returns ok on success', async () => {
    const exec = makeExec({
      'codegraph init /work --index': { stdout: 'indexed 42 files', stderr: '', code: 0 },
    });
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('returns ok=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('returns ok=false with reason=exec-failed on non-zero exit', async () => {
    const exec = makeExec({
      'codegraph init /work --index': { stdout: '', stderr: 'index failed', code: 1 },
    });
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exec-failed');
  });

  it('NEVER throws — wraps every error path into the typed return shape', async () => {
    const exec: FakeExec = async () => {
      throw new Error('weird non-ENOENT failure');
    };
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('probeCodegraphStatus', () => {
  it('parses {"initialized": true, "nodes": 1234} JSON output', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': {
        stdout: '{"initialized": true, "nodes": 1234}',
        stderr: '',
        code: 0,
      },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(true);
    expect(r.nodeCount).toBe(1234);
  });

  it('returns initialized=false, nodeCount=0 when JSON reports uninitialized', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': {
        stdout: '{"initialized": false, "nodes": 0}',
        stderr: '',
        code: 0,
      },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.nodeCount).toBe(0);
  });

  it('returns initialized=false on parse failure with reason set', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': { stdout: 'not-json-at-all', stderr: '', code: 0 },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.nodeCount).toBe(0);
    expect(r.reason).toBeDefined();
  });

  it('returns initialized=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('NEVER throws', async () => {
    const exec: FakeExec = async () => {
      throw new Error('weird');
    };
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
  });
});

describe('syncCodegraph', () => {
  it('runs `codegraph sync --cwd <workDir>` and returns ok=true on success', async () => {
    const exec = makeExec({ 'codegraph sync --cwd /work': { stdout: 'synced', stderr: '', code: 0 } });
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(true);
  });

  it('returns ok=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('returns ok=false with reason=exec-failed on non-zero exit', async () => {
    const exec = makeExec({ 'codegraph sync --cwd /work': { stdout: '', stderr: 'sync failed', code: 1 } });
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exec-failed');
  });
});

describe('shouldWithholdCodegraphTools', () => {
  it('returns true when probe reports uninitialized', () => {
    expect(shouldWithholdCodegraphTools({ initialized: false, nodeCount: 0 })).toBe(true);
  });

  it('returns true when probe reports zero nodes (initialized but empty)', () => {
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 0 })).toBe(true);
  });

  it('returns false only when initialized AND nodeCount > 0', () => {
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 1 })).toBe(false);
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 999 })).toBe(false);
  });
});

// ---- Issue #273 — formatCodegraphContext + extractSymbolCandidates --------

function node(
  id: string,
  name: string,
  filePath: string,
  startLine: number,
  endLine: number,
  signature: string,
  kind: SymbolNode['kind'] = 'function',
): SymbolNode {
  return { id, name, filePath, startLine, endLine, signature, kind, isExported: true };
}

interface FakeGraph {
  nodes: SymbolNode[];
  edges: Array<{ from: string; to: string }>;
}

function makeLookup(graph: FakeGraph): CodegraphLookup {
  return {
    findSymbol: (name: string) => graph.nodes.filter((n) => n.name === name),
    getCallers: (nodeId: string) => {
      const callerIds = graph.edges.filter((e) => e.to === nodeId).map((e) => e.from);
      return callerIds.map((id) => graph.nodes.find((n) => n.id === id)).filter((n): n is SymbolNode => Boolean(n));
    },
    getCallees: (nodeId: string) => {
      const calleeIds = graph.edges.filter((e) => e.from === nodeId).map((e) => e.to);
      return calleeIds.map((id) => graph.nodes.find((n) => n.id === id)).filter((n): n is SymbolNode => Boolean(n));
    },
  };
}

describe('extractSymbolCandidates', () => {
  it('returns [] for empty input', () => {
    expect(extractSymbolCandidates('')).toEqual([]);
  });

  it('extracts backticked identifier-shaped tokens', () => {
    const out = extractSymbolCandidates('See `formatCodeChunks` in `vectordb.ts`');
    expect(out).toContain('formatCodeChunks');
  });

  it('extracts camelCase identifiers from prose', () => {
    const out = extractSymbolCandidates('Update buildSpecContext and buildImplContext to inject codeGraphContext.');
    expect(out).toEqual(expect.arrayContaining(['buildSpecContext', 'buildImplContext', 'codeGraphContext']));
  });

  it('deduplicates repeated tokens', () => {
    const out = extractSymbolCandidates('queryCodeContext queryCodeContext queryCodeContext');
    expect(out.filter((t) => t === 'queryCodeContext')).toHaveLength(1);
  });

  it('caps the candidate list at 20 entries', () => {
    // Build a string with 30 distinct camelCase identifiers.
    const tokens = Array.from({ length: 30 }, (_, i) => `someFunction${i}`).join(' ');
    expect(extractSymbolCandidates(tokens).length).toBeLessThanOrEqual(20);
  });

  it('ignores short tokens and common english words', () => {
    // bare lowercase short words / no-capital letters should not survive.
    const out = extractSymbolCandidates('the and not is up');
    expect(out).toEqual([]);
  });
});

describe('formatCodegraphContext', () => {
  it('returns empty string when symbolNames is empty', () => {
    const out = formatCodegraphContext({ graph: makeLookup({ nodes: [], edges: [] }), symbolNames: [] });
    expect(out).toBe('');
  });

  it('returns empty string when no symbols resolve in the graph', () => {
    const out = formatCodegraphContext({
      graph: makeLookup({ nodes: [], edges: [] }),
      symbolNames: ['doesNotExist'],
    });
    expect(out).toBe('');
  });

  it('emits a header with definition span + signature for each resolved symbol', () => {
    const target = node(
      'A',
      'formatCodeChunks',
      'src/services/vectordb.ts',
      76,
      89,
      'function formatCodeChunks(chunks)',
    );
    const graph = makeLookup({ nodes: [target], edges: [] });
    const out = formatCodegraphContext({ graph, symbolNames: ['formatCodeChunks'] });
    expect(out).toContain('## Code graph context');
    expect(out).toContain('formatCodeChunks');
    expect(out).toContain('src/services/vectordb.ts:L76-L89');
    expect(out).toContain('function formatCodeChunks(chunks)');
  });

  it('lists direct callers and callees per resolved symbol', () => {
    const target = node('T', 'target', 'src/t.ts', 1, 5, 'function target()');
    const caller = node('C', 'caller', 'src/c.ts', 10, 20, 'function caller()');
    const callee = node('K', 'callee', 'src/k.ts', 30, 40, 'function callee()');
    const graph = makeLookup({
      nodes: [target, caller, callee],
      edges: [
        { from: caller.id, to: target.id },
        { from: target.id, to: callee.id },
      ],
    });
    const out = formatCodegraphContext({ graph, symbolNames: ['target'] });
    expect(out).toContain('Callers:');
    expect(out).toContain('caller');
    expect(out).toContain('Callees:');
    expect(out).toContain('callee');
  });

  it('truncates callers/callees lists per maxCallersPerSymbol / maxCalleesPerSymbol', () => {
    const target = node('T', 'target', 'src/t.ts', 1, 5, 'function target()');
    const callerNodes = Array.from({ length: 8 }, (_, i) =>
      node(`C${i}`, `caller${i}`, 'src/c.ts', i + 10, i + 11, `function caller${i}()`),
    );
    const calleeNodes = Array.from({ length: 8 }, (_, i) =>
      node(`K${i}`, `callee${i}`, 'src/k.ts', i + 20, i + 21, `function callee${i}()`),
    );
    const edges = [
      ...callerNodes.map((c) => ({ from: c.id, to: target.id })),
      ...calleeNodes.map((c) => ({ from: target.id, to: c.id })),
    ];
    const graph = makeLookup({ nodes: [target, ...callerNodes, ...calleeNodes], edges });

    const out = formatCodegraphContext({
      graph,
      symbolNames: ['target'],
      maxCallersPerSymbol: 2,
      maxCalleesPerSymbol: 3,
    });

    // Only 2 callers should appear in the output; the rest are truncated.
    expect(out).toContain('caller0');
    expect(out).toContain('caller1');
    expect(out).not.toContain('caller7');
    // Only 3 callees should appear.
    expect(out).toContain('callee0');
    expect(out).toContain('callee1');
    expect(out).toContain('callee2');
    expect(out).not.toContain('callee7');
  });

  it('emits multi-hop Call paths section (A -> B -> C) from BFS of getCallees', () => {
    const a = node('A', 'A', 'src/a.ts', 1, 5, 'function A()');
    const b = node('B', 'B', 'src/b.ts', 1, 5, 'function B()');
    const c = node('C', 'C', 'src/c.ts', 1, 5, 'function C()');
    const graph = makeLookup({
      nodes: [a, b, c],
      edges: [
        { from: a.id, to: b.id },
        { from: b.id, to: c.id },
      ],
    });
    const out = formatCodegraphContext({ graph, symbolNames: ['A'], maxCallPathDepth: 2 });
    expect(out).toContain('Call paths');
    // Arrow rendering — either ASCII `->` or unicode `→`, but the chain must be visible.
    expect(out).toMatch(/A\s*(?:->|→)\s*B\s*(?:->|→)\s*C/);
  });

  it('omits the Call paths subsection when no chains exist (single isolated symbol)', () => {
    const lone = node('L', 'lone', 'src/l.ts', 1, 5, 'function lone()');
    const graph = makeLookup({ nodes: [lone], edges: [] });
    const out = formatCodegraphContext({ graph, symbolNames: ['lone'] });
    expect(out).not.toContain('Call paths');
  });

  it('renders every node when findSymbol returns multiple matches (overloads / shadowed)', () => {
    const a1 = node('A1', 'shared', 'src/a.ts', 10, 20, 'function shared(a)');
    const a2 = node('A2', 'shared', 'src/b.ts', 30, 40, 'function shared(b)');
    const graph = makeLookup({ nodes: [a1, a2], edges: [] });
    const out = formatCodegraphContext({ graph, symbolNames: ['shared'] });
    expect(out).toContain('src/a.ts:L10-L20');
    expect(out).toContain('src/b.ts:L30-L40');
  });

  it('is a pure function — never reads the filesystem, never opens a DB', () => {
    // The contract is enforced structurally: the formatter only takes a CodegraphLookup
    // (3 methods) — there is no place for it to do I/O. This test pins that:
    // calling it on a totally inert lookup must not throw and must return ''.
    const inert: CodegraphLookup = {
      findSymbol: () => [],
      getCallers: () => [],
      getCallees: () => [],
    };
    expect(formatCodegraphContext({ graph: inert, symbolNames: ['anything'] })).toBe('');
  });
});
