// Regression-surface helper (#276).
//
// Given a set of files changed in the worktree and a codegraph lookup, build a
// capped markdown section listing dependents of the changed code: direct
// callers of changed symbols, and files that import the changed file. The
// review wave consumes this so the reviewer can verify each dependent rather
// than relying on local diff context alone.
//
// Pure function — takes a `RegressionSurfaceLookup` (three read methods) and a
// file list. Returns `''` when no dependents resolve so the existing
// `sections.join('\n\n')` in `buildReviewContext` filters it out (zero
// prompt noise on the no-graph / no-dependents path).

import type { SymbolNode } from '../types/codegraph.js';
import { log } from '../utils/logger.js';

/**
 * Read-only slice of the codegraph store used by {@link formatRegressionSurface}.
 *
 * Intentionally narrower than `CodegraphHandle` so tests can construct a tiny
 * in-memory fake without taking a dependency on SQLite. Production callers
 * pass an adapter over `openCodegraph()` that satisfies this interface
 * structurally — see `src/pipeline/fix.ts`.
 */
export interface RegressionSurfaceLookup {
  /** Symbols defined in the given file (typically `SELECT * FROM nodes WHERE file_path = ?`). */
  listFileSymbols: (filePath: string) => SymbolNode[];
  /** Symbols whose outgoing `calls` edges point at the given node. */
  getCallers: (nodeId: string) => SymbolNode[];
  /** Files that import (directly) from the given file path. */
  getFileDependents: (filePath: string) => string[];
}

export interface FormatRegressionSurfaceOptions {
  lookup: RegressionSurfaceLookup;
  /** Files changed in the worktree (e.g. `git diff --name-only base..HEAD`). */
  changedFiles: string[];
  /** Max changed files rendered (default 8). Prevents prompt-section blowup on wide diffs. */
  maxChangedFiles?: number;
  /** Max dependents (callers + importers, combined) rendered per changed file (default 10). */
  maxDependentsPerFile?: number;
  /** Max distinct symbols-per-file walked for callers (default 5). */
  maxSymbolsPerFile?: number;
}

/**
 * Build the '## Regression Surface (affected dependents)' markdown section.
 *
 * Returns `''` when there are no changed files, the lookup yields no symbols,
 * or no dependents are resolved. The empty string is filtered out by the
 * `sections.join('\n\n')` in `buildReviewContext`.
 *
 * Graceful per-file: if `listFileSymbols` throws for one file, the remaining
 * files still produce output. The whole section never throws to the caller.
 */
export function formatRegressionSurface(opts: FormatRegressionSurfaceOptions): string {
  const { lookup, changedFiles, maxChangedFiles = 8, maxDependentsPerFile = 10, maxSymbolsPerFile = 5 } = opts;

  if (changedFiles.length === 0) return '';

  const capped = changedFiles.slice(0, maxChangedFiles);
  const truncatedFileCount = changedFiles.length - capped.length;

  const fileSections: string[] = [];

  for (const file of capped) {
    let symbols: SymbolNode[];
    try {
      symbols = lookup.listFileSymbols(file).slice(0, maxSymbolsPerFile);
    } catch (err) {
      log.debug(
        `[regression-surface] listFileSymbols threw for "${file}" — skipping: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (symbols.length === 0) continue;

    // Collect dependents: direct callers per symbol + importers of the file.
    const dependents: string[] = [];
    const seen = new Set<string>();

    for (const sym of symbols) {
      let callers: SymbolNode[];
      try {
        callers = lookup.getCallers(sym.id);
      } catch {
        callers = [];
      }
      for (const c of callers) {
        const key = `${c.filePath}:${c.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          dependents.push(`- \`${c.name}\` in \`${c.filePath}\` calls \`${sym.name}\``);
        }
      }
    }

    let importers: string[];
    try {
      importers = lookup.getFileDependents(file);
    } catch {
      importers = [];
    }
    for (const importer of importers) {
      const key = `${importer}:<imports>`;
      if (!seen.has(key)) {
        seen.add(key);
        dependents.push(`- \`${importer}\` imports from \`${file}\``);
      }
    }

    if (dependents.length === 0) continue;

    const cappedDependents = dependents.slice(0, maxDependentsPerFile);
    const moreDependentCount = dependents.length - cappedDependents.length;

    const symbolList = symbols.map((s) => `\`${s.name}\``).join(', ');
    const lines = [`### \`${file}\``, `Changed symbols: ${symbolList}`, '', ...cappedDependents];
    if (moreDependentCount > 0) {
      lines.push(`- … and ${moreDependentCount} more dependent(s)`);
    }
    fileSections.push(lines.join('\n'));
  }

  if (fileSections.length === 0) return '';

  const header = [
    '## Regression Surface (affected dependents)',
    '',
    'Symbols and files that depend on the changes below. Verify each dependent for behavioral consistency with the change — a renamed export, a tightened signature, or a moved invariant can silently break a dependent that the diff alone will not surface.',
  ].join('\n');

  let footer = '';
  if (truncatedFileCount > 0) {
    footer = `\n\n_… and ${truncatedFileCount} additional changed file(s) omitted from this surface (capped at ${maxChangedFiles}). Inspect the diff for the full file list._`;
  }

  return `${header}\n\n${fileSections.join('\n\n')}${footer}`;
}
