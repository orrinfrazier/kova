import type { SymbolNode } from '../types/codegraph.js';
import type { SpecPiece } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface FileOverlap {
  file: string;
  pieceIndices: number[];
  pieceNames: string[];
}

export interface PendingPRConflict {
  file: string;
  pieceName: string;
  pieceIndex: number;
}

/**
 * A dependency edge between two spec pieces with disjoint file sets.
 *
 * Issue #276 — captures the case where two pieces touch no shared file but a
 * symbol defined in piece A is called from a file in piece B. Running A and B
 * concurrently risks collision (rename → unresolved import; signature change →
 * type error) that file-overlap detection alone misses.
 */
export interface DependencyOverlap {
  /** Symbol name defined in the source piece. */
  symbolName: string;
  /** File path of the symbol's definition (member of the source piece's files). */
  sourceFile: string;
  /** Index of the piece that defines the symbol. */
  sourcePieceIndex: number;
  /** Name of the piece that defines the symbol. */
  sourcePieceName: string;
  /** File path of the dependent caller (member of the dependent piece's files). */
  dependentFile: string;
  /** Index of the piece that contains the caller. */
  dependentPieceIndex: number;
  /** Name of the piece that contains the caller. */
  dependentPieceName: string;
}

/**
 * Read-only slice of the codegraph store used by {@link detectDependencyOverlaps}.
 *
 * Intentionally narrower than `CodegraphHandle` so tests can construct a tiny
 * in-memory fake without taking a dependency on SQLite. Production callers
 * pass an adapter over `openCodegraph()` that satisfies this interface
 * structurally — see `src/pipeline/fix.ts`.
 */
export interface DependencyOverlapLookup {
  /** Symbols defined in the given file. */
  listFileSymbols: (filePath: string) => SymbolNode[];
  /** Symbols whose outgoing `calls` edges point at the given node. */
  getCallers: (nodeId: string) => SymbolNode[];
}

export interface ValidationResult {
  valid: boolean;
  /**
   * True iff piece-to-piece overlapping was detected AND merging produced a
   * different (smaller) piece set than the input. Callers use this to decide
   * whether to persist the merged result back to the spec artifact and skip
   * a spec retry. Pending-PR conflicts alone do NOT set this — they require
   * a real spec re-run.
   */
  merged: boolean;
  overlaps: FileOverlap[];
  pendingPRConflicts: PendingPRConflict[];
  pieces: SpecPiece[];
  dependencyOrder: number[][];
}

/**
 * Validate that no file appears in more than one spec piece, and that no piece
 * modifies files already touched by pending PRs.
 * If piece-to-piece overlap is detected, merge overlapping pieces into one.
 * Returns the (possibly merged) pieces, updated dependency_order, and any pending PR conflicts.
 */
