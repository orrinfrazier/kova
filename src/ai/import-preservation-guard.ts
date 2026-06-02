// beforeToolCall hook — rejects file edits that strip out imports still
// referenced elsewhere in the file.
//
// Observed failure: local models (e.g. gemma4) occasionally delete a `use` /
// `import` / `from` line while keeping the symbols those imports introduce
// (derives, function calls, type annotations). The next compile/test wave then
// fails with "unresolved import" and burns retry cycles.
//
// This guard catches the regression at the tool-call gate:
//
// - Compute the post-edit content (apply edits to the original file in memory).
// - Extract imports from the original file.
// - For each import removed from the new content, gather the local names it
//   introduced.
// - If any of those names is still referenced in the new content, block the
//   call with a clear, language-tagged error message.
//
// Languages: Rust (`use`), TypeScript/JavaScript (`import`), Python (`import`,
// `from`), Go (`import`). Unknown file extensions pass through unchanged.
//
// Bypassable via `allowDestructive: true` (shared opt-out with the destructive-
// edit guard) at the guard-construction site or per-call in tool args.

import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

export interface ImportPreservationGuardOptions {
  /** Working directory for resolving relative paths in tool args. */
  cwd: string;
  /** Bypass all checks for this guard instance. Default: false */
  allowDestructive?: boolean;
}

type SupportedLanguage = 'rust' | 'ts' | 'python' | 'go';

interface ParsedImport {
  /** The full source line(s) of the import statement (newline-joined). */
  raw: string;
  /** Local names this import introduces into the file's scope. */
  names: string[];
}

/** Shape of args we look at — minimal duck typing. */
interface WriteArgs {
  path?: unknown;
  content?: unknown;
  allowDestructive?: unknown;
}

interface EditArgs {
  path?: unknown;
  edits?: unknown;
  allowDestructive?: unknown;
}

function argsOptOut(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  return (args as { allowDestructive?: unknown }).allowDestructive === true;
}

function resolvePath(cwd: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

function tryReadOriginal(absPath: string): string | null {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return null;
    return readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function detectLanguage(path: string): SupportedLanguage | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.rs':
      return 'rust';
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mts':
    case '.cts':
    case '.mjs':
    case '.cjs':
      return 'ts';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    default:
      return null;
  }
}

// --- Rust parser ---

/**
 * Parse a Rust `use` path tail into local names.
 *
 *   `use foo::Bar;`             → ["Bar"]
 *   `use foo::{Bar, Baz};`      → ["Bar", "Baz"]
 *   `use foo::Bar as Quux;`     → ["Quux"]
 *   `use foo::{Bar as Q, Baz};` → ["Q", "Baz"]
 *   `use foo::*;`               → []  (glob — best-effort: no symbol check)
 *   `use foo::self;`            → ["foo"]
 */
function parseRustUseTail(tail: string): string[] {
  const t = tail.trim();
  if (t === '*' || t.endsWith('::*')) return [];

  // Handle `foo::{Bar, Baz}` group at the end.
  const groupMatch = t.match(/\{([^}]+)\}$/);
  if (groupMatch?.[1]) {
    return groupMatch[1]
      .split(',')
      .map((seg) => seg.trim())
      .filter(Boolean)
      .flatMap((seg) => {
        // nested groups (`foo::{bar::{a, b}}`) — best-effort recurse
        if (seg.includes('{')) return parseRustUseTail(seg);
        if (seg === 'self') {
          // `self` inside a group refers to the parent path; pull it from before `::{`
          const before = t.slice(0, groupMatch.index).replace(/::$/, '');
          const last = before.split('::').pop();
          return last ? [last] : [];
        }
        // alias: `Bar as Q` → "Q"
        const asMatch = seg.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (asMatch?.[1]) return [asMatch[1]];
        // plain name
        const nameMatch = seg.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        return nameMatch?.[1] ? [nameMatch[1]] : [];
      });
  }

  // Single path: `foo::Bar`, `foo::Bar as Q`, or `foo`.
  const asMatch = t.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (asMatch?.[1]) return [asMatch[1]];
  const segs = t.split('::');
  const last = segs.pop()?.trim();
  if (!last) return [];
  if (last === 'self') {
    const parent = segs.pop();
    return parent ? [parent] : [];
  }
  return [last];
}

function parseRustImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  // Match `use ...;` possibly spanning lines (until the first `;` after `use `).
  // The simple line-based heuristic is enough: real `use` ends with `;`.
  const lines = source.split('\n');
  let buffer = '';
  let inUse = false;
  let braceDepth = 0;
  for (const line of lines) {
    if (!inUse) {
      const trimmed = line.replace(/^\s*pub\s+use\b/, 'use').trimStart();
      if (trimmed.startsWith('use ')) {
        buffer = line;
        inUse = true;
        braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (line.includes(';') && braceDepth === 0) {
          const useMatch = buffer.match(/\buse\s+(.+);/s);
          if (useMatch?.[1]) imports.push({ raw: buffer, names: parseRustUseTail(useMatch[1]) });
          buffer = '';
          inUse = false;
        }
        continue;
      }
      continue;
    }
    buffer += `\n${line}`;
    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (line.includes(';') && braceDepth === 0) {
      const useMatch = buffer.match(/\buse\s+(.+);/s);
      if (useMatch?.[1]) imports.push({ raw: buffer, names: parseRustUseTail(useMatch[1]) });
      buffer = '';
      inUse = false;
    }
  }
  return imports;
}

// --- TypeScript / JavaScript parser ---

function parseTsImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  // Side-effect import (`import 'foo';`) introduces no names — skip name extraction.
  // Otherwise: default / namespace / named.
  // Pattern intentionally line-greedy: import statements can span multiple lines
  // for named groups, so we match across newlines up to the `from '...';` or `';'` terminator.
  const re = /^\s*import\s+(?:type\s+)?([^'"]+?)\s+from\s+['"][^'"]+['"]\s*;?$/gms;
  let match: RegExpExecArray | null;
  while (true) {
    match = re.exec(source);
    if (match === null) break;
    const clause = match[1];
    if (!clause) continue;
    const names: string[] = [];
    let remainder = clause.trim();

    // namespace: `* as Foo`
    const nsMatch = remainder.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (nsMatch?.[1]) {
      names.push(nsMatch[1]);
      remainder = remainder.replace(nsMatch[0], '').trim();
    }

    // named group: `{ a, b as c, type d }`
    const grpMatch = remainder.match(/\{([^}]+)\}/);
    if (grpMatch?.[1]) {
      for (const seg of grpMatch[1].split(',')) {
        const piece = seg.trim().replace(/^type\s+/, '');
        if (!piece) continue;
        const asMatch = piece.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
        if (asMatch?.[1]) names.push(asMatch[1]);
        else {
          const m = piece.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
          if (m?.[1]) names.push(m[1]);
        }
      }
      remainder = remainder.replace(grpMatch[0], '').trim();
    }

    // default import: leading identifier separated by `,` (or alone)
    const defMatch = remainder.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (defMatch?.[1]) {
      names.push(defMatch[1]);
    }

    imports.push({ raw: match[0], names });
  }
  return imports;
}

// --- Python parser ---

function parsePythonImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // from X import Y, Z as Q
    const fromMatch = trimmed.match(/^from\s+[\w.]+\s+import\s+(.+)$/);
    if (fromMatch?.[1]) {
      const body = fromMatch[1].replace(/[()\\]/g, ' ');
      const names = body
        .split(',')
        .map((seg) => seg.trim())
        .filter(Boolean)
        .map((seg) => {
          const asMatch = seg.match(/\bas\s+(\w+)\s*$/);
          if (asMatch?.[1]) return asMatch[1];
          const nameMatch = seg.match(/^(\w+)/);
          return nameMatch?.[1] ?? '';
        })
        .filter((n) => n && n !== '*');
      imports.push({ raw: line, names });
      continue;
    }

    // import X, Y as Z
    const impMatch = trimmed.match(/^import\s+(.+)$/);
    if (impMatch?.[1]) {
      const names = impMatch[1]
        .split(',')
        .map((seg) => seg.trim())
        .filter(Boolean)
        .map((seg) => {
          const asMatch = seg.match(/\bas\s+(\w+)\s*$/);
          if (asMatch?.[1]) return asMatch[1];
          // `import a.b.c` → local name is `a` (top-level alias)
          const first = seg.split('.')[0]?.trim();
          return first ?? '';
        })
        .filter(Boolean);
      imports.push({ raw: line, names });
    }
  }
  return imports;
}

