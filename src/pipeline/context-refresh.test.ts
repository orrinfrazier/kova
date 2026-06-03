// Unit tests for refreshCodebaseContext — issue #277.
//
// The helper sits between WAVE I and any subsequent wave that consumes
// codebaseContext (re-spec/re-impl on SPEC_WRONG, conflict-resolution
// retry, etc). It re-indexes the changed-since-impl file set then
// re-queries the vector DB so downstream waves see post-edit code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, VectorDBConfig } from '../types/config.js';

/* ------------------------------------------------------------------ */
/*  Mock the three external collaborators                              */
/* ------------------------------------------------------------------ */

const reindexFilesMock = vi.fn();
const getChangedFilesSinceMock = vi.fn();
const queryCodeContextMock = vi.fn();
const formatCodeChunksMock = vi.fn();
const logWarnMock = vi.fn();
const logInfoMock = vi.fn();

vi.mock('../services/reindex.js', () => ({
  reindexFiles: reindexFilesMock,
}));

vi.mock('../services/git-diff.js', () => ({
  getChangedFilesSince: getChangedFilesSinceMock,
}));

vi.mock('../services/memory/code-rest.js', () => ({
  queryCodeContext: queryCodeContextMock,
  formatCodeChunks: formatCodeChunksMock,
}));

vi.mock('../utils/logger.js', () => ({
  log: { warn: logWarnMock, info: logInfoMock, error: vi.fn(), debug: vi.fn() },
}));

const { refreshCodebaseContext } = await import('./context-refresh.js');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeVectorDB(overrides: Partial<VectorDBConfig> = {}): VectorDBConfig {
  return {
    enabled: true,
    endpoint: 'http://localhost:8100/query',
    reindex_endpoint: 'http://localhost:8100/reindex',
    top_k: 10,
    ...overrides,
  };
}

function makeConfig(vectordb?: VectorDBConfig | undefined): RepoConfig {
  return { vectordb } as unknown as RepoConfig;
}

