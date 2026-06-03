import { describe, expect, it } from 'vitest';
import type { SymbolNode } from '../types/codegraph.js';
import type { SpecPiece } from '../types/index.js';
import {
  type DependencyOverlapLookup,
  detectDependencyOverlaps,
  formatDependencyOverlapFeedback,
  formatOverlapFeedback,
  formatPendingPRConflictFeedback,
  validatePieceFileOwnership,
} from './spec-validator.js';

function makePiece(name: string, files: string[], criteria?: string[]): SpecPiece {
  return {
    name,
    description: `${name} description`,
    files,
    acceptance_criteria: criteria ?? [`AC for ${name}`],
    wiring: [],
  };
}

describe('validatePieceFileOwnership', () => {
  it('single piece passes trivially', () => {
    const pieces = [makePiece('auth', ['src/auth.ts'])];
    const result = validatePieceFileOwnership(pieces, [[0]]);

    expect(result.valid).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.overlaps).toHaveLength(0);
    expect(result.pieces).toEqual(pieces);
    expect(result.dependencyOrder).toEqual([[0]]);
  });

  it('no overlap — pieces with disjoint files pass', () => {
    const pieces = [
      makePiece('auth', ['src/auth.ts']),
      makePiece('db', ['src/db.ts']),
      makePiece('api', ['src/api.ts']),
    ];
    const result = validatePieceFileOwnership(pieces, [[0, 1], [2]]);

    expect(result.valid).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.overlaps).toHaveLength(0);
    expect(result.pieces).toEqual(pieces);
    expect(result.dependencyOrder).toEqual([[0, 1], [2]]);
  });

  it('partial overlap — merges overlapping pieces', () => {
    const pieces = [
      makePiece('auth', ['src/auth.ts', 'src/shared.ts']),
      makePiece('db', ['src/db.ts', 'src/shared.ts']),
      makePiece('api', ['src/api.ts']),
    ];
    const result = validatePieceFileOwnership(pieces, [[0, 1, 2]]);

    expect(result.valid).toBe(false);
    expect(result.merged).toBe(true);
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]?.file).toBe('src/shared.ts');
    expect(result.overlaps[0]?.pieceNames).toContain('auth');
    expect(result.overlaps[0]?.pieceNames).toContain('db');

    // Should merge auth + db into one piece, api stays separate
    expect(result.pieces).toHaveLength(2);
    const merged = result.pieces.find((p) => p.name.includes('auth') && p.name.includes('db'));
    expect(merged).toBeDefined();
    expect(merged?.files).toContain('src/auth.ts');
    expect(merged?.files).toContain('src/db.ts');
    expect(merged?.files).toContain('src/shared.ts');
    // No duplicates in merged files
    expect(new Set(merged?.files).size).toBe(merged?.files.length);
  });

  it('full overlap — all pieces share files, merges into one', () => {
    const pieces = [
      makePiece('a', ['src/core.ts', 'src/utils.ts']),
      makePiece('b', ['src/core.ts', 'src/helpers.ts']),
      makePiece('c', ['src/utils.ts', 'src/helpers.ts']),
    ];
    const result = validatePieceFileOwnership(pieces, [[0, 1, 2]]);

    expect(result.valid).toBe(false);
    expect(result.overlaps.length).toBeGreaterThanOrEqual(1);

    // All three should merge into one piece
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]?.files).toContain('src/core.ts');
    expect(result.pieces[0]?.files).toContain('src/utils.ts');
    expect(result.pieces[0]?.files).toContain('src/helpers.ts');
    // dependency_order should reference only index 0
    expect(result.dependencyOrder).toEqual([[0]]);
  });

  it('merges acceptance criteria and wiring from overlapping pieces', () => {
    const pieces = [
      {
        ...makePiece('auth', ['src/shared.ts'], ['AC1']),
        wiring: ['wire1'],
      },
      {
        ...makePiece('db', ['src/shared.ts'], ['AC2']),
        wiring: ['wire2'],
      },
    ];
    const result = validatePieceFileOwnership(pieces, [[0, 1]]);

    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]?.acceptance_criteria).toContain('AC1');
    expect(result.pieces[0]?.acceptance_criteria).toContain('AC2');
    expect(result.pieces[0]?.wiring).toContain('wire1');
    expect(result.pieces[0]?.wiring).toContain('wire2');
  });

  it('updates dependency_order indices after merge', () => {
    // pieces 0 and 1 overlap, piece 2 depends on them
    const pieces = [
      makePiece('auth', ['src/shared.ts']),
      makePiece('db', ['src/shared.ts']),
      makePiece('api', ['src/api.ts']),
    ];
    const result = validatePieceFileOwnership(pieces, [[0, 1], [2]]);

    expect(result.pieces).toHaveLength(2);
    // After merge: merged piece at 0, api at 1
    // dependency_order should reflect new indices
    expect(result.dependencyOrder).toEqual([[0], [1]]);
  });

  it('overlap across different batches — merges and reorders', () => {
    const pieces = [
      makePiece('a', ['src/shared.ts']),
      makePiece('b', ['src/other.ts']),
      makePiece('c', ['src/shared.ts', 'src/c.ts']),
    ];
    // a in batch 0, b+c in batch 1
    const result = validatePieceFileOwnership(pieces, [[0, 1], [2]]);

    expect(result.valid).toBe(false);
    // a and c overlap on shared.ts — they should merge
    const merged = result.pieces.find((p) => p.files.includes('src/shared.ts') && p.files.includes('src/c.ts'));
    expect(merged).toBeDefined();
    // The merged piece must be in the latest batch (batch 1) since c depended on batch 0
    expect(result.pieces.length).toBe(2);
  });

  it('empty pieces array passes trivially', () => {
    const result = validatePieceFileOwnership([], []);
    expect(result.valid).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.overlaps).toHaveLength(0);
    expect(result.pieces).toEqual([]);
    expect(result.dependencyOrder).toEqual([]);
  });

  it('sets merged=true when a piece-to-piece merge occurred', () => {
    const pieces = [makePiece('a', ['src/shared.ts']), makePiece('b', ['src/shared.ts'])];
    const result = validatePieceFileOwnership(pieces, [[0, 1]]);

    expect(result.merged).toBe(true);
    expect(result.pieces).toHaveLength(1);
  });

  it('sets merged=false when only pending PR conflicts exist (no piece-to-piece overlap)', () => {
    const pieces = [makePiece('a', ['src/auth.ts']), makePiece('b', ['src/db.ts'])];
    const pendingPRFiles = ['src/auth.ts'];
    const result = validatePieceFileOwnership(pieces, [[0, 1]], pendingPRFiles);

    expect(result.merged).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.pendingPRConflicts).toHaveLength(1);
  });

  it('reports all overlapping files', () => {
    const pieces = [makePiece('a', ['src/x.ts', 'src/y.ts']), makePiece('b', ['src/x.ts', 'src/y.ts'])];
    const result = validatePieceFileOwnership(pieces, [[0, 1]]);

    expect(result.overlaps).toHaveLength(2);
    const files = result.overlaps.map((o) => o.file).sort();
    expect(files).toEqual(['src/x.ts', 'src/y.ts']);
  });
});

