// beforeToolCall hook — restricts impl-wave Write/Edit calls to the current spec piece's file list.
//
// During impl waves the model is given a single piece of the spec to implement, with an explicit
// `files[]` list. Without this guard, local/cheap models occasionally edit unrelated files (kova#250 —
// observed: gemma4 modified `surreal-bench/src/query_bench.rs` while working on the
// `domain-networking/src/enums.rs` piece), polluting the PR with out-of-scope changes.
//
// This guard returns a `beforeToolCall` hook that:
//   - Allows any tool other than `write` / `edit` (read, bash, grep, find — unrestricted).
//   - Allows `write` / `edit` only when the target path matches one of the piece's `files[]`.
//   - Blocks out-of-scope `write` / `edit` with a clear error message naming the in-scope files.
//   - No-ops (returns `undefined`) when `pieceFiles` is empty — preserves backward compat so callers
//     that don't pass a piece file list see no behavior change.
//
// Used only on the impl wave (test wave needs to create new test files; quality wave needs to fix
// lint/type errors anywhere in the repo — both are intentionally unrestricted).

import { isAbsolute, relative, resolve } from 'node:path';
import type { BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core';

export interface PieceScopeGuardOptions {
  /** Working directory for resolving relative tool-arg paths. */
  cwd: string;
  /**
   * Files this piece is allowed to modify (relative to `cwd`, or absolute).
   * Empty/undefined → no restriction is applied (backward compat).
   */
  pieceFiles: readonly string[];
}

interface PathArgs {
  path?: unknown;
}

/** Normalize a path (relative or absolute) to a canonical cwd-relative form. */
function normalize(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  // Use POSIX-style separators for stable cross-platform comparison.
  return relative(cwd, abs).split('\\').join('/');
}

/** Build the set of normalized in-scope file paths once for fast lookup. */
function buildAllowedSet(cwd: string, pieceFiles: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const f of pieceFiles) {
    if (typeof f !== 'string' || f.length === 0) continue;
    set.add(normalize(cwd, f));
  }
  return set;
}

function formatFileList(files: readonly string[]): string {
  if (files.length === 0) return '(none)';
  return files.map((f) => `\`${f}\``).join(', ');
}

/**
 * Create a `beforeToolCall` hook that restricts Write/Edit calls to a fixed file list.
 *
 * Returns `{ block: true, reason: "..." }` for out-of-scope edit/write calls.
 * Returns `undefined` for in-scope calls and any non-write/edit tool.
 *
 * When `pieceFiles` is empty, the returned hook is a no-op — every call returns `undefined`,
 * which preserves backward compatibility for callers that don't yet pass a piece file list.
 */
export function createPieceScopeGuard(
  options: PieceScopeGuardOptions,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const { cwd, pieceFiles } = options;
  const allowed = buildAllowedSet(cwd, pieceFiles);

  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    // Empty allow-list ⇒ no restriction (preserves backward compat).
    if (allowed.size === 0) return undefined;

    const toolName = context.toolCall?.name;
    if (toolName !== 'write' && toolName !== 'edit') return undefined;

    const args = context.args as PathArgs;
    const rawPath = typeof args.path === 'string' ? args.path : '';
    if (!rawPath) return undefined; // malformed args — let the tool's own validation surface the error

    const normalizedPath = normalize(cwd, rawPath);
    if (allowed.has(normalizedPath)) return undefined;

    return {
      block: true,
      reason: [
        `Cannot modify \`${rawPath}\` — this piece only covers: [${formatFileList(pieceFiles)}].`,
        'Edit one of the in-scope files instead. If a change to another file is genuinely required',
        'to make the tests pass, return a DIAGNOSIS with category SPEC_WRONG explaining why,',
        'so the orchestrator can amend the spec.',
      ].join(' '),
    };
  };
}

/**
 * Compose multiple `beforeToolCall` hooks into one. Each hook is run in order;
 * the first hook returning a `block: true` result short-circuits and that result
 * is returned. If all hooks return `undefined` (or `block: false`), the result of
 * the last non-undefined hook is returned, or `undefined` if none was set.
 *
 * Used by the wave executor to combine the piece-scope guard with the existing
 * destructive-edit guard without either having to know about the other.
 */
export function composeBeforeToolCallHooks(
  hooks: ReadonlyArray<
    ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>) | undefined
  >,
): ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>) | undefined {
  const active = hooks.filter(
    (h): h is (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> =>
      h !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  return async (context, signal) => {
    let last: BeforeToolCallResult | undefined;
    for (const hook of active) {
      const result = await hook(context, signal);
      if (result?.block === true) return result;
      if (result !== undefined) last = result;
    }
    return last;
  };
}
