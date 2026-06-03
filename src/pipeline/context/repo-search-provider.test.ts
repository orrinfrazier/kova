import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoSearchProvider } from './repo-search-provider.js';
import { makeConfig, makeCtx } from './test-helpers.js';

vi.mock('../../memory/repo-intel.js', () => ({
  queryRepoSearch: vi.fn(async () => ''),
  formatRepoSearch: vi.fn(() => 'SEARCH'),
  queryRepoContext: vi.fn(),
  formatRepoContext: vi.fn(),
}));

import { formatRepoSearch, queryRepoSearch } from '../../memory/repo-intel.js';

describe('repoSearchProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when repo_intel is disabled', async () => {
    const out = await repoSearchProvider.resolve(makeCtx({ config: makeConfig({ repo_intel: undefined }) }));
    expect(out).toBeUndefined();
    expect(queryRepoSearch).not.toHaveBeenCalled();
  });

  it('returns undefined when ownerRepo is missing', async () => {
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoSearchProvider.resolve(makeCtx({ config: cfg, ownerRepo: undefined }));
    expect(out).toBeUndefined();
  });

  it('returns undefined when search yields no results', async () => {
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoSearchProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('formats search results when matches exist', async () => {
    vi.mocked(queryRepoSearch).mockResolvedValueOnce('raw-search');
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoSearchProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBe('SEARCH');
    expect(formatRepoSearch).toHaveBeenCalled();
  });
});
