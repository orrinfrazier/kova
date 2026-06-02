import { describe, expect, it, vi } from 'vitest';
import type { VectorDBConfig } from '../types/config.js';
import type { IndexResult } from './index-codebase.js';
import { indexCodebase } from './index-codebase.js';

// Hoisted spies that the mocked modules below reference. `vi.mock` is hoisted
// above imports, so factory-scoped references to top-level `const`s would
// throw. `vi.hoisted` makes the spies available at the same hoisted level.
const { mockUpsertChunks, mockChunkFile, mockGetChangedFilesSince } = vi.hoisted(() => ({
  mockUpsertChunks: vi.fn().mockResolvedValue(undefined),
  mockChunkFile: vi.fn().mockReturnValue([]),
  mockGetChangedFilesSince: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/chunker.js', () => ({
  chunkFile: (...args: unknown[]) => mockChunkFile(...args),
}));

vi.mock('../services/vectordb.js', () => ({
  upsertChunks: (...args: unknown[]) => mockUpsertChunks(...args),
}));

vi.mock('../services/git-diff.js', () => ({
  getChangedFilesSince: (...args: unknown[]) => mockGetChangedFilesSince(...args),
  getCurrentHeadSha: vi.fn().mockResolvedValue('abc123'),
  getLastIndexedSha: vi.fn().mockResolvedValue(null),
  saveLastIndexedSha: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('export const x = 1;\n'),
  };
});

describe('indexCodebase', () => {
  describe('IndexResult shape', () => {
    it('returns an object with filesIndexed, chunksUpserted, duration, and incremental fields', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(result).toHaveProperty('filesIndexed');
      expect(result).toHaveProperty('chunksUpserted');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('incremental');
    });

    it('filesIndexed is a non-negative integer', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(typeof result.filesIndexed).toBe('number');
      expect(Number.isInteger(result.filesIndexed)).toBe(true);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(0);
    });

    it('chunksUpserted is a non-negative integer', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(typeof result.chunksUpserted).toBe('number');
      expect(Number.isInteger(result.chunksUpserted)).toBe(true);
      expect(result.chunksUpserted).toBeGreaterThanOrEqual(0);
    });

    it('duration is a non-negative number (milliseconds)', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('incremental is a boolean', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(typeof result.incremental).toBe('boolean');
    });
  });

  describe('full flag behaviour', () => {
    it('sets incremental=false when full=true', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: true });

      expect(result.incremental).toBe(false);
    });

    it('sets incremental=true when full=false', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(result.incremental).toBe(true);
    });

    it('defaults to incremental (full omitted → incremental=true)', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo' });

      expect(result.incremental).toBe(true);
    });
  });

  describe('empty index run', () => {
    it('returns filesIndexed=0 when there are no files to index', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(result.filesIndexed).toBe(0);
    });

    it('returns chunksUpserted=0 when there are no files to index', async () => {
      const result = await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

      expect(result.chunksUpserted).toBe(0);
    });
  });
});

describe('indexCodebase forwards vectordb config to upsertChunks', () => {
  it('passes the supplied vectordb config through to upsertChunks for each changed file', async () => {
    mockUpsertChunks.mockClear();
    mockChunkFile.mockReturnValue([{ text: 'export const x = 1;', startLine: 1, endLine: 1 }]);
    mockGetChangedFilesSince.mockResolvedValueOnce(['src/changed.ts']);

    const vectordb: VectorDBConfig = {
      enabled: true,
      endpoint: 'http://localhost:8100/query',
      reindex_endpoint: 'http://localhost:8100/reindex',
      top_k: 10,
    };

    await indexCodebase({ repoPath: '/tmp/fake-repo', full: false, vectordb });

    expect(mockUpsertChunks).toHaveBeenCalledOnce();
    const [repoPath, filePath, chunks, configArg] = mockUpsertChunks.mock.calls[0] as [
      string,
      string,
      unknown[],
      VectorDBConfig | undefined,
    ];
    expect(repoPath).toBe('/tmp/fake-repo');
    expect(filePath).toBe('src/changed.ts');
    expect(chunks).toHaveLength(1);
    expect(configArg).toEqual(vectordb);
  });

  it('omits the config arg when vectordb is not supplied (preserves existing call sites)', async () => {
    mockUpsertChunks.mockClear();
    mockChunkFile.mockReturnValue([{ text: 'export const x = 1;', startLine: 1, endLine: 1 }]);
    mockGetChangedFilesSince.mockResolvedValueOnce(['src/changed.ts']);

    await indexCodebase({ repoPath: '/tmp/fake-repo', full: false });

    expect(mockUpsertChunks).toHaveBeenCalledOnce();
    const callArgs = mockUpsertChunks.mock.calls[0] as unknown[];
    // The 4th positional arg should be undefined when no vectordb config is supplied.
    expect(callArgs[3]).toBeUndefined();
  });
});

describe('IndexResult type', () => {
  it('IndexResult is assignable from a conforming object', () => {
    // This is a compile-time check expressed as a runtime assertion.
    const result: IndexResult = {
      filesIndexed: 42,
      chunksUpserted: 128,
      duration: 1500,
      incremental: true,
      codegraphFilesIndexed: 7,
    };

    expect(result.filesIndexed).toBe(42);
    expect(result.chunksUpserted).toBe(128);
    expect(result.duration).toBe(1500);
    expect(result.incremental).toBe(true);
    expect(result.codegraphFilesIndexed).toBe(7);
  });
});
