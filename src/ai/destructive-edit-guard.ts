// beforeToolCall hook — rejects destructive file edits before they execute.
//
// Local models sometimes accidentally delete large portions of files when making
// edits (e.g. wiping a serde import, removing an enum, replacing 325/361 lines of
// an unrelated file). This guard catches the obvious cases at the tool-call gate:
//
// - Write: reject if the new content shrinks the file below `minWriteRatio` of
//   the original size. Default 0.6 (60%).
// - Edit: reject if any single edit deletes more than `minEditDeleteLines` lines
//   while replacing with empty/trivial (whitespace-only) text. Default 20.
//
// The guard is bypassable via either a guard-wide `allowDestructive: true` option
// (for intentional large refactor waves) or a per-call `allowDestructive: true`
// argument injected by the orchestrator.

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

/** Default minimum ratio for Write tool: new content must be >= this fraction of original size. */
export const DEFAULT_MIN_WRITE_RATIO = 0.6;

/** Default line-deletion threshold for Edit tool: any single edit deleting more than this many lines
 * with empty/trivial replacement is rejected. */
export const DEFAULT_MIN_EDIT_DELETE_LINES = 20;

export interface DestructiveEditGuardOptions {
  /** Working directory for resolving relative paths in tool args. */
  cwd: string;
  /** Minimum fraction (0-1) of original file size that the new write must preserve. Default: 0.6 */
  minWriteRatio?: number;
  /** Edits deleting more than this many lines with empty/trivial replacement are rejected. Default: 20 */
  minEditDeleteLines?: number;
  /** Bypass all destructive-edit checks for this guard instance. Default: false */
  allowDestructive?: boolean;
}

/** Shape of args we look at — we don't require the full validated schema. */
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

/** True if a tool-call argument bag opts out of destructive-edit checks. */
function argsOptOut(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  return (args as { allowDestructive?: unknown }).allowDestructive === true;
}

/** Trivial replacement = empty after trim. Whitespace-only counts as trivial. */
function isTrivialReplacement(newText: string): boolean {
  return newText.trim().length === 0;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // Count newlines + 1 for the final line (unless it ends with a newline).
  // Empty string → 0 lines; "a" → 1 line; "a\nb" → 2 lines; "a\nb\n" → 2 lines.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (trimmed.length === 0) return 1;
  return trimmed.split('\n').length;
}

function resolvePath(cwd: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

/** Try to read the original file size in bytes. Returns null if the file is missing or unreadable. */
function tryReadOriginalSize(absPath: string): number | null {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return null;
    return stat.size;
  } catch {
    return null;
  }
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function checkWrite(args: WriteArgs, cwd: string, minWriteRatio: number): BeforeToolCallResult | undefined {
  const path = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!path) return undefined;

  const absPath = resolvePath(cwd, path);
  const originalSize = tryReadOriginalSize(absPath);
  if (originalSize == null || originalSize === 0) {
    // New file or empty file — no shrink to detect.
    return undefined;
  }

  const newSize = Buffer.byteLength(content, 'utf8');
  const ratio = newSize / originalSize;
  if (ratio >= minWriteRatio) return undefined;

  return {
    block: true,
    reason: [
      `Edit rejected: write to "${path}" would shrink the file from ${originalSize} to ${newSize} bytes`,
      `(${formatPct(ratio)} of original, below the ${formatPct(minWriteRatio)} threshold).`,
      'Try again preserving the existing code. If this is an intentional large refactor,',
      'include `allowDestructive: true` in your tool arguments.',
    ].join(' '),
  };
}

function checkEdit(args: EditArgs, minEditDeleteLines: number): BeforeToolCallResult | undefined {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!Array.isArray(args.edits) || args.edits.length === 0) return undefined;

  for (const edit of args.edits) {
    if (!edit || typeof edit !== 'object') continue;
    const oldText = (edit as { oldText?: unknown }).oldText;
    const newText = (edit as { newText?: unknown }).newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') continue;

    if (!isTrivialReplacement(newText)) continue;
    const deletedLines = countLines(oldText);
    if (deletedLines <= minEditDeleteLines) continue;

    return {
      block: true,
      reason: [
        `Edit rejected: edit to "${path || '<unknown>'}" deletes ${deletedLines} lines`,
        `with empty/trivial replacement (threshold: ${minEditDeleteLines}).`,
        'Try again preserving the existing code. If this deletion is intentional,',
        'include `allowDestructive: true` in your tool arguments.',
      ].join(' '),
    };
  }

  return undefined;
}

/**
 * Create a `beforeToolCall` hook that rejects destructive Write/Edit calls.
 *
 * Returns `{ block: true, reason: "..." }` to surface a clear error to the model.
 * Returns `undefined` for any non-destructive call or any tool other than write/edit.
 *
 * The hook is intentionally conservative: when in doubt (missing file, malformed
 * args, unreadable path), it allows the call through — let the tool itself surface
 * the validation error rather than masking it with a spurious block.
 */
export function createDestructiveEditGuard(
  options: DestructiveEditGuardOptions,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const minWriteRatio = options.minWriteRatio ?? DEFAULT_MIN_WRITE_RATIO;
  const minEditDeleteLines = options.minEditDeleteLines ?? DEFAULT_MIN_EDIT_DELETE_LINES;
  const allowDestructive = options.allowDestructive ?? false;
  const cwd = options.cwd;

  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    if (allowDestructive) return undefined;
    if (argsOptOut(context.args)) return undefined;

    const toolName = context.toolCall?.name;
    if (toolName === 'write') {
      return checkWrite(context.args as WriteArgs, cwd, minWriteRatio);
    }
    if (toolName === 'edit') {
      return checkEdit(context.args as EditArgs, minEditDeleteLines);
    }
    return undefined;
  };
}
