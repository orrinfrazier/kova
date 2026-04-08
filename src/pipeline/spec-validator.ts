import type { SpecPiece } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface FileOverlap {
  file: string;
  pieceIndices: number[];
  pieceNames: string[];
}

export interface ValidationResult {
  valid: boolean;
  overlaps: FileOverlap[];
  pieces: SpecPiece[];
  dependencyOrder: number[][];
}

/**
 * Validate that no file appears in more than one spec piece.
 * If overlap is detected, merge overlapping pieces into one (preferred over serialization).
 * Returns the (possibly merged) pieces and updated dependency_order.
 */
export function validatePieceFileOwnership(pieces: SpecPiece[], dependencyOrder: number[][]): ValidationResult {
  if (pieces.length <= 1) {
    return { valid: true, overlaps: [], pieces, dependencyOrder };
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
    return { valid: true, overlaps: [], pieces, dependencyOrder };
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
    overlaps,
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
