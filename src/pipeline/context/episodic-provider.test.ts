import { beforeEach, describe, expect, it, vi } from 'vitest';
import { episodicProvider } from './episodic-provider.js';
import { makeConfig, makeCtx } from './test-helpers.js';

vi.mock('../../services/memory/episode-rest.js', () => ({
  queryEpisodeContext: vi.fn(async () => []),
  formatEpisodes: vi.fn(() => 'EPISODES'),
  formatFailedEpisodes: vi.fn(() => 'FAILED'),
}));

vi.mock('../../services/episode-fts.js', () => ({
  EpisodeFTSStore: vi.fn().mockImplementation(() => ({
    searchEpisodesFTS: () => [],
    close: () => {},
  })),
}));

import { EpisodeFTSStore } from '../../services/episode-fts.js';
import { formatEpisodes, formatFailedEpisodes, queryEpisodeContext } from '../../services/memory/episode-rest.js';

describe('episodicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when episodes are disabled', async () => {
    const out = await episodicProvider.resolve(makeCtx({ config: makeConfig({ episodes: undefined }) }));
    expect(out).toBeUndefined();
    expect(queryEpisodeContext).not.toHaveBeenCalled();
  });

  it('returns undefined when no episodes match', async () => {
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await episodicProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });

  it('emits episodicContext + failedEpisodicContext when matches exist', async () => {
    vi.mocked(queryEpisodeContext).mockResolvedValueOnce([
      {
        issue_number: 99,
        issue_title: 'past',
        approach: 'a',
        outcome: 'success',
        learnings: 'l',
        score: 1,
        repo: 'owner/repo',
      },
    ]);
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await episodicProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toEqual({
      episodicContext: 'EPISODES',
      failedEpisodicContext: 'FAILED',
    });
    expect(formatEpisodes).toHaveBeenCalled();
    expect(formatFailedEpisodes).toHaveBeenCalled();
  });

  it('passes language through when not "unknown"', async () => {
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    await episodicProvider.resolve(makeCtx({ config: cfg, language: 'rust' }));
    expect(queryEpisodeContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ language: 'rust' }),
      expect.any(String),
    );
  });

  it('passes language as undefined when "unknown"', async () => {
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    await episodicProvider.resolve(makeCtx({ config: cfg, language: 'unknown' }));
    expect(queryEpisodeContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ language: undefined }),
      expect.any(String),
    );
  });

  it('treats FTS DB failures as empty (graceful)', async () => {
    vi.mocked(EpisodeFTSStore).mockImplementationOnce(() => {
      throw new Error('no db');
    });
    const cfg = makeConfig({ episodes: { enabled: true, max_episodes: 5 } as never });
    const out = await episodicProvider.resolve(makeCtx({ config: cfg }));
    expect(out).toBeUndefined();
  });
});
