import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoIntelProvider } from './repo-intel-provider.js';
import { makeConfig, makeCtx } from './test-helpers.js';

vi.mock('../../memory/repo-intel.js', () => ({
  queryRepoContext: vi.fn(async () => ''),
  formatRepoContext: vi.fn(() => 'CONTEXT'),
  queryRepoSearch: vi.fn(async () => ''),
  formatRepoSearch: vi.fn(() => 'SEARCH'),
}));

import { formatRepoContext, queryRepoContext } from '../../memory/repo-intel.js';

describe('repoIntelProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when repo_intel is disabled', async () => {
    const out = await repoIntelProvider.resolve(makeCtx({ config: makeConfig({ repo_intel: undefined }) }));
    expect(out).toBeUndefined();
    expect(queryRepoContext).not.toHaveBeenCalled();
  });

  it('returns undefined when ownerRepo is missing', async () => {
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoIntelProvider.resolve(makeCtx({ config: cfg, ownerRepo: undefined }));
    expect(out).toBeUndefined();
    expect(queryRepoContext).not.toHaveBeenCalled();
  });

  it('returns undefined when the query yields no results', async () => {
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoIntelProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('formats results when matches exist', async () => {
    vi.mocked(queryRepoContext).mockResolvedValueOnce('raw-context');
    const cfg = makeConfig({ repo_intel: { enabled: true } as never });
    const out = await repoIntelProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBe('CONTEXT');
    expect(formatRepoContext).toHaveBeenCalled();
  });
});
