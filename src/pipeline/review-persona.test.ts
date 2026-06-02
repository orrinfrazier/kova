// Tests for the reviewer persona selector and prompt loader.
// Personas are picked by issue labels first, then by module-name heuristic on
// assess.modules_affected, defaulting to the generalist when nothing matches.

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fs } from 'zx';
import { loadReviewPersonaPrompt, selectReviewerPersona } from './review-persona.js';

describe('selectReviewerPersona', () => {
  it('returns generalist when no labels or modules match', () => {
    expect(selectReviewerPersona({ labels: ['enhancement', 'docs'], modulesAffected: ['src/cli'] })).toBe('generalist');
  });

  it('returns generalist when both inputs are empty', () => {
    expect(selectReviewerPersona({ labels: [], modulesAffected: [] })).toBe('generalist');
  });

  it('selects security when a security-flavored label is present', () => {
    expect(selectReviewerPersona({ labels: ['security'], modulesAffected: ['src/foo'] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['auth'], modulesAffected: [] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['crypto'], modulesAffected: [] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['vulnerability'], modulesAffected: [] })).toBe('security');
  });

  it('selects performance when a performance-flavored label is present', () => {
    expect(selectReviewerPersona({ labels: ['performance'], modulesAffected: [] })).toBe('performance');
    expect(selectReviewerPersona({ labels: ['perf'], modulesAffected: [] })).toBe('performance');
    expect(selectReviewerPersona({ labels: ['slow'], modulesAffected: [] })).toBe('performance');
    expect(selectReviewerPersona({ labels: ['optimization'], modulesAffected: [] })).toBe('performance');
  });

  it('selects architecture when an architecture-flavored label is present', () => {
    expect(selectReviewerPersona({ labels: ['architecture'], modulesAffected: [] })).toBe('architecture');
    expect(selectReviewerPersona({ labels: ['refactor'], modulesAffected: [] })).toBe('architecture');
    expect(selectReviewerPersona({ labels: ['tech-debt'], modulesAffected: [] })).toBe('architecture');
    expect(selectReviewerPersona({ labels: ['design'], modulesAffected: [] })).toBe('architecture');
  });

  it('matches labels case-insensitively', () => {
    expect(selectReviewerPersona({ labels: ['Security'], modulesAffected: [] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['PERF'], modulesAffected: [] })).toBe('performance');
    expect(selectReviewerPersona({ labels: ['Refactor'], modulesAffected: [] })).toBe('architecture');
  });

  it('falls back to module heuristics when no label matches', () => {
    expect(selectReviewerPersona({ labels: ['enhancement'], modulesAffected: ['src/auth/login.ts'] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['bug'], modulesAffected: ['src/perf/cache.ts'] })).toBe('performance');
    expect(selectReviewerPersona({ labels: ['enhancement'], modulesAffected: ['src/services/cache.ts'] })).toBe(
      'performance',
    );
    expect(selectReviewerPersona({ labels: ['bug'], modulesAffected: ['src/cli/index.ts'] })).toBe('generalist');
  });

  it('prefers label match over module heuristic when both fire (labels beat modules)', () => {
    // Label says performance, modules say security → label wins.
    expect(selectReviewerPersona({ labels: ['performance'], modulesAffected: ['src/auth/login.ts'] })).toBe(
      'performance',
    );
  });

  it('returns the first matching persona when multiple categories of labels are present (security > performance > architecture priority)', () => {
    expect(selectReviewerPersona({ labels: ['performance', 'security'], modulesAffected: [] })).toBe('security');
    expect(selectReviewerPersona({ labels: ['refactor', 'performance'], modulesAffected: [] })).toBe('performance');
  });
});

describe('loadReviewPersonaPrompt', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kova-persona-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads the persona file from review/<persona>.md when present in custom promptsDir', async () => {
    const reviewDir = path.join(tmpDir, 'review');
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(path.join(reviewDir, 'security.md'), '# Security persona\nCustom content', 'utf-8');

    const prompt = await loadReviewPersonaPrompt('security', undefined, undefined, tmpDir);
    expect(prompt).toContain('Security persona');
    expect(prompt).toContain('Custom content');
  });

  it('falls back to the built-in default generalist review prompt when custom dir has no persona file', async () => {
    // tmpDir has no review/ subfolder — must fall back to built-in default.
    const prompt = await loadReviewPersonaPrompt('generalist', undefined, undefined, tmpDir);
    // Built-in prompts/review.md has this top-level heading.
    expect(prompt).toContain('Code Review');
  });

  it('falls back to the generic review.md when the persona file is missing in a custom promptsDir', async () => {
    // Custom dir has its own review.md but no review/ subfolder.
    await fs.writeFile(path.join(tmpDir, 'review.md'), '# Custom generic review prompt body', 'utf-8');

    const prompt = await loadReviewPersonaPrompt('performance', undefined, undefined, tmpDir);
    expect(prompt).toContain('Custom generic review prompt body');
  });

  it('loads the built-in persona files shipped in prompts/review/ when no custom promptsDir is provided', async () => {
    // No custom dir → must find the persona inside the built-in default prompts dir.
    const prompt = await loadReviewPersonaPrompt('security', undefined, undefined, undefined);
    // Look for a token that's specific to the security persona body — see prompts/review/security.md.
    expect(prompt.toLowerCase()).toContain('security');
  });
});
