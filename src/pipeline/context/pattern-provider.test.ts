import { beforeEach, describe, expect, it, vi } from 'vitest';
import { patternProvider } from './pattern-provider.js';
import { makeConfig, makeCtx } from './test-helpers.js';

vi.mock('../../memory/pattern-store.js', () => ({
  PatternStore: vi.fn().mockImplementation(() => ({
    queryTopPatterns: () => [],
    close: () => {},
  })),
  formatPatterns: vi.fn(() => 'PATTERNS'),
  upsertPatternFromEpisode: vi.fn(),
}));

import { formatPatterns, PatternStore } from '../../memory/pattern-store.js';

describe('patternProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when episodes are disabled', async () => {
    const out = await patternProvider.resolve(makeCtx({ config: makeConfig({ episodes: undefined }) }));
    expect(out).toBeUndefined();
    expect(PatternStore).not.toHaveBeenCalled();
  });

  it('returns undefined when no patterns are found', async () => {
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await patternProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('formats patterns when found', async () => {
    vi.mocked(PatternStore).mockImplementationOnce(
      () =>
        ({
          queryTopPatterns: () => [{ id: 1 } as never],
          close: () => {},
        }) as never,
    );
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await patternProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBe('PATTERNS');
    expect(formatPatterns).toHaveBeenCalled();
  });

  it('gracefully returns undefined on PatternStore failure', async () => {
    vi.mocked(PatternStore).mockImplementationOnce(() => {
      throw new Error('no db');
    });
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await patternProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });
});
