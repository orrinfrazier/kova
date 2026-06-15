import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setCachedCodexCredentials, writeCodexCredentials } from '../auth/codex/index.js';
import type { RepoConfig } from '../types/index.js';
import { configUsesCodex, prepareSubscriptionAuth } from './auth-wiring.js';

/** Build a minimal RepoConfig with a single wave's model overridden. */
function repoWithModel(modelSpec: string | { provider: string; model: string }, wave: keyof RepoConfig['model'] = 'impl'): RepoConfig {
  return {
    path: '/tmp/fake',
    model: {
      assess: 'large',
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
      brainstorm: 'large',
      thinking: {},
      [wave]: modelSpec,
    },
  } as unknown as RepoConfig;
}

describe('configUsesCodex', () => {
  it('returns false for a baseline config with no codex models', () => {
    expect(configUsesCodex(repoWithModel('large'))).toBe(false);
  });

  it('returns true when a wave uses an openai-codex: string', () => {
    expect(configUsesCodex(repoWithModel('openai-codex:gpt-5.4'))).toBe(true);
  });

  it('returns true when a wave uses an {provider:openai-codex} override', () => {
    expect(configUsesCodex(repoWithModel({ provider: 'openai-codex', model: 'gpt-5.4' }))).toBe(true);
  });

  it('returns true when a consensus pool member uses codex', () => {
    const config = {
      path: '/tmp/fake',
      model: {
        assess: 'large',
        spec: 'large',
        test: 'medium',
        impl: 'medium',
        quality: 'small',
        review: {
          pool: ['large', 'openai-codex:gpt-5.4', 'anthropic:claude-opus-4-6'],
          adjudicator: 'large',
        },
        brainstorm: 'large',
        thinking: {},
      },
    } as unknown as RepoConfig;
    expect(configUsesCodex(config)).toBe(true);
  });

  it('returns true when an adjudicator uses codex', () => {
    const config = {
      path: '/tmp/fake',
      model: {
        assess: 'large',
        spec: 'large',
        test: 'medium',
        impl: 'medium',
        quality: 'small',
        review: {
          pool: ['large', 'large'],
          adjudicator: 'openai-codex:gpt-5.4',
        },
        brainstorm: 'large',
        thinking: {},
      },
    } as unknown as RepoConfig;
    expect(configUsesCodex(config)).toBe(true);
  });
});

describe('prepareSubscriptionAuth', () => {
  let dir: string;
  let path: string;
  let prevAuthDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kova-codex-auth-wiring-'));
    path = join(dir, 'openai.json');
    setCachedCodexCredentials(undefined);
    prevAuthDir = process.env.KOVA_AUTH_DIR;
    process.env.KOVA_AUTH_DIR = dir;
    delete process.env.OPENAI_CODEX_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setCachedCodexCredentials(undefined);
    if (prevAuthDir === undefined) delete process.env.KOVA_AUTH_DIR;
    else process.env.KOVA_AUTH_DIR = prevAuthDir;
  });

  it('is a no-op when config does not use codex', async () => {
    await expect(prepareSubscriptionAuth(repoWithModel('large'))).resolves.toBeUndefined();
  });

  it('throws a helpful error when codex is referenced but no credentials exist', async () => {
    await expect(prepareSubscriptionAuth(repoWithModel('openai-codex:gpt-5.4'))).rejects.toThrow(
      /Codex provider is referenced.*kova auth login --codex/i,
    );
  });

  it('passes when codex is referenced and credentials exist on disk', async () => {
    // Far-future expiry so no refresh is attempted (and no fetch is called)
    writeCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: Date.now() + 86_400_000 }, path);
    await expect(prepareSubscriptionAuth(repoWithModel('openai-codex:gpt-5.4'))).resolves.toBeUndefined();
  });
});
