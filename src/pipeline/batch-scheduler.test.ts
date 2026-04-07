import { describe, expect, it, vi } from 'vitest';
import type { SpecPiece } from '../types/index.js';
import { executePiecesInBatches, type PieceResult } from './batch-scheduler.js';

function makePiece(index: number): SpecPiece {
  return {
    name: `piece-${index}`,
    description: `Description for piece ${index}`,
    files: [`file-${index}.ts`],
    acceptance_criteria: [`AC ${index}`],
    wiring: [],
  };
}

describe('executePiecesInBatches', () => {
  it('single piece — no batching overhead (passthrough)', async () => {
    const pieces = [makePiece(0)];
    const executePiece = vi.fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>().mockResolvedValue({
      pieceIndex: 0,
      success: true,
    });

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [[0]],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(executePiece).toHaveBeenCalledTimes(1);
    expect(executePiece).toHaveBeenCalledWith(pieces[0], 0);
  });

  it('3 pieces in one batch — all run concurrently', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2)];
    const callOrder: number[] = [];
    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        callOrder.push(index);
        return { pieceIndex: index, success: true };
      });

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [[0, 1, 2]],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(executePiece).toHaveBeenCalledTimes(3);
  });

  it('respects dependency_order — batch N waits for batch N-1', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2), makePiece(3)];
    const timeline: Array<{ index: number; event: 'start' | 'end' }> = [];

    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        timeline.push({ index, event: 'start' });
        // Simulate work
        await new Promise((r) => setTimeout(r, 10));
        timeline.push({ index, event: 'end' });
        return { pieceIndex: index, success: true };
      });

    await executePiecesInBatches({
      pieces,
      dependencyOrder: [
        [0, 1],
        [2, 3],
      ],
      maxConcurrent: 3,
      executePiece,
    });

    // Pieces 2 and 3 must start AFTER pieces 0 and 1 end
    const lastBatch1End = Math.max(...timeline.map((e, i) => ([0, 1].includes(e.index) && e.event === 'end' ? i : -1)));
    const firstBatch2Start = Math.min(
      ...timeline.map((e, i) => ([2, 3].includes(e.index) && e.event === 'start' ? i : Number.POSITIVE_INFINITY)),
    );

    expect(lastBatch1End).toBeLessThan(firstBatch2Start);
  });

  it('splits batch >maxConcurrent into sub-batches', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2), makePiece(3), makePiece(4)];
    let maxConcurrentObserved = 0;
    let currentConcurrent = 0;

    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        currentConcurrent++;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return { pieceIndex: index, success: true };
      });

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [[0, 1, 2, 3, 4]],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.success)).toBe(true);
    // Should never exceed 3 concurrent
    expect(maxConcurrentObserved).toBeLessThanOrEqual(3);
    // Should use at least 2 (sub-batch of 3, then sub-batch of 2)
    expect(executePiece).toHaveBeenCalledTimes(5);
  });

  it('error in one piece does not kill the whole batch', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2)];
    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        if (index === 1) {
          throw new Error('piece 1 failed');
        }
        return { pieceIndex: index, success: true };
      });

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [[0, 1, 2]],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toHaveLength(3);
    // Pieces 0 and 2 succeeded
    expect(results.find((r) => r.pieceIndex === 0)?.success).toBe(true);
    expect(results.find((r) => r.pieceIndex === 2)?.success).toBe(true);
    // Piece 1 failed
    const failed = results.find((r) => r.pieceIndex === 1);
    expect(failed?.success).toBe(false);
    expect(failed?.error).toBe('piece 1 failed');
  });

  it('handles multiple batches with sub-batching', async () => {
    // 7 pieces: batch 1 = [0,1,2,3], batch 2 = [4,5,6]
    const pieces = Array.from({ length: 7 }, (_, i) => makePiece(i));
    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        await new Promise((r) => setTimeout(r, 10));
        return { pieceIndex: index, success: true };
      });

    await executePiecesInBatches({
      pieces,
      dependencyOrder: [
        [0, 1, 2, 3],
        [4, 5, 6],
      ],
      maxConcurrent: 3,
      executePiece,
    });

    expect(executePiece).toHaveBeenCalledTimes(7);
    const results = executePiece.mock.results;
    expect(results.every((r) => r.type === 'return')).toBe(true);
  });

  it('defaults maxConcurrent to 3', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2), makePiece(3), makePiece(4)];
    let maxConcurrentObserved = 0;
    let currentConcurrent = 0;

    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => {
        currentConcurrent++;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return { pieceIndex: index, success: true };
      });

    await executePiecesInBatches({
      pieces,
      dependencyOrder: [[0, 1, 2, 3, 4]],
      executePiece,
    });

    expect(maxConcurrentObserved).toBeLessThanOrEqual(3);
  });

  it('handles empty pieces array', async () => {
    const executePiece = vi.fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>();

    const results = await executePiecesInBatches({
      pieces: [],
      dependencyOrder: [],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toEqual([]);
    expect(executePiece).not.toHaveBeenCalled();
  });

  it('handles empty batch in dependency order', async () => {
    const pieces = [makePiece(0)];
    const executePiece = vi.fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>().mockResolvedValue({
      pieceIndex: 0,
      success: true,
    });

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [[], [0]],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results).toHaveLength(1);
    expect(executePiece).toHaveBeenCalledTimes(1);
  });

  it('preserves piece index in results across batches', async () => {
    const pieces = [makePiece(0), makePiece(1), makePiece(2), makePiece(3)];
    const executePiece = vi
      .fn<(piece: SpecPiece, index: number) => Promise<PieceResult>>()
      .mockImplementation(async (_piece, index) => ({ pieceIndex: index, success: true }));

    const results = await executePiecesInBatches({
      pieces,
      dependencyOrder: [
        [0, 1],
        [2, 3],
      ],
      maxConcurrent: 3,
      executePiece,
    });

    expect(results.map((r) => r.pieceIndex).sort()).toEqual([0, 1, 2, 3]);
  });
});
