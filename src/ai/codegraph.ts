// Issue #271 — wrappers around the external `codegraph` CLI.
//
// The `codegraph` MCP server (started via stdio) returns useful results only
// after `codegraph init <workDir> --index`. A fresh worktree has no index, so
// without this gate `codegraph serve --mcp` answers empty-but-successfully and
// the agent silently gets no graph (see codegraph README:494,505 cited in #271).
//
// Strategy:
//   - probe `command -v codegraph` (or `codegraph --version`) to know if the CLI
//     is installed at all. If not on PATH, every helper returns a typed not-on-path
//     failure and the pipeline proceeds unchanged (no behavior change).
//   - `init` runs `codegraph init <workDir> --index` once per worktree setup.
//   - `status --json` reports `{initialized, nodes}` — the gate for "should we
//     even start the MCP server, or will it just serve an empty index?".
//   - `sync` runs between WAVE I (edits) and WAVE R (review) so impact reflects
//     the new edits.
//
// All helpers swallow non-zero exits and return a typed `{ok, reason}` shape so
// the caller never has to wrap a try/catch — gracefully degrading to "codegraph
// is optional" is the whole point of this module.

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { SymbolNode } from '../types/codegraph.js';

const execFile = promisify(execFileCallback);

/** Shape of the result returned by every helper in this module. */
export interface CodegraphActionResult {
  ok: boolean;
  /** Short tag for failed cases: 'not-on-path' | 'exec-failed: <msg>' | 'parse-failed: <msg>'. */
  reason?: string;
}

export interface CodegraphStatus {
  initialized: boolean;
  nodeCount: number;
  reason?: string;
}

/**
 * One row returned by the codegraph symbol-lookup helpers
 * (`findSymbolDefinitions` + `findSymbolReferences`). Mirrors the JSON shape
 * emitted by `codegraph find-symbol --json` / `codegraph callers --json`.
 *
 * `kind` is left as a free-form string because the upstream codegraph CLI
 * may emit `'function' | 'class' | 'method' | 'caller' | 'callee' | ...` and
 * we don't want the typed surface to drift each time codegraph adds a new
 * symbol kind. Callers that want a strict union should narrow at the
 * consumption site.
 */
export interface SymbolHit {
  symbol: string;
  file: string;
  startLine: number;
  endLine: number;
  kind: string;
}

/** Injection point for tests — runs a shell command and returns stdout/stderr/code.
 *  Real implementation is execFile from node:child_process. */
export type ExecFn = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Default exec wrapper that adapts node:child_process to our typed shape.
 *  Rejects on non-zero exit and ENOENT alike — the helpers above classify the
 *  rejection (ENOENT -> not-on-path, anything else -> exec-failed). */
const defaultExec: ExecFn = async (command, args, opts) => {
  const result = await execFile(command, args, { timeout: opts?.timeout, cwd: opts?.cwd });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
};

