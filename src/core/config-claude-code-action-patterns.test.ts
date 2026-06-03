/**
 * Schema tests for the two new repos.yaml fields borrowed from claude-code-action:
 *   - branch_name_template (top-level on a repo)
 *   - review.classify_inline (gated review-classifier opt-in)
 *
 * Both fields default to today's behavior — no breaking change for existing
 * configs. Issue #320 — pattern 2 + pattern 3.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kova-cca-patterns-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('branch_name_template config field', () => {
  it('defaults to undefined when absent', async () => {
    const yaml = `repos:\n  r:\n    path: /tmp/r\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    expect(config.repos.r?.branch_name_template).toBeUndefined();
  });

  it('parses a custom template string', async () => {
    const yaml = `repos:
  r:
    path: /tmp/r
    branch_name_template: '{{prefix}}{{entityType}}-{{entityNumber}}-{{description}}'
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    expect(config.repos.r?.branch_name_template).toBe('{{prefix}}{{entityType}}-{{entityNumber}}-{{description}}');
  });

  it('rejects non-string values', async () => {
    const yaml = `repos:\n  r:\n    path: /tmp/r\n    branch_name_template: 42\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow();
  });
});

describe('review.classify_inline config field', () => {
  it('defaults to false when absent', async () => {
    const yaml = `repos:\n  r:\n    path: /tmp/r\n`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    expect(config.repos.r?.review?.classify_inline).toBe(false);
  });

  it('parses classify_inline: true', async () => {
    const yaml = `repos:
  r:
    path: /tmp/r
    review:
      classify_inline: true
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    const config = await loadConfig(join(tempDir, 'repos.yaml'));
    expect(config.repos.r?.review?.classify_inline).toBe(true);
  });

  it('rejects non-boolean values', async () => {
    const yaml = `repos:
  r:
    path: /tmp/r
    review:
      classify_inline: maybe
`;
    await writeFile(join(tempDir, 'repos.yaml'), yaml);
    await expect(loadConfig(join(tempDir, 'repos.yaml'))).rejects.toThrow();
  });
});
