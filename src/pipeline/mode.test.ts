import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from '../types/index.js';
import { applyPipelineMode, autoSelectMode, describeAutoSelection, PIPELINE_MODES } from './mode.js';

function makeConfig(
  overrides: Partial<{
    test: 'small' | 'medium' | 'large';
    impl: 'small' | 'medium' | 'large';
    quality: 'small' | 'medium' | 'large';
    assess: 'small' | 'medium' | 'large';
    spec: 'small' | 'medium' | 'large';
    review: 'small' | 'medium' | 'large';
  }> = {},
) {
  return RepoConfigSchema.parse({
    path: '/tmp/repo',
    model: {
      assess: overrides.assess ?? 'large',
      spec: overrides.spec ?? 'large',
      test: overrides.test ?? 'medium',
      impl: overrides.impl ?? 'medium',
      quality: overrides.quality ?? 'small',
      review: overrides.review ?? 'large',
      brainstorm: 'large',
    },
  });
}

describe('PIPELINE_MODES', () => {
  it('lists the four canonical modes', () => {
    expect(PIPELINE_MODES).toEqual(['simple', 'standard', 'economy', 'explore']);
  });
});

describe('applyPipelineMode', () => {
  describe('standard mode', () => {
    it('returns config unchanged', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'standard');
      expect(out.model.test).toBe('medium');
      expect(out.model.impl).toBe('medium');
      expect(out.model.quality).toBe('small');
    });

    it('preserves spec, assess, review tiers', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'standard');
      expect(out.model.spec).toBe('large');
      expect(out.model.assess).toBe('large');
      expect(out.model.review).toBe('large');
    });
  });

  describe('simple mode', () => {
    it('keeps tiers unchanged (simple is inline + 1 attempt, not cheaper models)', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'simple');
      expect(out.model.test).toBe('medium');
      expect(out.model.impl).toBe('medium');
      expect(out.model.quality).toBe('small');
    });

    it('preserves spec, assess, review tiers', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'simple');
      expect(out.model.spec).toBe('large');
      expect(out.model.review).toBe('large');
    });
  });

  describe('economy mode', () => {
    it('routes test/impl/quality to small tier', () => {
      const cfg = makeConfig({ test: 'large', impl: 'large', quality: 'medium' });
      const out = applyPipelineMode(cfg, 'economy');
      expect(out.model.test).toBe('small');
      expect(out.model.impl).toBe('small');
      expect(out.model.quality).toBe('small');
    });

    it('does NOT downgrade spec, assess, review (per CLAUDE.md phase-level policy)', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'economy');
      expect(out.model.spec).toBe('large');
      expect(out.model.assess).toBe('large');
      expect(out.model.review).toBe('large');
    });

    it('never silently upgrades — already-small T/I/Q stay small', () => {
      const cfg = makeConfig({ test: 'small', impl: 'small', quality: 'small' });
      const out = applyPipelineMode(cfg, 'economy');
      expect(out.model.test).toBe('small');
      expect(out.model.impl).toBe('small');
      expect(out.model.quality).toBe('small');
    });

    it('returns a new config object — does not mutate the input', () => {
      const cfg = makeConfig({ test: 'large', impl: 'large' });
      const out = applyPipelineMode(cfg, 'economy');
      expect(out).not.toBe(cfg);
      expect(cfg.model.test).toBe('large');
      expect(cfg.model.impl).toBe('large');
    });
  });

  describe('explore mode', () => {
    it('routes test/impl to large tier', () => {
      const cfg = makeConfig({ test: 'small', impl: 'small' });
      const out = applyPipelineMode(cfg, 'explore');
      expect(out.model.test).toBe('large');
      expect(out.model.impl).toBe('large');
    });

    it('keeps quality on its configured tier (explore is about breadth, not gates)', () => {
      const cfg = makeConfig({ quality: 'small' });
      const out = applyPipelineMode(cfg, 'explore');
      expect(out.model.quality).toBe('small');
    });

    it('preserves spec, assess, review tiers', () => {
      const cfg = makeConfig();
      const out = applyPipelineMode(cfg, 'explore');
      expect(out.model.spec).toBe('large');
      expect(out.model.assess).toBe('large');
      expect(out.model.review).toBe('large');
    });
  });

  describe('never silently upgrades cost', () => {
    it('economy never raises a tier — only downgrades or keeps', () => {
      const cfg = makeConfig({ test: 'small', impl: 'medium', quality: 'small' });
      const out = applyPipelineMode(cfg, 'economy');
      // small stays small, medium → small (downgrade), small stays small
      expect(out.model.test).toBe('small');
      expect(out.model.impl).toBe('small');
      expect(out.model.quality).toBe('small');
    });

    it('standard mode does not change any tier even when configured cheap', () => {
      const cfg = makeConfig({ test: 'small', impl: 'small', quality: 'small' });
      const out = applyPipelineMode(cfg, 'standard');
      expect(out.model.test).toBe('small');
      expect(out.model.impl).toBe('small');
      expect(out.model.quality).toBe('small');
    });
  });
});

describe('autoSelectMode', () => {
  describe('grade A', () => {
    it('with 1-2 files → simple', () => {
      expect(autoSelectMode('A', 1)).toBe('simple');
      expect(autoSelectMode('A', 2)).toBe('simple');
    });

    it('with 3+ files → economy', () => {
      expect(autoSelectMode('A', 3)).toBe('economy');
      expect(autoSelectMode('A', 5)).toBe('economy');
    });
  });

  describe('grade B', () => {
    it('always → economy regardless of file count', () => {
      expect(autoSelectMode('B', 1)).toBe('economy');
      expect(autoSelectMode('B', 5)).toBe('economy');
      expect(autoSelectMode('B', 12)).toBe('economy');
    });
  });

  describe('grade C', () => {
    it('always → standard (give opus context for complex work)', () => {
      expect(autoSelectMode('C', 1)).toBe('standard');
      expect(autoSelectMode('C', 10)).toBe('standard');
      expect(autoSelectMode('C', 30)).toBe('standard');
    });
  });

  describe('grades D and F', () => {
    it('grade D → standard (these are gated out at WAVE A but pick a safe default)', () => {
      expect(autoSelectMode('D', 5)).toBe('standard');
    });

    it('grade F → standard', () => {
      expect(autoSelectMode('F', 5)).toBe('standard');
    });
  });

  describe('never auto-selects explore', () => {
    it('explore is opt-in only — user must pass --mode explore explicitly', () => {
      for (const grade of ['A', 'B', 'C', 'D', 'F'] as const) {
        for (const files of [0, 1, 2, 5, 10, 20]) {
          expect(autoSelectMode(grade, files)).not.toBe('explore');
        }
      }
    });
  });
});

describe('describeAutoSelection', () => {
  it('produces a human-readable reason string', () => {
    const reason = describeAutoSelection('A', 1, 'simple');
    expect(reason).toContain('Grade A');
    expect(reason).toContain('1 file');
    expect(reason.toLowerCase()).toContain('simple');
  });

  it('mentions grade and file count', () => {
    const reason = describeAutoSelection('B', 5, 'economy');
    expect(reason).toContain('Grade B');
    expect(reason).toContain('5');
  });
});