export function validatePieceFileOwnership(
  pieces: SpecPiece[],
  dependencyOrder: number[][],
  pendingPRFiles?: string[],
): ValidationResult {
  // Detect pending PR conflicts
  const pendingPRConflicts = detectPendingPRConflicts(pieces, pendingPRFiles);

  if (pieces.length <= 1) {
    return {
      valid: pendingPRConflicts.length === 0,
      merged: false,
      overlaps: [],
      pendingPRConflicts,
      pieces,
      dependencyOrder,
    };
  }

  // Step 1: Detect overlaps — build file → piece indices map
  const fileOwners = new Map<string, number[]>();
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    for (const file of piece.files) {
      const owners = fileOwners.get(file);
      if (owners) {
        owners.push(i);
      } else {
        fileOwners.set(file, [i]);
      }
    }
  }

  const overlaps: FileOverlap[] = [];
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      overlaps.push({
        file,
        pieceIndices: owners,
        pieceNames: owners.map((i) => pieces[i]?.name ?? `piece-${i}`),
      });
    }
  }

  if (overlaps.length === 0) {
    return {
      valid: pendingPRConflicts.length === 0,
      merged: false,
      overlaps: [],
      pendingPRConflicts,
      pieces,
      dependencyOrder,
    };
  }

  // Log warnings
  for (const overlap of overlaps) {
    log.warn(`[spec-validator] File "${overlap.file}" owned by multiple pieces: [${overlap.pieceNames.join(', ')}]`);
  }

  // Step 2: Build merge groups using union-find
  const parent = Array.from({ length: pieces.length }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x] ?? x] ?? x; // path compression
      x = parent[x] ?? x;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  }

  // Union all pieces that share any file
  for (const overlap of overlaps) {
    const first = overlap.pieceIndices[0];
    if (first === undefined) continue;
    for (let i = 1; i < overlap.pieceIndices.length; i++) {
      const idx = overlap.pieceIndices[i];
      if (idx !== undefined) {
        union(first, idx);
      }
    }
  }

  // Step 3: Collect merge groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < pieces.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(i);
    } else {
      groups.set(root, [i]);
    }
  }

  // Step 4: Merge pieces within each group
  const mergedPieces: SpecPiece[] = [];
  const oldToNew = new Map<number, number>();

  for (const members of groups.values()) {
    const newIndex = mergedPieces.length;
    for (const m of members) {
      oldToNew.set(m, newIndex);
    }

    if (members.length === 1) {
      const piece = pieces[members[0] ?? 0];
      if (piece) mergedPieces.push(piece);
    } else {
      mergedPieces.push(mergePieces(members.map((i) => pieces[i]).filter((p): p is SpecPiece => p != null)));
    }
  }

  // Step 5: Rebuild dependency_order with new indices
  const newDependencyOrder: number[][] = [];
  for (const batch of dependencyOrder) {
    const newBatch = new Set<number>();
    for (const oldIdx of batch) {
      const newIdx = oldToNew.get(oldIdx);
      if (newIdx !== undefined) {
        newBatch.add(newIdx);
      }
    }
    if (newBatch.size > 0) {
      newDependencyOrder.push([...newBatch]);
    }
  }

  // Deduplicate: a merged piece might appear in multiple batches.
  // Keep it only in the latest batch (respects dependencies).
  const seenInBatch = new Map<number, number>(); // pieceIdx → last batch index
  for (let b = 0; b < newDependencyOrder.length; b++) {
    const batch = newDependencyOrder[b];
    if (!batch) continue;
    for (const idx of batch) {
      seenInBatch.set(idx, b);
    }
  }

  const deduped: number[][] = [];
  for (let b = 0; b < newDependencyOrder.length; b++) {
    const batch = newDependencyOrder[b];
    if (!batch) continue;
    const kept = batch.filter((idx) => seenInBatch.get(idx) === b);
    if (kept.length > 0) {
      deduped.push(kept);
    }
  }

  log.info(
    `[spec-validator] Merged ${pieces.length} pieces → ${mergedPieces.length} after resolving ${overlaps.length} file overlap(s)`,
  );

  return {
    valid: false,
    merged: mergedPieces.length < pieces.length,
    overlaps,
    pendingPRConflicts,
    pieces: mergedPieces,
    dependencyOrder: deduped,
  };
}

/**
 * Format file overlap information into a feedback message for spec re-run.
 * Returns an empty string if there are no overlaps.
 */
export function formatOverlapFeedback(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) return '';

  const lines = overlaps.map(
    (o) => `Pieces [${o.pieceNames.join(', ')}] both modify "${o.file}". Decompose so each piece owns disjoint files.`,
  );

  return `## File Ownership Feedback\n\nThe previous spec had overlapping file ownership between pieces. Each piece must own a disjoint set of files to allow safe parallel execution.\n\n${lines.join('\n')}`;
}

function detectPendingPRConflicts(pieces: SpecPiece[], pendingPRFiles?: string[]): PendingPRConflict[] {
  if (!pendingPRFiles || pendingPRFiles.length === 0) return [];

  const prFileSet = new Set(pendingPRFiles);
  const conflicts: PendingPRConflict[] = [];

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    for (const file of piece.files) {
      if (prFileSet.has(file)) {
        conflicts.push({ file, pieceName: piece.name, pieceIndex: i });
      }
    }
  }

  return conflicts;
}

/**
 * Format pending PR conflict information into a feedback message for spec re-run.
 * Returns an empty string if there are no conflicts.
 */
