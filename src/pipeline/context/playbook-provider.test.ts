import { beforeEach, describe, expect, it, vi } from 'vitest';
import { playbookProvider } from './playbook-provider.js';
import { makeConfig, makeCtx } from './test-helpers.js';

vi.mock('../../services/vectordb.js', () => ({
  queryPlaybook: vi.fn(async () => null),
  formatPlaybook: vi.fn(() => 'PLAYBOOK'),
}));

import { formatPlaybook, queryPlaybook } from '../../services/vectordb.js';

describe('playbookProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when playbooks are disabled', async () => {
    const out = await playbookProvider.resolve(makeCtx({ config: makeConfig({ playbooks: undefined }) }));
    expect(out).toBeUndefined();
    expect(queryPlaybook).not.toHaveBeenCalled();
  });

  it('returns undefined when no playbook matches', async () => {
    const cfg = makeConfig({ playbooks: { enabled: true } as never });
    const out = await playbookProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('formats playbook when matched', async () => {
    vi.mocked(queryPlaybook).mockResolvedValueOnce({ title: 't' } as never);
    const cfg = makeConfig({ playbooks: { enabled: true } as never });
    const out = await playbookProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBe('PLAYBOOK');
    expect(formatPlaybook).toHaveBeenCalled();
  });

  it('passes language through when not "unknown"', async () => {
    const cfg = makeConfig({ playbooks: { enabled: true } as never });
    await playbookProvider.resolve(makeCtx({ config: cfg, language: 'rust' }));
    expect(queryPlaybook).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ language: 'rust' }),
    );
  });

  it('passes language as undefined when "unknown"', async () => {
    const cfg = makeConfig({ playbooks: { enabled: true } as never });
    await playbookProvider.resolve(makeCtx({ config: cfg, language: 'unknown' }));
    expect(queryPlaybook).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ language: undefined }),
    );
  });
});
