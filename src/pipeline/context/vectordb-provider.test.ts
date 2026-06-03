import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeCtx } from './test-helpers.js';
import { vectordbProvider } from './vectordb-provider.js';

vi.mock('../../services/vectordb.js', () => ({
  queryCodeContext: vi.fn(async () => []),
  formatCodeChunks: vi.fn(() => 'CHUNKS'),
}));

import { formatCodeChunks, queryCodeContext } from '../../services/vectordb.js';

describe('vectordbProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when vectordb is disabled', async () => {
    const out = await vectordbProvider.resolve(makeCtx({ config: makeConfig({ vectordb: undefined }) }));
    expect(out).toBeUndefined();
    expect(queryCodeContext).not.toHaveBeenCalled();
  });

  it('returns undefined when no chunks match', async () => {
    const cfg = makeConfig({ vectordb: { enabled: true } as never });
    const out = await vectordbProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('formats chunks when matches exist', async () => {
    vi.mocked(queryCodeContext).mockResolvedValueOnce([{ content: 'snippet' } as never]);
    const cfg = makeConfig({ vectordb: { enabled: true } as never });
    const out = await vectordbProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBe('CHUNKS');
    expect(formatCodeChunks).toHaveBeenCalled();
  });
});
