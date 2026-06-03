// Codegraph-backed orchestration checks — extracted from fix.ts (issue #435).
//
// Three helpers, all keyed off the same `.kova/codegraph.db` and all
// gracefully degrading when the graph is unavailable / unindexed:
//
//   1. probeDependencyOverlap — cross-piece call/import edges (#276 spec gate).
//   2. buildRegressionSurface  — dependents of changed files (#276 review context).
//   3. probeShipPreflightOverlaps — pre-ship dependency-overlap WARNING (#276 ship).
//
// Pure helpers — each opens the DB, runs its query, closes, and returns.
// Every IO failure is logged + swallowed so the orchestrator's flow control
// is never gated on codegraph availability.

import { join as joinPath } from 'node:path';
import { $ } from 'zx';
import { openCodegraph } from '../codegraph/index.js';
import type { SpecPiece } from '../types/index.js';
import { checkForConflicts } from '../vcs/conflict-check.js';
import { detectDefaultBranch, getChangedFiles } from '../vcs/worktree.js';
import { formatRegressionSurface } from './regression-surface.js';
import { detectDependencyOverlaps } from './spec-validator.js';

$.verbose = false;

export interface CodegraphCheckLogger {
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
}

/**
 * Probe cross-piece dependency edges in the codegraph (#276). Returns `true`
 * when at least one edge is found — the caller should force serial execution.
 * Returns `false` on graceful failure (codegraph unavailable) so the spec's
 * file-overlap-only fallback continues to work.
 */
export function probeDependencyOverlap(input: {
  pieces: SpecPiece[];
  repoPath: string;
  logger: CodegraphCheckLogger;
}): boolean {
  const { pieces, repoPath, logger } = input;
  if (pieces.length < 2) return false;
  try {
    const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
    const cg = openCodegraph(dbPath);
    try {
      const depOverlaps = detectDependencyOverlaps(pieces, {
        listFileSymbols: (fp) => cg.listFileSymbols(fp),
        getCallers: (id) => cg.getCallers(id),
      });
      if (depOverlaps.length === 0) return false;
      const sampleNames = depOverlaps
        .slice(0, 3)
        .map((o) => `${o.sourcePieceName}->${o.dependentPieceName}(${o.symbolName})`)
        .join(', ');
      logger.warn(
        `[fix] Dependency-overlap detected (${depOverlaps.length} cross-piece edge(s): ${sampleNames}) — forcing serial execution`,
      );
      return true;
    } finally {
      cg.close();
    }
  } catch (err) {
    logger.debug(`[fix] dependency-overlap probe degraded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Build the regression-surface context (#276) — for each changed file, list
 * callers + importers so the reviewer can verify behavioral consistency at
 * each dependent. Returns undefined when no changed files / graph empty /
 * any IO failure. Caller passes the result through to the review wave.
 */
export async function buildRegressionSurface(input: {
  workDir: string;
  repoPath: string;
  logger: CodegraphCheckLogger;
}): Promise<string | undefined> {
  const { workDir, repoPath, logger } = input;
  try {
    const changedFiles = await getChangedFiles(workDir);
    if (changedFiles.length === 0) return undefined;
    const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
    const cg = openCodegraph(dbPath);
    try {
      const formatted = formatRegressionSurface({
        lookup: {
          listFileSymbols: (fp) => cg.listFileSymbols(fp),
          getCallers: (id) => cg.getCallers(id),
          getFileDependents: (fp) => cg.getFileDependents(fp),
        },
        changedFiles,
      });
      if (formatted.length === 0) return undefined;
      logger.info(`[regression-surface] injected (${changedFiles.length} changed files, ${formatted.length} chars)`);
      return formatted;
    } finally {
      cg.close();
    }
  } catch (err) {
    logger.warn(
      `[regression-surface] degraded — proceeding without surface context: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Pre-ship dependency-overlap WARNING (#276). Pure observation — does not
 * block the ship. Logs the cross-file dependent set so reviewers see the
 * impact before merge. The ship engine runs its own conflict-check
 * internally; this hook surfaces graph-aware dependents separately.
 */
export async function probeShipPreflightOverlaps(input: {
  workDir: string;
  repoPath: string;
  specFiles: string[];
  logger: CodegraphCheckLogger;
}): Promise<void> {
  const { workDir, repoPath, specFiles, logger } = input;
  try {
    const defaultBranch = await detectDefaultBranch(workDir);
    const committedDiff = await $`git -C ${workDir} diff --name-only origin/${defaultBranch}...HEAD`.nothrow();
    const committed = committedDiff.exitCode === 0 ? committedDiff.stdout.trim().split('\n').filter(Boolean) : [];
    const uncommitted = await getChangedFiles(workDir);
    const allChangedFiles = [...new Set([...committed, ...uncommitted])];

    if (allChangedFiles.length === 0) return;

    const dbPath = joinPath(repoPath, '.kova', 'codegraph.db');
    const cg = openCodegraph(dbPath);
    try {
      const preCheck = await checkForConflicts(workDir, specFiles, {
        dependencyLookup: {
          listFileSymbols: (fp) => cg.listFileSymbols(fp),
          getFileDependents: (fp) => cg.getFileDependents(fp),
        },
        changedFiles: allChangedFiles,
      });
      if (preCheck.dependencyOverlaps.length > 0) {
        const sample = preCheck.dependencyOverlaps
          .slice(0, 3)
          .map((d) => `${d.sourceFile}->${d.dependentFile}`)
          .join(', ');
        logger.warn(
          `[conflict-check] dependency-overlap surfaced (${preCheck.dependencyOverlaps.length} edge(s): ${sample}) — review the dependents before merging`,
        );
      }
    } finally {
      cg.close();
    }
  } catch (err) {
    logger.debug(`[conflict-check] dependency wiring degraded: ${err instanceof Error ? err.message : String(err)}`);
  }
}