/** True when the `codegraph` CLI is on PATH and executable. */
export async function isCodegraphOnPath(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const r = await exec('codegraph', ['--version'], { timeout: 5_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Run `codegraph init <workDir> --index` (best-effort). */
export async function initCodegraph(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphActionResult> {
  try {
    const r = await exec('codegraph', ['init', workDir, '--index'], { timeout: 5 * 60_000 });
    if (r.code === 0) return { ok: true };
    return { ok: false, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
  } catch (err) {
    return { ok: false, reason: classifyExecError(err) };
  }
}

/** Probe `codegraph status --json --cwd <workDir>` and return parsed shape. */
export async function probeCodegraphStatus(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphStatus> {
  let stdout: string;
  try {
    const r = await exec('codegraph', ['status', '--json', '--cwd', workDir], { timeout: 10_000 });
    if (r.code !== 0) {
      return { initialized: false, nodeCount: 0, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
    }
    stdout = r.stdout;
  } catch (err) {
    return { initialized: false, nodeCount: 0, reason: classifyExecError(err) };
  }

  try {
    const parsed = JSON.parse(stdout) as { initialized?: unknown; nodes?: unknown };
    const initialized = parsed.initialized === true;
    const nodeCount = typeof parsed.nodes === 'number' ? parsed.nodes : 0;
    return { initialized, nodeCount };
  } catch (err) {
    return {
      initialized: false,
      nodeCount: 0,
      reason: `parse-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run `codegraph sync --cwd <workDir>` (best-effort) between WAVE I and WAVE R. */
export async function syncCodegraph(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphActionResult> {
  try {
    const r = await exec('codegraph', ['sync', '--cwd', workDir], { timeout: 60_000 });
    if (r.code === 0) return { ok: true };
    return { ok: false, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
  } catch (err) {
    return { ok: false, reason: classifyExecError(err) };
  }
}

/**
 * Run `codegraph find-symbol <name> --json --cwd <workDir>` and parse the
 * resulting JSON array of hits. Best-effort: returns `[]` on any failure
 * (not-on-path, non-zero exit, parse error). Never throws.
 *
 * Wraps the structural lookup half of the hybrid graph+vector retrieval
 * (#274). The pipeline always treats an empty result as "graph could not
 * resolve this symbol — fall back to vector neighbors".
 */
export async function findSymbolDefinitions(
  workDir: string,
  symbol: string,
  exec: ExecFn = defaultExec,
): Promise<SymbolHit[]> {
  return runSymbolLookup(['find-symbol', symbol, '--json', '--cwd', workDir], exec);
}

/**
 * Run `codegraph callers <name> --json --cwd <workDir>` to fetch 1-hop
 * caller/callee references for an already-resolved symbol. Same best-effort
 * contract as `findSymbolDefinitions` — empty array on any failure.
 *
 * Pairs with `findSymbolDefinitions` to provide the "callers + callees" hop
 * that #274 references as the structural complement to vector retrieval.
 */
export async function findSymbolReferences(
  workDir: string,
  symbol: string,
  exec: ExecFn = defaultExec,
): Promise<SymbolHit[]> {
  return runSymbolLookup(['callers', symbol, '--json', '--cwd', workDir], exec);
}

/** Shared executor for the two symbol-lookup helpers. */
async function runSymbolLookup(args: string[], exec: ExecFn): Promise<SymbolHit[]> {
  let stdout: string;
  try {
    const r = await exec('codegraph', args, { timeout: 30_000 });
    if (r.code !== 0) return [];
    stdout = r.stdout;
  } catch {
    // not-on-path, exec-failed, anything else — graceful degrade.
    return [];
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSymbolHit);
  } catch {
    return [];
  }
}

/** Runtime guard: the codegraph CLI returns loosely-typed JSON, so we
 *  validate each row before accepting it into the typed pipeline. */
function isSymbolHit(v: unknown): v is SymbolHit {
  if (v == null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.symbol === 'string' &&
    typeof o.file === 'string' &&
    typeof o.startLine === 'number' &&
    typeof o.endLine === 'number' &&
    typeof o.kind === 'string'
  );
}

/** Decide whether to withhold codegraph MCP tools for the current run.
 *  Withhold when the probe shows uninitialized OR zero nodes — both cases
 *  mean `codegraph serve --mcp` will return empty-but-successful results,
 *  which silently degrades agent reasoning. Better to withhold than to lie. */
export function shouldWithholdCodegraphTools(probe: { initialized: boolean; nodeCount: number }): boolean {
  return !probe.initialized || probe.nodeCount === 0;
}

/** Classify the rejected execFile error into our typed reason tag. */
function classifyExecError(err: unknown): string {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (code === 'ENOENT') return 'not-on-path';
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `exec-failed: ${msg}`;
}

// ============================================================================
// Issue #273 — graph-backed context formatter.
//
// `formatCodegraphContext` synthesises the markdown block injected into spec
// and impl waves ABOVE the fuzzy vector-DB context. Two qualities matter:
//
//   1. PURE FUNCTION. The formatter takes a `CodegraphLookup` (three read
//      methods only) and a list of symbol names — never opens a file, never
//      opens a DB, never calls fetch. The caller is responsible for resolving
//      its data source (typically the in-process SQLite store at
//      `.kova/codegraph.db` via `openCodegraph()`). Keeping the formatter pure
//      means tests pass a tiny in-memory fake (see codegraph.test.ts) and the
//      production wiring degrades gracefully when the DB is missing — the
//      caller simply skips the call and the spec/impl wave proceeds with only
//      the fuzzy chunks (today's behavior).
//
//   2. EMPTY ON NO-MATCH. When no input symbols resolve, the helper returns
//      `''`. The empty string is filtered out by the existing
//      `sections.join('\n\n')` in `buildSpecContext` / `buildImplContext`, so
//      "no graph data for this issue" produces zero noise in the prompt —
//      better than a stub header that wastes tokens.
//
// The output shape mirrors codegraph's own ContextBuilder (see the upstream
// reference cited in #273): one section per resolved symbol with exact
// definition span + signature, then bullet lists of direct callers/callees,
// and finally a 'Call paths' subsection that walks `getCallees` BFS to render
// A → B → C chains. Caps on each list (default 5 callers, 5 callees, depth 2)
// keep the section bounded so it composes with `truncateToTokenBudget` rather
// than fighting it.
// ============================================================================

/**
 * Read-only slice of the codegraph store used by {@link formatCodegraphContext}.
 *
 * Intentionally narrower than `CodegraphHandle` (services/codegraph) so tests
 * can construct a tiny in-memory fake without taking a dependency on SQLite.
 * Production callers pass `openCodegraph(dbPath)` directly — it satisfies
 * this interface structurally.
 */
export interface CodegraphLookup {
  findSymbol: (name: string) => SymbolNode[];
  getCallers: (nodeId: string) => SymbolNode[];
  getCallees: (nodeId: string) => SymbolNode[];
}

/** Options to {@link formatCodegraphContext}. */
export interface FormatCodegraphContextOptions {
  graph: CodegraphLookup;
  /** Symbol names to look up. Typically derived via {@link extractSymbolCandidates}. */
  symbolNames: string[];
  /** Max callers to render per resolved symbol (default 5). */
  maxCallersPerSymbol?: number;
  /** Max callees to render per resolved symbol (default 5). */
  maxCalleesPerSymbol?: number;
  /**
   * Max hops to walk in the 'Call paths' subsection (default 2 -> renders A→B→C
   * chains). Bounded BFS — each step expands by `getCallees`, capped per node
   * at `maxCalleesPerSymbol` so a single fan-out hub doesn't explode the
   * walk.
   */
  maxCallPathDepth?: number;
  /**
   * Max distinct call paths to render (default 10). Prevents the section from
   * dominating the prompt when there's a wide graph.
   */
  maxCallPaths?: number;
}

/**
 * Build the '## Code graph context' markdown section for the given symbols.
 *
 * Returns `''` when `symbolNames` is empty OR no symbol resolves in `graph` —
 * the empty string is filtered out by the calling `sections.join('\n\n')` in
 * the per-wave context builders so the prompt stays clean.
 */
export function formatCodegraphContext(opts: FormatCodegraphContextOptions): string {
  const {
    graph,
    symbolNames,
    maxCallersPerSymbol = 5,
    maxCalleesPerSymbol = 5,
    maxCallPathDepth = 2,
    maxCallPaths = 10,
  } = opts;

  if (symbolNames.length === 0) return '';

  // Resolve every input name, preserving order and dropping duplicates.
  const seen = new Set<string>();
  const resolved: SymbolNode[] = [];
  for (const name of symbolNames) {
    const matches = graph.findSymbol(name);
    for (const m of matches) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        resolved.push(m);
      }
    }
  }

  if (resolved.length === 0) return '';

  // Per-symbol section: definition span + signature + callers + callees.
  const symbolSections: string[] = [];
  for (const node of resolved) {
    const lines: string[] = [];
    lines.push(`### ${node.name} (${node.kind})`);
    lines.push(`\`${node.filePath}:L${node.startLine}-L${node.endLine}\` — ${node.signature}`);

    const callers = graph.getCallers(node.id).slice(0, maxCallersPerSymbol);
    const callees = graph.getCallees(node.id).slice(0, maxCalleesPerSymbol);

    if (callers.length > 0) {
      lines.push(`**Callers:** ${callers.map(renderRef).join(', ')}`);
    }
    if (callees.length > 0) {
      lines.push(`**Callees:** ${callees.map(renderRef).join(', ')}`);
    }

    symbolSections.push(lines.join('\n'));
  }

  // Call paths subsection — BFS from each seed; emit only chains with ≥2 hops.
  const callPaths = collectCallPaths(graph, resolved, maxCallPathDepth, maxCalleesPerSymbol, maxCallPaths);

  const out: string[] = ['## Code graph context', '', symbolSections.join('\n\n')];
  if (callPaths.length > 0) {
    out.push('', '### Call paths', callPaths.map((chain) => `- ${chain.join(' → ')}`).join('\n'));
  }
  return out.join('\n');
}

/** "name (file:Lstart)" — compact link-y inline reference. */
function renderRef(n: SymbolNode): string {
  return `${n.name} (${n.filePath}:L${n.startLine})`;
}

/**
 * Collect distinct, length-≥2 call chains starting from each seed node.
 * BFS with cycle protection (per-path visited set) and a global dedupe by
 * stringified chain.
 */
function collectCallPaths(
  graph: CodegraphLookup,
  seeds: SymbolNode[],
  maxDepth: number,
  fanoutCap: number,
  maxPaths: number,
): string[][] {
  if (maxDepth < 1) return [];
  const allChains: string[][] = [];
  const dedupe = new Set<string>();

  for (const seed of seeds) {
    // Each entry holds the current path of names + visited node ids (cycle-safe).
    type Frontier = { names: string[]; visited: Set<string>; tail: SymbolNode };
    let frontier: Frontier[] = [{ names: [seed.name], visited: new Set([seed.id]), tail: seed }];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: Frontier[] = [];
      for (const f of frontier) {
        const callees = graph.getCallees(f.tail.id).slice(0, fanoutCap);
        for (const callee of callees) {
          if (f.visited.has(callee.id)) continue;
          const nextNames = [...f.names, callee.name];
          const key = nextNames.join('|');
          if (!dedupe.has(key) && nextNames.length >= 2) {
            dedupe.add(key);
            allChains.push(nextNames);
            if (allChains.length >= maxPaths) return allChains;
          }
          next.push({ names: nextNames, visited: new Set([...f.visited, callee.id]), tail: callee });
        }
      }
      frontier = next;
    }
  }

  // Keep only chains with ≥3 names (the BFS may have emitted length-2 paths as
  // a side effect of "emit at every hop"). The spec requires multi-hop A→B→C
  // rendering — single-hop "A → B" is already implicit from the Callees list.
  return allChains.filter((c) => c.length >= 3);
}

// ---- Identifier extraction --------------------------------------------------

/**
 * Pull plausible symbol-name candidates from a chunk of free text (typically
 * `issue.title + issue.body`). Used by the fix.ts wiring to derive the
 * `symbolNames` argument for {@link formatCodegraphContext} without forcing
 * users to list symbols manually in issue bodies.
 *
 * Heuristic:
 *   - All identifier-shaped runs inside backticks (`buildSpecContext`,
 *     `formatCodeChunks`) — backtick spans are the strongest "this is code"
 *     signal we can extract from a prose issue body.
 *   - All standalone camelCase tokens of length ≥ 3 — `buildImplContext`,
 *     `queryCodeContext`, etc. Lowercase-only tokens (English words) are
 *     dropped to avoid noise from "the", "and", and friends.
 *
 * Dedupes, caps at 20 entries (enough to cover an issue with multiple
 * mentioned symbols without blowing the prompt budget).
 */
export function extractSymbolCandidates(text: string): string[] {
  if (text.length === 0) return [];

  const found = new Set<string>();
  const order: string[] = [];

  const push = (token: string): void => {
    if (token.length < 3) return;
    if (found.has(token)) return;
    // Drop pure lowercase tokens — common english words ("not", "and") shouldn't
    // pollute the lookup. Identifiers with at least one uppercase letter
    // (camelCase, PascalCase, SCREAMING) survive; backticked tokens always
    // survive regardless of case because the user explicitly marked them as code.
    found.add(token);
    order.push(token);
  };

  // Pass 1: every backticked span — `foo` or `foo.bar()` — grab the identifier-
  // shaped runs inside.
  for (const backtickMatch of text.matchAll(/`([^`]+)`/g)) {
    const inner = backtickMatch[1] ?? '';
    for (const idMatch of inner.matchAll(/[A-Za-z_][A-Za-z0-9_]+/g)) {
      push(idMatch[0]);
    }
  }

  // Pass 2: free-floating camelCase / PascalCase / SCREAMING_SNAKE tokens.
  // Require at least one uppercase letter — drops lowercase prose words.
  for (const freeMatch of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const tok = freeMatch[0];
    if (!/[A-Z]/.test(tok)) continue;
    push(tok);
  }

  return order.slice(0, 20);
}
