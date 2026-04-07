import { describe, expect, it, vi } from 'vitest';
import type { IndexResult } from './index-codebase.js';
import { indexCodebase } from './index-codebase.js';

// Minimal stubs — real module doesn't exist yet, so these mocks are irrelevant
// but are declared here to document what the implementation will need.
vi.mock('../services/chunker.js', () => ({
  chunkFile: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/vectordb.js', () => ({
  upsertChunks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/git-diff.js', () => ({
  getChangedFilesSince: vi.fn().mockResolvedValue([]),
  getCurrentHeadSha: vi.fn().mockResolvedValue('abc123'),
  getLastIndexedSha: vi.fn().mockResolvedValue(null),
  saveLastIndexedSha: vi.fn().mockResolvedValue(undefined),
}));

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

describe('IndexResult type', () => {
  it('IndexResult is assignable from a conforming object', () => {
    // This is a compile-time check expressed as a runtime assertion.
    const result: IndexResult = {
      filesIndexed: 42,
      chunksUpserted: 128,
      duration: 1500,
      incremental: true,
    };

    expect(result.filesIndexed).toBe(42);
    expect(result.chunksUpserted).toBe(128);
    expect(result.duration).toBe(1500);
    expect(result.incremental).toBe(true);
  });
});
