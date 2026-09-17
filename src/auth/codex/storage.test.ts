import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CodexCredentials,
  defaultCodexCredentialsPath,
  isExpiring,
  readCodexCredentials,
  writeCodexCredentials,
} from './storage.js';

describe('defaultCodexCredentialsPath', () => {
  it('honors KOVA_AUTH_DIR when set', () => {
    const prev = process.env.KOVA_AUTH_DIR;
    process.env.KOVA_AUTH_DIR = '/tmp/kova-test-dir';
    try {
      expect(defaultCodexCredentialsPath()).toBe('/tmp/kova-test-dir/openai.json');
    } finally {
      if (prev === undefined) delete process.env.KOVA_AUTH_DIR;
      else process.env.KOVA_AUTH_DIR = prev;
    }
  });

  it('uses ~/.kova/auth when KOVA_AUTH_DIR is unset', () => {
    const prev = process.env.KOVA_AUTH_DIR;
    delete process.env.KOVA_AUTH_DIR;
    try {
      const path = defaultCodexCredentialsPath();
      expect(path).toMatch(/\.kova\/auth\/openai\.json$/);
    } finally {
      if (prev !== undefined) process.env.KOVA_AUTH_DIR = prev;
    }
  });
});

describe('writeCodexCredentials + readCodexCredentials', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kova-codex-storage-'));
    path = join(dir, 'openai.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a credentials object', () => {
    const creds: CodexCredentials = {
      type: 'oauth',
      access: 'AT',
      refresh: 'RT',
      expires: 1_700_000_000_000,
      accountId: 'acct_1',
    };
    writeCodexCredentials(creds, path);
    const loaded = readCodexCredentials(path);
    expect(loaded).toEqual(creds);
  });

  it('writes the file with 0600 perms on POSIX', () => {
    writeCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: 0 }, path);
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('returns undefined when the file does not exist', () => {
    expect(readCodexCredentials(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('throws when the file is malformed JSON', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, '{not json');
    expect(() => readCodexCredentials(path)).toThrow();
  });

  it('throws when required fields are missing', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, JSON.stringify({ type: 'oauth', access: 'AT' }));
    expect(() => readCodexCredentials(path)).toThrow(/Malformed credentials/);
  });

  it('creates parent dir when it does not exist', () => {
    const nested = join(dir, 'nested', 'sub', 'openai.json');
    writeCodexCredentials({ type: 'oauth', access: 'AT', refresh: 'RT', expires: 0 }, nested);
    expect(readCodexCredentials(nested)?.access).toBe('AT');
  });
});

describe('isExpiring', () => {
  it('returns true when remaining lifetime is under the margin', () => {
    expect(isExpiring({ type: 'oauth', access: 'A', refresh: 'R', expires: 1000 }, 5000, 0)).toBe(true);
  });

  it('returns false when remaining lifetime exceeds the margin', () => {
    expect(isExpiring({ type: 'oauth', access: 'A', refresh: 'R', expires: 10_000 }, 5000, 0)).toBe(false);
  });

  it('treats already-expired as expiring', () => {
    expect(isExpiring({ type: 'oauth', access: 'A', refresh: 'R', expires: 1000 }, 5000, 2000)).toBe(true);
  });
});