describe('formatOverlapFeedback', () => {
  it('formats single overlap into feedback message', () => {
    const overlaps = [{ file: 'src/shared.ts', pieceIndices: [0, 1], pieceNames: ['auth', 'db'] }];
    const msg = formatOverlapFeedback(overlaps);

    expect(msg).toContain('auth');
    expect(msg).toContain('db');
    expect(msg).toContain('src/shared.ts');
    expect(msg).toContain('disjoint');
  });

  it('formats multiple overlaps', () => {
    const overlaps = [
      { file: 'src/shared.ts', pieceIndices: [0, 1], pieceNames: ['auth', 'db'] },
      { file: 'src/utils.ts', pieceIndices: [1, 2], pieceNames: ['db', 'api'] },
    ];
    const msg = formatOverlapFeedback(overlaps);

    expect(msg).toContain('src/shared.ts');
    expect(msg).toContain('src/utils.ts');
    expect(msg).toContain('auth');
    expect(msg).toContain('db');
    expect(msg).toContain('api');
  });

  it('returns empty string for no overlaps', () => {
    expect(formatOverlapFeedback([])).toBe('');
  });
});

describe('validatePieceFileOwnership — pending PR conflicts', () => {
  it('detects overlap between spec piece and pending PR files', () => {
    const pieces = [makePiece('auth', ['src/auth.ts', 'src/middleware.ts']), makePiece('db', ['src/db.ts'])];
    const pendingPRFiles = ['src/middleware.ts', 'src/other.ts'];
    const result = validatePieceFileOwnership(pieces, [[0, 1]], pendingPRFiles);

    expect(result.pendingPRConflicts).toHaveLength(1);
    expect(result.pendingPRConflicts[0]?.file).toBe('src/middleware.ts');
    expect(result.pendingPRConflicts[0]?.pieceName).toBe('auth');
    expect(result.pendingPRConflicts[0]?.pieceIndex).toBe(0);
    // Piece-to-piece ownership is valid, but pending PR conflict makes it invalid
    expect(result.valid).toBe(false);
  });

  it('passes when no spec piece files overlap with pending PR files', () => {
    const pieces = [makePiece('auth', ['src/auth.ts']), makePiece('db', ['src/db.ts'])];
    const pendingPRFiles = ['src/other.ts', 'src/unrelated.ts'];
    const result = validatePieceFileOwnership(pieces, [[0, 1]], pendingPRFiles);

    expect(result.pendingPRConflicts).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('detects multiple pieces conflicting with pending PRs', () => {
    const pieces = [makePiece('auth', ['src/shared.ts']), makePiece('db', ['src/shared.ts', 'src/config.ts'])];
    const pendingPRFiles = ['src/config.ts'];
    const result = validatePieceFileOwnership(pieces, [[0, 1]], pendingPRFiles);

    // Piece-to-piece overlap on shared.ts AND pending PR conflict on config.ts
    expect(result.overlaps).toHaveLength(1);
    expect(result.pendingPRConflicts).toHaveLength(1);
    expect(result.pendingPRConflicts[0]?.file).toBe('src/config.ts');
    expect(result.pendingPRConflicts[0]?.pieceName).toBe('db');
    expect(result.valid).toBe(false);
  });

  it('reports all conflicting files for a single piece', () => {
    const pieces = [makePiece('auth', ['src/a.ts', 'src/b.ts', 'src/c.ts'])];
    const pendingPRFiles = ['src/a.ts', 'src/c.ts'];
    const result = validatePieceFileOwnership(pieces, [[0]], pendingPRFiles);

    expect(result.pendingPRConflicts).toHaveLength(2);
    const files = result.pendingPRConflicts.map((c) => c.file).sort();
    expect(files).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('returns empty pendingPRConflicts when pendingPRFiles is undefined', () => {
    const pieces = [makePiece('auth', ['src/auth.ts'])];
    const result = validatePieceFileOwnership(pieces, [[0]]);

    expect(result.pendingPRConflicts).toHaveLength(0);
  });

  it('returns empty pendingPRConflicts when pendingPRFiles is empty', () => {
    const pieces = [makePiece('auth', ['src/auth.ts'])];
    const result = validatePieceFileOwnership(pieces, [[0]], []);

    expect(result.pendingPRConflicts).toHaveLength(0);
  });

  it('does not affect piece merging behavior', () => {
    // Pieces overlap with each other AND with pending PRs — merging still works
    const pieces = [
      makePiece('auth', ['src/shared.ts', 'src/auth.ts']),
      makePiece('db', ['src/shared.ts', 'src/db.ts']),
    ];
    const pendingPRFiles = ['src/auth.ts'];
    const result = validatePieceFileOwnership(pieces, [[0, 1]], pendingPRFiles);

    // Piece-to-piece merge still happens
    expect(result.pieces).toHaveLength(1);
    expect(result.overlaps).toHaveLength(1);
    // Pending PR conflict still reported
    expect(result.pendingPRConflicts).toHaveLength(1);
    expect(result.pendingPRConflicts[0]?.file).toBe('src/auth.ts');
  });
});

describe('formatPendingPRConflictFeedback', () => {
  it('formats conflicts into feedback message', () => {
    const conflicts = [
      { file: 'src/auth.ts', pieceName: 'auth', pieceIndex: 0 },
      { file: 'src/config.ts', pieceName: 'db', pieceIndex: 1 },
    ];
    const msg = formatPendingPRConflictFeedback(conflicts);

    expect(msg).toContain('Pending PR');
    expect(msg).toContain('src/auth.ts');
    expect(msg).toContain('src/config.ts');
    expect(msg).toContain('auth');
    expect(msg).toContain('db');
    expect(msg).toContain('avoid');
  });

  it('returns empty string for no conflicts', () => {
    expect(formatPendingPRConflictFeedback([])).toBe('');
  });
});

// --- Dependency-overlap detection (#276) ---

function node(filePath: string, name: string, kind: SymbolNode['kind'] = 'function'): SymbolNode {
  return {
    id: `${filePath}::${name}@1`,
    kind,
    name,
    filePath,
    startLine: 1,
    endLine: 10,
    signature: `function ${name}()`,
    isExported: true,
  };
}

function makeLookup(
  symbolsByFile: Record<string, SymbolNode[]>,
  callersByNode: Record<string, SymbolNode[]> = {},
): DependencyOverlapLookup {
  return {
    listFileSymbols: (filePath) => symbolsByFile[filePath] ?? [],
    getCallers: (nodeId) => callersByNode[nodeId] ?? [],
  };
}

describe('detectDependencyOverlaps', () => {
  it('returns empty list for 0 or 1 pieces', () => {
    expect(detectDependencyOverlaps([], makeLookup({}))).toEqual([]);
    expect(detectDependencyOverlaps([makePiece('only', ['src/a.ts'])], makeLookup({}))).toEqual([]);
  });

  it('returns empty list when codegraph has no symbols (graceful)', () => {
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts'])];
    expect(detectDependencyOverlaps(pieces, makeLookup({}))).toEqual([]);
  });

  it('returns empty list when pieces share no call edges', () => {
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts'])];
    const a = node('src/a.ts', 'aFn');
    const b = node('src/b.ts', 'bFn');
    // No callers on either — they don't call each other
    const lookup = makeLookup({ 'src/a.ts': [a], 'src/b.ts': [b] });
    expect(detectDependencyOverlaps(pieces, lookup)).toEqual([]);
  });

  it('flags disjoint-files-but-call-edge case (the load-bearing test)', () => {
    // The whole point of #276: piece A defines `exportedFn` (src/a.ts),
    // piece B calls it (src/b.ts). File sets are disjoint, but they are
    // coupled via the codegraph.
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts'])];
    const exportedFn = node('src/a.ts', 'exportedFn');
    const callerInB = node('src/b.ts', 'usesExportedFn');
    const lookup = makeLookup({ 'src/a.ts': [exportedFn], 'src/b.ts': [callerInB] }, { [exportedFn.id]: [callerInB] });

    const overlaps = detectDependencyOverlaps(pieces, lookup);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      symbolName: 'exportedFn',
      sourceFile: 'src/a.ts',
      sourcePieceIndex: 0,
      sourcePieceName: 'a',
      dependentFile: 'src/b.ts',
      dependentPieceIndex: 1,
      dependentPieceName: 'b',
    });
  });

  it('does not flag in-piece self-callers', () => {
    // Symbol defined in src/a.ts is called from src/a-helper.ts — both belong
    // to the same piece. Not a cross-piece overlap.
    const pieces = [makePiece('a', ['src/a.ts', 'src/a-helper.ts']), makePiece('b', ['src/b.ts'])];
    const aFn = node('src/a.ts', 'aFn');
    const helper = node('src/a-helper.ts', 'helperUsesA');
    const lookup = makeLookup({ 'src/a.ts': [aFn], 'src/a-helper.ts': [helper] }, { [aFn.id]: [helper] });

    expect(detectDependencyOverlaps(pieces, lookup)).toEqual([]);
  });

  it('deduplicates the same edge encountered twice', () => {
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts'])];
    const aFn = node('src/a.ts', 'aFn');
    const callerInB = node('src/b.ts', 'callerInB');
    // Same caller listed twice (e.g. multi-call)
    const lookup = makeLookup({ 'src/a.ts': [aFn], 'src/b.ts': [callerInB] }, { [aFn.id]: [callerInB, callerInB] });

    expect(detectDependencyOverlaps(pieces, lookup)).toHaveLength(1);
  });

  it('flags multiple distinct cross-piece edges', () => {
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts']), makePiece('c', ['src/c.ts'])];
    const a1 = node('src/a.ts', 'a1');
    const a2 = node('src/a.ts', 'a2');
    const inB = node('src/b.ts', 'usesA1');
    const inC = node('src/c.ts', 'usesA2');
    const lookup = makeLookup(
      { 'src/a.ts': [a1, a2], 'src/b.ts': [inB], 'src/c.ts': [inC] },
      { [a1.id]: [inB], [a2.id]: [inC] },
    );

    const overlaps = detectDependencyOverlaps(pieces, lookup);
    expect(overlaps).toHaveLength(2);
    expect(overlaps.map((o) => o.symbolName).sort()).toEqual(['a1', 'a2']);
  });

  it('ignores callers whose file is outside any piece', () => {
    // src/external.ts is not part of any spec piece — those callers are
    // out-of-scope for the conflict-scheduling decision.
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts'])];
    const aFn = node('src/a.ts', 'aFn');
    const external = node('src/external.ts', 'externalCaller');
    const lookup = makeLookup({ 'src/a.ts': [aFn] }, { [aFn.id]: [external] });

    expect(detectDependencyOverlaps(pieces, lookup)).toEqual([]);
  });

  it('tolerates per-file lookup throws (graceful per-file degradation)', () => {
    const pieces = [makePiece('a', ['src/a.ts']), makePiece('b', ['src/b.ts']), makePiece('c', ['src/c.ts'])];
    const aFn = node('src/a.ts', 'aFn');
    const inB = node('src/b.ts', 'usesA');

    const lookup: DependencyOverlapLookup = {
      listFileSymbols: (fp) => {
        if (fp === 'src/c.ts') throw new Error('boom');
        if (fp === 'src/a.ts') return [aFn];
        if (fp === 'src/b.ts') return [inB];
        return [];
      },
      getCallers: (id) => (id === aFn.id ? [inB] : []),
    };

    const overlaps = detectDependencyOverlaps(pieces, lookup);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.symbolName).toBe('aFn');
  });
});

describe('formatDependencyOverlapFeedback', () => {
  it('returns empty string for no overlaps', () => {
    expect(formatDependencyOverlapFeedback([])).toBe('');
  });

  it('formats a single dependency overlap', () => {
    const out = formatDependencyOverlapFeedback([
      {
        symbolName: 'doStuff',
        sourceFile: 'src/a.ts',
        sourcePieceIndex: 0,
        sourcePieceName: 'core',
        dependentFile: 'src/b.ts',
        dependentPieceIndex: 1,
        dependentPieceName: 'consumer',
      },
    ]);

    expect(out).toContain('Dependency Overlap Feedback');
    expect(out).toContain('core');
    expect(out).toContain('consumer');
    expect(out).toContain('doStuff');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
  });

  it('formats multiple dependency overlaps', () => {
    const out = formatDependencyOverlapFeedback([
      {
        symbolName: 'aFn',
        sourceFile: 'src/a.ts',
        sourcePieceIndex: 0,
        sourcePieceName: 'p0',
        dependentFile: 'src/b.ts',
        dependentPieceIndex: 1,
        dependentPieceName: 'p1',
      },
      {
        symbolName: 'cFn',
        sourceFile: 'src/c.ts',
        sourcePieceIndex: 2,
        sourcePieceName: 'p2',
        dependentFile: 'src/d.ts',
        dependentPieceIndex: 3,
        dependentPieceName: 'p3',
      },
    ]);

    expect(out).toContain('aFn');
    expect(out).toContain('cFn');
    expect(out).toContain('p0');
    expect(out).toContain('p3');
  });
});