beforeEach(() => {
  reindexFilesMock.mockReset();
  getChangedFilesSinceMock.mockReset();
  queryCodeContextMock.mockReset();
  formatCodeChunksMock.mockReset();
  logWarnMock.mockReset();
  logInfoMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Acceptance criteria tests                                          */
/* ------------------------------------------------------------------ */

describe('refreshCodebaseContext', () => {
  // AC: "no-op when vectordb disabled"
  it('returns the existing context unchanged when vectordb is disabled', async () => {
    const config = makeConfig(makeVectorDB({ enabled: false }));

    const result = await refreshCodebaseContext({
      config,
      workDir: '/tmp/wt',
      sinceSha: 'abc123',
      issueQuery: 'something',
      currentContext: 'PREVIOUS',
    });

    expect(result).toBe('PREVIOUS');
    expect(reindexFilesMock).not.toHaveBeenCalled();
    expect(getChangedFilesSinceMock).not.toHaveBeenCalled();
    expect(queryCodeContextMock).not.toHaveBeenCalled();
  });

  // AC: degrade gracefully when vectordb config absent entirely
  it('returns the existing context unchanged when vectordb config is undefined', async () => {
    const config = makeConfig(undefined);

    const result = await refreshCodebaseContext({
      config,
      workDir: '/tmp/wt',
      sinceSha: 'abc123',
      issueQuery: 'something',
      currentContext: 'PREVIOUS',
    });

    expect(result).toBe('PREVIOUS');
    expect(reindexFilesMock).not.toHaveBeenCalled();
  });

  // AC: "Only changed files re-indexed (assert reindexFiles called with the modified-file list)"
  it('calls reindexFiles with exactly the modified-file list from getChangedFilesSince', async () => {
    getChangedFilesSinceMock.mockResolvedValueOnce(['src/a.ts', 'src/b.ts']);
    reindexFilesMock.mockResolvedValueOnce({
      success: true,
      filesSubmitted: 2,
      apiCalls: 2,
      duration: 10,
    });
    queryCodeContextMock.mockResolvedValueOnce([{ file: 'src/a.ts', content: 'new symbol foo', score: 0.9 }]);
    formatCodeChunksMock.mockReturnValueOnce('## REFRESHED');

    await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'preimpl-sha',
      issueQuery: 'foo bar',
      currentContext: 'OLD',
    });

    expect(getChangedFilesSinceMock).toHaveBeenCalledWith('/tmp/wt', 'preimpl-sha');
    expect(reindexFilesMock).toHaveBeenCalledTimes(1);
    const [vectordbArg, repoPathArg, filesArg] = reindexFilesMock.mock.calls[0] as [VectorDBConfig, string, string[]];
    expect(vectordbArg.enabled).toBe(true);
    expect(repoPathArg).toBe('/tmp/wt');
    expect(filesArg).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // AC: "After impl edits, the affected set is re-indexed before any re-impl/review-driven wave"
  // AC: "codebaseContext in re-impl/conflict reflects post-edit code"
  // AC: "Test: a two-wave fix where impl adds a symbol shows it in refreshed context"
  it('returns refreshed context built from post-impl code chunks on success', async () => {
    getChangedFilesSinceMock.mockResolvedValueOnce(['src/widget.ts']);
    reindexFilesMock.mockResolvedValueOnce({
      success: true,
      filesSubmitted: 1,
      apiCalls: 1,
      duration: 5,
    });
    // Simulate a NEW symbol that didn't exist before impl
    queryCodeContextMock.mockResolvedValueOnce([
      {
        file: 'src/widget.ts',
        content: 'export function newlyAddedSymbol() { return 42; }',
        score: 0.95,
      },
    ]);
    formatCodeChunksMock.mockImplementationOnce(
      (chunks) => `## Refreshed\n\n${(chunks as Array<{ content: string }>).map((c) => c.content).join('\n')}`,
    );

    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'pre-impl-sha',
      issueQuery: 'widget',
      currentContext: 'OLD CONTEXT WITHOUT NEW SYMBOL',
    });

    expect(result).toContain('newlyAddedSymbol');
    expect(result).not.toBe('OLD CONTEXT WITHOUT NEW SYMBOL');
    expect(queryCodeContextMock).toHaveBeenCalledTimes(1);
    expect(queryCodeContextMock.mock.calls[0]?.[1]).toBe('widget');
  });

  // AC: "Only changed files re-indexed" — when no files changed, do not reindex.
  it('returns the existing context and skips reindex when no files changed since impl', async () => {
    getChangedFilesSinceMock.mockResolvedValueOnce([]);

    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'pre-impl-sha',
      issueQuery: 'q',
      currentContext: 'OLD',
    });

    expect(result).toBe('OLD');
    expect(reindexFilesMock).not.toHaveBeenCalled();
    expect(queryCodeContextMock).not.toHaveBeenCalled();
  });

  // AC: "Reindex failure logs a warning; no-op when vectordb disabled"
  it('logs a warning and retains the existing context when reindex fails', async () => {
    getChangedFilesSinceMock.mockResolvedValueOnce(['src/a.ts']);
    reindexFilesMock.mockResolvedValueOnce({
      success: false,
      filesSubmitted: 1,
      apiCalls: 0,
      duration: 3,
      error: 'endpoint 503',
    });

    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'pre-impl-sha',
      issueQuery: 'q',
      currentContext: 'OLD',
    });

    expect(result).toBe('OLD');
    expect(logWarnMock).toHaveBeenCalled();
    // Warning must mention the failure reason for operator debuggability.
    const warned = logWarnMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/reindex|refresh/i);
    // queryCodeContext MUST NOT be called when reindex fails — stale results would
    // be worse than the existing context.
    expect(queryCodeContextMock).not.toHaveBeenCalled();
  });

  // Degradation: if reindex succeeds but the follow-up query returns empty,
  // retain the existing (non-refreshed) context rather than wiping it.
  it('retains the existing context when queryCodeContext returns no chunks', async () => {
    getChangedFilesSinceMock.mockResolvedValueOnce(['src/a.ts']);
    reindexFilesMock.mockResolvedValueOnce({
      success: true,
      filesSubmitted: 1,
      apiCalls: 1,
      duration: 5,
    });
    queryCodeContextMock.mockResolvedValueOnce([]);

    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'pre-impl-sha',
      issueQuery: 'q',
      currentContext: 'OLD',
    });

    expect(result).toBe('OLD');
    expect(formatCodeChunksMock).not.toHaveBeenCalled();
  });

  // Degradation: never throw. If a collaborator throws unexpectedly,
  // return the existing context and warn.
  it('catches collaborator exceptions and returns the existing context', async () => {
    getChangedFilesSinceMock.mockRejectedValueOnce(new Error('git failed'));

    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: 'pre-impl-sha',
      issueQuery: 'q',
      currentContext: 'OLD',
    });

    expect(result).toBe('OLD');
    expect(logWarnMock).toHaveBeenCalled();
  });

  // sinceSha=null is the "no pre-impl SHA captured" path — must still be a no-op
  // (do not full-reindex the entire repo from a mid-fix helper).
  it('returns the existing context unchanged when sinceSha is null', async () => {
    const result = await refreshCodebaseContext({
      config: makeConfig(makeVectorDB()),
      workDir: '/tmp/wt',
      sinceSha: null,
      issueQuery: 'q',
      currentContext: 'OLD',
    });

    expect(result).toBe('OLD');
    expect(reindexFilesMock).not.toHaveBeenCalled();
    expect(getChangedFilesSinceMock).not.toHaveBeenCalled();
  });
});
