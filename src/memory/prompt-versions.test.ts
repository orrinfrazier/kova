import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectPromptChange,
  diffVersions,
  getSnapshot,
  getVersionHistory,
  hashPrompt,
  recordPromptVersion,
} from './prompt-versions.js';

describe('hashPrompt', () => {
  it('returns a 12-character hex string', () => {
    const hash = hashPrompt('some prompt content');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('returns the same hash for the same content', () => {
    const content = 'You are assessing a GitHub issue for feasibility.';
    expect(hashPrompt(content)).toBe(hashPrompt(content));
  });

  it('returns different hashes for different content', () => {
    const hash1 = hashPrompt('prompt version 1');
    const hash2 = hashPrompt('prompt version 2');
    expect(hash1).not.toBe(hash2);
  });

  it('hashes empty string without error', () => {
    const hash = hashPrompt('');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe('recordPromptVersion', () => {
  let workDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'kova-pv-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('stores a prompt snapshot file', async () => {
    const content = 'You are assessing a GitHub issue.';
    const version = await recordPromptVersion(workDir, 'assess', content);

    const snapshot = await getSnapshot(workDir, version.hash);
    expect(snapshot).toBe(content);
  });

  it('appends an entry to the version log', async () => {
    await recordPromptVersion(workDir, 'assess', 'prompt v1');
    await recordPromptVersion(workDir, 'spec', 'prompt v2');

    const history = await getVersionHistory(workDir);
    expect(history).toHaveLength(2);
    expect(history[0]?.wave).toBe('assess');
    expect(history[1]?.wave).toBe('spec');
  });

  it('returns a PromptVersion with correct fields', async () => {
    const content = 'test prompt';
    const version = await recordPromptVersion(workDir, 'impl', content);

    expect(version.wave).toBe('impl');
    expect(version.hash).toBe(hashPrompt(content));
    expect(version.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('deduplicates snapshot files for same content', async () => {
    const content = 'identical prompt';
    await recordPromptVersion(workDir, 'assess', content);
    await recordPromptVersion(workDir, 'spec', content);

    // Both should share the same snapshot file
    const hash = hashPrompt(content);
    const snapshot = await getSnapshot(workDir, hash);
    expect(snapshot).toBe(content);

    // But version log should have two entries
    const history = await getVersionHistory(workDir);
    expect(history).toHaveLength(2);
  });
});

describe('getVersionHistory', () => {
  let workDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'kova-pv-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns empty array when no versions exist', async () => {
    const history = await getVersionHistory(workDir);
    expect(history).toEqual([]);
  });

  it('filters by wave name', async () => {
    await recordPromptVersion(workDir, 'assess', 'assess v1');
    await recordPromptVersion(workDir, 'spec', 'spec v1');
    await recordPromptVersion(workDir, 'assess', 'assess v2');

    const assessHistory = await getVersionHistory(workDir, 'assess');
    expect(assessHistory).toHaveLength(2);
    expect(assessHistory.every((v) => v.wave === 'assess')).toBe(true);
  });

  it('skips malformed lines gracefully', async () => {
    await recordPromptVersion(workDir, 'assess', 'valid prompt');

    // Append a malformed line
    const logPath = join(workDir, '.kova', 'prompt-versions', 'versions.jsonl');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(logPath, 'NOT VALID JSON\n');

    const history = await getVersionHistory(workDir);
    expect(history).toHaveLength(1);
  });
});

describe('getSnapshot', () => {
  let workDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'kova-pv-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns null for non-existent hash', async () => {
    const snapshot = await getSnapshot(workDir, 'nonexistent1');
    expect(snapshot).toBeNull();
  });

  it('returns stored content for valid hash', async () => {
    const content = 'stored prompt content';
    const version = await recordPromptVersion(workDir, 'test', content);
    const snapshot = await getSnapshot(workDir, version.hash);
    expect(snapshot).toBe(content);
  });
});

describe('detectPromptChange', () => {
  let workDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'kova-pv-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns null when no previous version exists', async () => {
    const change = await detectPromptChange(workDir, 'assess', 'new prompt');
    expect(change).toBeNull();
  });

  it('returns null when prompt has not changed', async () => {
    const content = 'unchanged prompt';
    await recordPromptVersion(workDir, 'assess', content);

    const change = await detectPromptChange(workDir, 'assess', content);
    expect(change).toBeNull();
  });

  it('returns change info when prompt differs from last version', async () => {
    await recordPromptVersion(workDir, 'assess', 'old prompt content');

    const change = await detectPromptChange(workDir, 'assess', 'new prompt content');
    expect(change).not.toBeNull();
    expect(change?.previousHash).toBe(hashPrompt('old prompt content'));
    expect(change?.currentHash).toBe(hashPrompt('new prompt content'));
    expect(change?.wave).toBe('assess');
  });

  it('only compares against the same wave', async () => {
    await recordPromptVersion(workDir, 'spec', 'spec prompt');

    // assess has no previous version, so no change detected
    const change = await detectPromptChange(workDir, 'assess', 'assess prompt');
    expect(change).toBeNull();
  });
});

describe('diffVersions', () => {
  let workDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'kova-pv-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns null when either hash is not found', async () => {
    const diff = await diffVersions(workDir, 'nonexist1234', 'nonexist5678');
    expect(diff).toBeNull();
  });

  it('returns a diff string showing changes', async () => {
    const v1 = await recordPromptVersion(workDir, 'assess', 'line one\nline two\nline three');
    const v2 = await recordPromptVersion(workDir, 'assess', 'line one\nline modified\nline three');

    const diff = await diffVersions(workDir, v1.hash, v2.hash);
    expect(diff).not.toBeNull();
    expect(diff).toContain('line two');
    expect(diff).toContain('line modified');
  });

  it('returns empty diff for identical content', async () => {
    const content = 'same content';
    const v1 = await recordPromptVersion(workDir, 'assess', content);

    const diff = await diffVersions(workDir, v1.hash, v1.hash);
    // Same hash = no diff
    expect(diff).toBe('');
  });
});
