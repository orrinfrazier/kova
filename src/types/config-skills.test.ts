// Tests for the `skills` config block (issue #298).
//
// kova waves can surface SKILL.md skills from configured dirs into wave system
// prompts. The schema must:
//   - default `dirs` to ~/.claude/skills + .kova/skills
//   - default `enabled_waves` to the reasoning + impl/quality waves
//   - allow explicit overrides for both
//   - validate wave names
//   - reject empty/blank dir strings

import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from './config.js';

describe('RepoConfigSchema — skills block', () => {
  it('omits skills block when not provided (preserves backward compat)', () => {
    const parsed = RepoConfigSchema.safeParse({ path: '/opt/repo' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // When the user has not configured skills, the field should be absent
      // (or undefined) — callers gate skill loading on its presence.
      expect(parsed.data.skills).toBeUndefined();
    }
  });

  it('accepts an empty skills block and applies defaults', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills).toBeDefined();
      expect(parsed.data.skills?.dirs).toEqual(['~/.claude/skills', '.kova/skills']);
      expect(parsed.data.skills?.enabled_waves).toEqual(['assess', 'spec', 'impl', 'quality', 'review', 'brainstorm']);
    }
  });

  it('accepts explicit dirs override', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { dirs: ['/custom/skills', './other'] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills?.dirs).toEqual(['/custom/skills', './other']);
    }
  });

  it('accepts explicit enabled_waves override', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { enabled_waves: ['impl', 'quality'] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills?.enabled_waves).toEqual(['impl', 'quality']);
    }
  });

  it('accepts an explicit empty dirs array (effectively disables loading)', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { dirs: [] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills?.dirs).toEqual([]);
    }
  });

  it('rejects blank-string dirs', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { dirs: [''] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown wave names in enabled_waves', () => {
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { enabled_waves: ['not-a-wave'] },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts wave: ship in enabled_waves (no-op at runtime, but valid)', () => {
    // `ship` is an orchestrator-only wave (no AI agent), so listing it in
    // enabled_waves has no runtime effect. But the schema should still accept
    // it — keeps the user's intent loss-less and avoids surprising rejections.
    const parsed = RepoConfigSchema.safeParse({
      path: '/opt/repo',
      skills: { enabled_waves: ['ship'] },
    });
    expect(parsed.success).toBe(true);
  });
});