// --- Go parser ---

function parseGoImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Single-line: `import "fmt"` or `import alias "fmt"`
  const singleRe = /^\s*import\s+(?:([A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?"([^"]+)"\s*$/gm;
  let m: RegExpExecArray | null;
  while (true) {
    m = singleRe.exec(source);
    if (m === null) break;
    const alias = m[1];
    const path = m[2];
    if (!path) continue;
    const name = goLocalName(alias, path);
    imports.push({ raw: m[0], names: name ? [name] : [] });
  }

  // Grouped: `import ( ... )` — each line inside may be aliased.
  const groupRe = /^\s*import\s*\(([^)]*)\)/gm;
  while (true) {
    m = groupRe.exec(source);
    if (m === null) break;
    const body = m[1] ?? '';
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const lm = trimmed.match(/^(?:([A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?"([^"]+)"/);
      if (!lm) continue;
      const alias = lm[1];
      const path = lm[2];
      if (!path) continue;
      const name = goLocalName(alias, path);
      imports.push({ raw: trimmed, names: name ? [name] : [] });
    }
  }

  return imports;
}

function goLocalName(alias: string | undefined, importPath: string): string | null {
  if (alias === '.' || alias === '_') return null; // dot / blank imports don't introduce a usable name
  if (alias) return alias;
  const leaf = importPath.split('/').pop();
  return leaf && leaf.length > 0 ? leaf : null;
}

// --- Dispatch ---

function parseImports(language: SupportedLanguage, source: string): ParsedImport[] {
  switch (language) {
    case 'rust':
      return parseRustImports(source);
    case 'ts':
      return parseTsImports(source);
    case 'python':
      return parsePythonImports(source);
    case 'go':
      return parseGoImports(source);
  }
}

// --- Reference detection ---

const IDENTIFIER_BOUNDARY = /[A-Za-z0-9_$]/;

/**
 * True if `name` appears as a standalone identifier in `body`. Skips occurrences
 * inside other identifiers (e.g. `os` inside `cosmic`) and inside string
 * literals / comments — best-effort: regex-based scrub of obvious cases.
 *
 * `language` selects the comment grammar:
 *   - rust / ts / go: line comments and C-style block comments
 *   - python: hash-line comments and triple-quoted docstrings
 */
