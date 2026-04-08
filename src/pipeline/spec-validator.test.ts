import { describe, expect, it } from 'vitest';
import type { SpecPiece } from '../types/index.js';
import { formatOverlapFeedback, validatePieceFileOwnership } from './spec-validator.js';

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
    expect(result.overlaps).toHaveLength(0);
    expect(result.pieces).toEqual([]);
    expect(result.dependencyOrder).toEqual([]);
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
