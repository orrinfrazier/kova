import type { SpecPiece } from '../types/index.js';

export interface PieceResult {
  pieceIndex: number;
  success: boolean;
  error?: string;
}

export interface BatchSchedulerConfig {
  pieces: SpecPiece[];
  dependencyOrder: number[][];
  maxConcurrent?: number;
  executePiece: (piece: SpecPiece, index: number) => Promise<PieceResult>;
}

/**
 * Execute spec pieces respecting dependency_order with concurrency control.
 *
 * For each batch in dependency order:
 * 1. Split into sub-batches of maxConcurrent
 * 2. For each sub-batch: Promise.all() the piece executions
 * 3. Collect results, proceed to next batch
 */
export async function executePiecesInBatches(config: BatchSchedulerConfig): Promise<PieceResult[]> {
  const { pieces, dependencyOrder, maxConcurrent = 3, executePiece } = config;

  if (pieces.length === 0) {
    return [];
  }

  const allResults: PieceResult[] = [];

  for (const batch of dependencyOrder) {
    if (batch.length === 0) {
      continue;
    }

    // Split batch into sub-batches of maxConcurrent
    const subBatches: number[][] = [];
    for (let i = 0; i < batch.length; i += maxConcurrent) {
      subBatches.push(batch.slice(i, i + maxConcurrent));
    }

    for (const subBatch of subBatches) {
      const subBatchResults = await Promise.all(
        subBatch.map(async (pieceIndex) => {
          const piece = pieces[pieceIndex];
          if (!piece) {
            return { pieceIndex, success: false, error: `Piece at index ${pieceIndex} not found` };
          }
          try {
            return await executePiece(piece, pieceIndex);
          } catch (err) {
            return {
              pieceIndex,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      allResults.push(...subBatchResults);
    }
  }

  return allResults;
}
