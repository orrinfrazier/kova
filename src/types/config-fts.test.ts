// Tests for the `episodes.fts` config block (issue #302).
//
// FTS5 keyword recall is an optional local SQLite sidecar to the existing
// REST-based episodic memory. The schema must:
//   - keep existing configs (without `fts`) valid
//   - default `fts.enabled` to true when episodes is enabled but no fts block given
//   - accept an explicit `fts: { enabled: false }` (opt out)
//   - accept an explicit `fts: { enabled: true, path: ... }` (custom DB path)

import { describe, expect, it } from 'vitest';
import { EpisodicMemoryConfigSchema } from './config.js';

describe('EpisodicMemoryConfigSchema — fts block', () => {
  it('omits fts block when not provided (preserves backward compat)', () => {
    const parsed = EpisodicMemoryConfigSchema.safeParse({
      enabled: true,
      endpoint: 'http://localhost:9000/episodes',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // No fts block — callers treat absence as "default on" and resolve a path themselves.
      expect(parsed.data.fts).toBeUndefined();
    }
  });

  it('accepts disabled episodes without fts', () => {
    const parsed = EpisodicMemoryConfigSchema.safeParse({ enabled: false });
    expect(parsed.success).toBe(true);
  });

  it('accepts explicit fts: { enabled: false } (opt-out)', () => {
    const parsed = EpisodicMemoryConfigSchema.safeParse({
      enabled: true,
      endpoint: 'http://localhost:9000/episodes',
      fts: { enabled: false },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fts?.enabled).toBe(false);
    }
  });

  it('accepts explicit fts: { enabled: true } and applies defaults', () => {
    const parsed = EpisodicMemoryConfigSchema.safeParse({
      enabled: true,
      endpoint: 'http://localhost:9000/episodes',
      fts: { enabled: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fts?.enabled).toBe(true);
      // path is optional — caller resolves a default if absent.
      expect(parsed.data.fts?.path).toBeUndefined();
    }
  });

  it('accepts an explicit fts.path', () => {
    const parsed = EpisodicMemoryConfigSchema.safeParse({
      enabled: true,
      endpoint: 'http://localhost:9000/episodes',
      fts: { enabled: true, path: '/var/lib/kova/episodes.db' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fts?.path).toBe('/var/lib/kova/episodes.db');
    }
  });
});