export function formatPendingPRConflictFeedback(conflicts: PendingPRConflict[]): string {
  if (conflicts.length === 0) return '';

  const lines = conflicts.map(
    (c) =>
      `Piece "${c.pieceName}" modifies "${c.file}" which is already changed by a pending PR. Restructure to avoid this file.`,
  );

  return `## Pending PR Conflict Feedback\n\nThe spec includes pieces that modify files already changed by open PRs. Restructure pieces to avoid these files, or use different files to achieve the same goal.\n\n${lines.join('\n')}`;
}

/**
 * Detect cross-piece dependency edges via the codegraph (#276).
 *
 * For each piece, walk the symbols defined in its files. If any caller of
 * those symbols lives in a different piece's files, flag a dependency overlap.
 * Pure function — takes the lookup; never opens a DB or reads a file.
 *
 * Returns `[]` when the lookup yields no symbols for any piece (graceful
 * on missing index) or when no cross-piece edges exist.
 *
 * Per-file/per-symbol exceptions from the lookup are swallowed so a single
 * bad entry does not blank the whole result. The function never throws to
 * the caller.
 */
export function detectDependencyOverlaps(pieces: SpecPiece[], lookup: DependencyOverlapLookup): DependencyOverlap[] {
  if (pieces.length <= 1) return [];

  // Build file → piece index map. Symbols defined in `file` belong to that piece.
  const fileToPiece = new Map<string, number>();
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    for (const file of piece.files) {
      fileToPiece.set(file, i);
    }
  }

  const overlaps: DependencyOverlap[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    for (const file of piece.files) {
      let symbols: SymbolNode[];
      try {
        symbols = lookup.listFileSymbols(file);
      } catch (err) {
        log.debug(
          `[spec-validator] dependency-overlap: listFileSymbols threw for "${file}" — skipping: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const sym of symbols) {
        let callers: SymbolNode[];
        try {
          callers = lookup.getCallers(sym.id);
        } catch {
          continue;
        }

        for (const caller of callers) {
          const callerPiece = fileToPiece.get(caller.filePath);
          if (callerPiece === undefined || callerPiece === i) continue;

          const dependentPiece = pieces[callerPiece];
          if (!dependentPiece) continue;

          const key = `${i}:${file}:${sym.name}->${callerPiece}:${caller.filePath}`;
          if (seen.has(key)) continue;
          seen.add(key);

          overlaps.push({
            symbolName: sym.name,
            sourceFile: file,
            sourcePieceIndex: i,
            sourcePieceName: piece.name,
            dependentFile: caller.filePath,
            dependentPieceIndex: callerPiece,
            dependentPieceName: dependentPiece.name,
          });
        }
      }
    }
  }

  return overlaps;
}

/**
 * Format dependency-overlap information into a feedback message for spec re-run
 * or for surfacing in a conflict report. Returns `''` when there are no overlaps.
 */
export function formatDependencyOverlapFeedback(overlaps: DependencyOverlap[]): string {
  if (overlaps.length === 0) return '';

  const lines = overlaps.map(
    (o) =>
      `Piece "${o.sourcePieceName}" defines \`${o.symbolName}\` (in ${o.sourceFile}) but piece "${o.dependentPieceName}" calls it (from ${o.dependentFile}). Running these pieces concurrently risks a rename/signature collision.`,
  );

  return `## Dependency Overlap Feedback (#276)\n\nThe spec includes pieces whose files are disjoint but linked by a call/import edge in the codegraph. Restructure to serialize the coupled pieces, or merge them so a single piece owns both ends of the edge.\n\n${lines.join('\n')}`;
}

function mergePieces(toMerge: SpecPiece[]): SpecPiece {
  const names = toMerge.map((p) => p.name);
  const allFiles = new Set<string>();
  const allCriteria: string[] = [];
  const allWiring = new Set<string>();
  const descriptions: string[] = [];

  for (const piece of toMerge) {
    for (const f of piece.files) allFiles.add(f);
    allCriteria.push(...piece.acceptance_criteria);
    for (const w of piece.wiring) allWiring.add(w);
    descriptions.push(piece.description);
  }

  return {
    name: names.join(' + '),
    description: descriptions.join('; '),
    files: [...allFiles],
    acceptance_criteria: allCriteria,
    wiring: [...allWiring],
  };
}
