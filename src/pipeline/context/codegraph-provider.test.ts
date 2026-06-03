import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codegraphProvider } from './codegraph-provider.js';
import { makeCtx } from './test-helpers.js';

vi.mock('../../ai/codegraph.js', () => ({
  extractSymbolCandidates: vi.fn(() => []),
  formatCodegraphContext: vi.fn(() => 'CODEGRAPH'),
}));

vi.mock('../../services/codegraph/index.js', () => ({
  openCodegraph: vi.fn(() => ({ close: () => {} })),
}));

import { extractSymbolCandidates, formatCodegraphContext } from '../../ai/codegraph.js';
import { openCodegraph } from '../../services/codegraph/index.js';

describe('codegraphProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when no symbol candidates extracted', async () => {
    const out = await codegraphProvider.resolve(makeCtx());
    expect(out).toBeUndefined();
    expect(openCodegraph).not.toHaveBeenCalled();
  });

  it('returns undefined when codegraph format yields empty string', async () => {
    vi.mocked(extractSymbolCandidates).mockReturnValueOnce(['foo']);
    vi.mocked(formatCodegraphContext).mockReturnValueOnce('');
    const out = await codegraphProvider.resolve(makeCtx());
    expect(out).toBeUndefined();
  });

  it('returns the formatted context when matches exist', async () => {
    vi.mocked(extractSymbolCandidates).mockReturnValueOnce(['foo']);
    vi.mocked(formatCodegraphContext).mockReturnValueOnce('CODEGRAPH');
    const infos: string[] = [];
    const out = await codegraphProvider.resolve(makeCtx({ logger: { info: (m) => infos.push(m), warn: () => {} } }));
    expect(out).toBe('CODEGRAPH');
    expect(infos.some((m) => m.includes('codegraph-context'))).toBe(true);
  });

  it('gracefully returns undefined when openCodegraph throws', async () => {
    vi.mocked(extractSymbolCandidates).mockReturnValueOnce(['foo']);
    vi.mocked(openCodegraph).mockImplementationOnce(() => {
      throw new Error('no db');
    });
    const warns: string[] = [];
    const out = await codegraphProvider.resolve(makeCtx({ logger: { info: () => {}, warn: (m) => warns.push(m) } }));
    expect(out).toBeUndefined();
    expect(warns.some((m) => m.includes('codegraph-context'))).toBe(true);
  });

  it('closes the graph even when formatCodegraphContext throws', async () => {
    vi.mocked(extractSymbolCandidates).mockReturnValueOnce(['foo']);
    const close = vi.fn();
    vi.mocked(openCodegraph).mockReturnValueOnce({ close } as never);
    vi.mocked(formatCodegraphContext).mockImplementationOnce(() => {
      throw new Error('format');
    });
    const out = await codegraphProvider.resolve(makeCtx());
    expect(out).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });
});
