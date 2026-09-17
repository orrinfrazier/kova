import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CodexCredentials,
  ensureFreshCodexToken,
  getCachedCodexAccessToken,
  hasCodexCredentials,
  readCodexCredentials,
  setCachedCodexCredentials,
  writeCodexCredentials,
} from './index.js';

describe('cache helpers', () => {
  it('setCachedCodexCredentials / getCachedCodexAccessToken round-trip', () => {
    setCachedCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: 0 });
    expect(getCachedCodexAccessToken()).toBe('AT');
    setCachedCodexCredentials(undefined);
    expect(getCachedCodexAccessToken()).toBeUndefined();
  });
});

describe('hasCodexCredentials', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kova-codex-has-'));
    path = join(dir, 'openai.json');
    setCachedCodexCredentials(undefined);
    delete process.env.OPENAI_CODEX_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setCachedCodexCredentials(undefined);
    delete process.env.OPENAI_CODEX_API_KEY;
  });

  it('returns true when env var is set', () => {
    process.env.OPENAI_CODEX_API_KEY = 'token-from-env';
    expect(hasCodexCredentials(path)).toBe(true);
  });

  it('returns true when cache has credentials', () => {
    setCachedCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: 0 });
    expect(hasCodexCredentials(path)).toBe(true);
  });

  it('returns true when file exists on disk', () => {
    writeCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: 0 }, path);
    expect(hasCodexCredentials(path)).toBe(true);
  });

  it('returns false when nothing is configured', () => {
    expect(hasCodexCredentials(path)).toBe(false);
  });
});

describe('ensureFreshCodexToken', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kova-codex-fresh-'));
    path = join(dir, 'openai.json');
    setCachedCodexCredentials(undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setCachedCodexCredentials(undefined);
  });

  it('returns undefined and clears cache when no credentials file exists', async () => {
    setCachedCodexCredentials({ type: 'oauth', access: 'STALE', refresh: 'RT', expires: 0 });
    const result = await ensureFreshCodexToken({ path });
    expect(result).toBeUndefined();
    expect(getCachedCodexAccessToken()).toBeUndefined();
  });

  it('returns existing credentials and populates cache when not expiring', async () => {
    const fresh: CodexCredentials = {
      type: 'oauth',
      access: 'AT',
      refresh: 'RT',
      expires: 1_700_000_000_000,
      accountId: 'acct',
    };
    writeCodexCredentials(fresh, path);
    const fetchImpl = vi.fn();
    const result = await ensureFreshCodexToken({
      path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_699_990_000_000, // 10s before expiry but well within default margin
    });
    expect(result?.access).toBe('AT');
    expect(getCachedCodexAccessToken()).toBe('AT');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes when expiring and persists the new tokens', async () => {
    const stale: CodexCredentials = {
      type: 'oauth',
      access: 'OLD-AT',
      refresh: 'OLD-RT',
      expires: 100, // very old
      accountId: 'acct',
    };
    writeCodexCredentials(stale, path);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'NEW-AT', refresh_token: 'NEW-RT', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const result = await ensureFreshCodexToken({
      path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    });
    expect(result?.access).toBe('NEW-AT');
    expect(result?.refresh).toBe('NEW-RT');
    expect(result?.expires).toBe(1_700_000_000_000 + 3600 * 1000);
    expect(getCachedCodexAccessToken()).toBe('NEW-AT');

    // Verify the file was rewritten with the refreshed tokens
    const onDisk = readCodexCredentials(path);
    expect(onDisk?.access).toBe('NEW-AT');
    expect(onDisk?.accountId).toBe('acct'); // preserved
  });

  it('throws when refresh fails (loud startup error)', async () => {
    const stale: CodexCredentials = { type: 'oauth', access: 'OLD', refresh: 'OLD-RT', expires: 0 };
    writeCodexCredentials(stale, path);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      ensureFreshCodexToken({
        path,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => 1_700_000_000_000,
      }),
    ).rejects.toThrow(/Token refresh failed: 401/);
  });
});