function isReferenced(body: string, name: string, language: SupportedLanguage): boolean {
  if (name.length === 0) return false;

  // Strip language-appropriate comments and string literals so a removed `os`
  // doesn't get matched inside a comment "removed os import" or a literal
  // "use os". Conservative: best-effort, not a full lexer.
  let scrubbed = body;
  if (language === 'python') {
    // Triple-quoted strings (docstrings) first, then `#` line comments, then
    // single/double quoted strings.
    scrubbed = scrubbed
      .replace(/"""[\s\S]*?"""/g, '""')
      .replace(/'''[\s\S]*?'''/g, "''")
      .replace(/#[^\n]*/g, '');
  } else {
    // C-style: //, /* ... */. Rust attributes (`#[...]`) are NOT comments.
    scrubbed = scrubbed.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }
  scrubbed = scrubbed
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');

  const needle = name;
  let idx = 0;
  while (true) {
    const found = scrubbed.indexOf(needle, idx);
    if (found === -1) return false;
    const before = found === 0 ? '' : scrubbed[found - 1];
    const after = scrubbed[found + needle.length];
    const beforeOk = !before || !IDENTIFIER_BOUNDARY.test(before);
    const afterOk = !after || !IDENTIFIER_BOUNDARY.test(after);
    if (beforeOk && afterOk) return true;
    idx = found + needle.length;
  }
}

// --- Edit simulation ---

/**
 * Apply an array of `{ oldText, newText }` edits to `source`, in order, to
 * compute the post-edit content.
 *
 * Each edit replaces the first occurrence of `oldText`. If `oldText` is not
 * found, the edit is skipped (mirrors pi-mono's edit-tool failure mode — the
 * actual tool will surface that error; we just want a best-effort simulation).
 */
function applyEdits(source: string, edits: { oldText: string; newText: string }[]): string {
  let result = source;
  for (const edit of edits) {
    const idx = result.indexOf(edit.oldText);
    if (idx === -1) continue;
    result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
  }
  return result;
}

// --- Core check ---

function check(
  language: SupportedLanguage,
  original: string,
  updated: string,
  path: string,
): BeforeToolCallResult | undefined {
  const oldImports = parseImports(language, original);
  const newImports = parseImports(language, updated);

  // Compare by introduced *names*, not raw lines. A name is "removed" if no
  // remaining import statement in the new content reintroduces it. This handles
  // both whole-import removal (`use serde::{...}` → gone) and partial removal
  // (`{ readFile, unused }` → `{ readFile }`).
  const oldNames = new Set(oldImports.flatMap((i) => i.names).filter(Boolean));
  const newNames = new Set(newImports.flatMap((i) => i.names).filter(Boolean));
  const removed = [...oldNames].filter((n) => !newNames.has(n));
  if (removed.length === 0) return undefined;

  // Build the body to scan for references: new content minus its own import
  // lines. Otherwise an import like `import { foo } from 'x'` would count
  // itself as a reference to `foo`.
  let bodyForRefs = updated;
  for (const imp of newImports) {
    bodyForRefs = bodyForRefs.split(imp.raw).join('');
  }

  for (const name of removed) {
    if (!isReferenced(bodyForRefs, name, language)) continue;
    // Find the original import line that introduced this name for the message.
    const sourceImport = oldImports.find((i) => i.names.includes(name));
    const removedLine = sourceImport ? sourceImport.raw.trim() : `(${name})`;
    return {
      block: true,
      reason: [
        `Edit rejected: write to "${path}" removed import "${name}" which is still referenced in the file body.`,
        `Removed from: ${removedLine}`,
        'Either preserve the import or remove all references. If this removal is intentional,',
        'include `allowDestructive: true` in your tool arguments.',
      ].join(' '),
    };
  }
  return undefined;
}

function checkWrite(args: WriteArgs, cwd: string): BeforeToolCallResult | undefined {
  const path = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!path) return undefined;

  const language = detectLanguage(path);
  if (!language) return undefined;

  const absPath = resolvePath(cwd, path);
  const original = tryReadOriginal(absPath);
  if (original == null) return undefined; // new file

  return check(language, original, content, path);
}

function checkEdit(args: EditArgs, cwd: string): BeforeToolCallResult | undefined {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return undefined;
  if (!Array.isArray(args.edits) || args.edits.length === 0) return undefined;

  const validEdits: { oldText: string; newText: string }[] = [];
  for (const edit of args.edits) {
    if (!edit || typeof edit !== 'object') continue;
    const oldText = (edit as { oldText?: unknown }).oldText;
    const newText = (edit as { newText?: unknown }).newText;
    if (typeof oldText === 'string' && typeof newText === 'string') {
      validEdits.push({ oldText, newText });
    }
  }
  if (validEdits.length === 0) return undefined;

  const language = detectLanguage(path);
  if (!language) return undefined;

  const absPath = resolvePath(cwd, path);
  const original = tryReadOriginal(absPath);
  if (original == null) return undefined;

  const updated = applyEdits(original, validEdits);
  return check(language, original, updated, path);
}

/**
 * Create a `beforeToolCall` hook that rejects file edits which strip imports
 * still referenced in the file.
 *
 * Returns `{ block: true, reason: "..." }` to surface a clear error to the
 * model. Returns `undefined` for any tool call that is not a write/edit on a
 * supported-language file, or whenever the check cannot be performed safely
 * (missing file, malformed args, unknown extension).
 *
 * Designed to compose with `createDestructiveEditGuard` — both hooks share
 * the `allowDestructive` opt-out flag.
 */
export function createImportPreservationGuard(
  options: ImportPreservationGuardOptions,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const allowDestructive = options.allowDestructive ?? false;
  const cwd = options.cwd;

  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    if (allowDestructive) return undefined;
    if (argsOptOut(context.args)) return undefined;

    const toolName = context.toolCall?.name;
    if (toolName === 'write') {
      return checkWrite(context.args as WriteArgs, cwd);
    }
    if (toolName === 'edit') {
      return checkEdit(context.args as EditArgs, cwd);
    }
    return undefined;
  };
}
