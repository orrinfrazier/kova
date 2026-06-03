// Tests for pool-spec parsing + config mutation helpers (#261).
//
// `parsePoolSpec` accepts either the literal `'diverse'` (canonical 3-member
// cross-family pool) or a comma-separated `provider:model` list, returning
// 2-5 `WaveSingleModelConfig` entries the consensus path can consume.
//
// `parseConsensusWavesList` accepts a comma list of wave names and validates
// each against the FixAIWaveName enum.
//
// `applyConsensusToConfig` mutates `config.model[wave]` to a
// `WaveConsensusConfig` for each requested wave. The adjudicator stays at the
// schema default (`'large'`) since the issue body explicitly lets that default
// stand; explicit-adjudicator overrides are not part of the AC.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateModelConfig } from '../ai/index.js';
import { RepoConfigSchema } from '../types/config.js';
import {
  applyConsensusToConfig,
  DEFAULT_CONSENSUS_WAVES,
  formatConsensusActivationLog,
  parseConsensusWavesList,
  parsePoolSpec,
} from './consensus-flags.js';

describe('parsePoolSpec', () => {
  it('expands "diverse" to canonical 3-member cross-family pool', () => {
    const pool = parsePoolSpec('diverse');
    expect(pool).toHaveLength(3);
    // Order/exact ids are spec-defined; assert the providers cover the three
    // families the issue body called out (anthropic, openai, google).
    const providers = pool.map((p) => (typeof p === 'string' ? p.split(':')[0] : p.provider));
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('google');
  });

  it('parses comma-separated provider:model list', () => {
    const pool = parsePoolSpec('anthropic:claude-opus-4-6,openai:gpt-4o,google:gemini-2.5-pro');
    expect(pool).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'google', model: 'gemini-2.5-pro' },
    ]);
  });

  it('trims whitespace inside the list', () => {
    const pool = parsePoolSpec(' anthropic:claude-opus-4-6 , openai:gpt-4o , google:gemini-2.5-pro ');
    expect(pool).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'google', model: 'gemini-2.5-pro' },
    ]);
  });

  it('accepts pool member as a tier string (small|medium|large)', () => {
    const pool = parsePoolSpec('large,medium,small');
    // Tier strings are emitted as plain strings — `WaveSingleModelConfigSchema`
    // accepts the `ModelTier | WaveModelOverride | string` union.
    expect(pool).toEqual(['large', 'medium', 'small']);
  });

  it('rejects pool with fewer than 2 entries', () => {
    expect(() => parsePoolSpec('anthropic:claude-opus-4-6')).toThrow(/at least 2/i);
  });

  it('rejects pool with more than 5 entries', () => {
    expect(() => parsePoolSpec('a:1,b:2,c:3,d:4,e:5,f:6')).toThrow(/at most 5/i);
  });

  it('rejects empty pool spec', () => {
    expect(() => parsePoolSpec('')).toThrow(/empty/i);
  });

  it('rejects pool member missing the provider:model separator', () => {
    expect(() => parsePoolSpec('anthropic:claude-opus-4-6,just-a-model,openai:gpt-4o')).toThrow(/provider:model/i);
  });
});

describe('parseConsensusWavesList', () => {
  it('parses single wave', () => {
    expect(parseConsensusWavesList('review')).toEqual(['review']);
  });

  it('parses comma-separated waves with whitespace tolerance', () => {
    expect(parseConsensusWavesList(' assess , spec , review ')).toEqual(['assess', 'spec', 'review']);
  });

  it('rejects empty list', () => {
    expect(() => parseConsensusWavesList('')).toThrow(/empty/i);
  });

  it('rejects unknown wave name with valid waves listed', () => {
    expect(() => parseConsensusWavesList('assess,foobar,review')).toThrow(/foobar/);
    expect(() => parseConsensusWavesList('foobar')).toThrow(/valid waves/i);
  });

  it('deduplicates repeated waves (last-wins semantics)', () => {
    expect(parseConsensusWavesList('assess,review,assess')).toEqual(['assess', 'review']);
  });
});

describe('DEFAULT_CONSENSUS_WAVES', () => {
  it('defaults to the high-stakes triple the issue body specified', () => {
    expect(DEFAULT_CONSENSUS_WAVES).toEqual(['assess', 'spec', 'review']);
  });
});

describe('applyConsensusToConfig', () => {
  const baseConfig = RepoConfigSchema.parse({ path: '/tmp/repo' });

  it('mutates config.model[wave] to a WaveConsensusConfig for each requested wave', () => {
    const pool = parsePoolSpec('diverse');
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: ['assess', 'review'],
    });
    expect(mutated.model.assess).toMatchObject({
      pool: expect.arrayContaining([expect.anything()]),
      adjudicator: 'large',
    });
    expect((mutated.model.assess as { pool: unknown[] }).pool).toHaveLength(3);
    expect(mutated.model.review).toMatchObject({
      pool: expect.arrayContaining([expect.anything()]),
      adjudicator: 'large',
    });
    // Untouched wave stays single-model.
    expect(mutated.model.impl).toBe(baseConfig.model.impl);
  });

  it('returns a NEW config object without mutating the input', () => {
    const pool = parsePoolSpec('diverse');
    const originalAssess = baseConfig.model.assess;
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: ['assess'],
    });
    expect(baseConfig.model.assess).toBe(originalAssess); // unchanged
    expect(mutated.model.assess).not.toBe(originalAssess); // new
  });

  it('passes the resulting config through Zod RepoConfigSchema without errors', () => {
    const pool = parsePoolSpec('diverse');
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: DEFAULT_CONSENSUS_WAVES,
    });
    // Round-trip through the schema to confirm WaveModelConfigSchema accepts
    // the pool variant for each wave we touched.
    expect(() => RepoConfigSchema.parse(mutated)).not.toThrow();
  });

  it('accepts a custom adjudicator', () => {
    const pool = parsePoolSpec('diverse');
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: ['review'],
      adjudicator: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });
    expect(mutated.model.review).toMatchObject({
      adjudicator: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });
  });
});

describe('formatConsensusActivationLog', () => {
  it('renders a one-line announcement with pool size and Nx cost hint', () => {
    const pool = parsePoolSpec('diverse');
    const line = formatConsensusActivationLog({
      pool,
      waves: ['assess', 'spec', 'review'],
    });
    expect(line).toMatch(/consensus/i);
    expect(line).toMatch(/3 member/);
    expect(line).toMatch(/assess, spec, review/);
    // ~3x cost hint surfaces the per-wave pool size multiplier so the user
    // sees the cost implication without reading the source.
    expect(line).toMatch(/~3x|~3×|~3 ?× ?cost/i);
  });
});

describe('consensus flags integrate with validateModelConfig', () => {
  // Snapshot + restore process.env to keep the suite hermetic — pool members
  // resolve providers that need API key env vars to be present (or explicitly
  // absent for the fail-fast test).
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('validateModelConfig PASSES when every pool member has its API key set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'AIza-test';

    const baseConfig = RepoConfigSchema.parse({ path: '/tmp/repo' });
    const pool = parsePoolSpec('diverse');
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: DEFAULT_CONSENSUS_WAVES,
    });
    expect(() => validateModelConfig(mutated)).not.toThrow();
  });

  it('validateModelConfig FAILS FAST when a pool member is missing its API key', () => {
    // Provide anthropic + openai keys but withhold google keys — gemini member
    // in the diverse pool should trip validation with a clear "wave/pool[i]"
    // locator per the issue AC ("Missing key for a member fails fast at startup").
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const baseConfig = RepoConfigSchema.parse({ path: '/tmp/repo' });
    const pool = parsePoolSpec('diverse');
    const mutated = applyConsensusToConfig(baseConfig, {
      pool,
      waves: ['review'],
    });
    expect(() => validateModelConfig(mutated)).toThrow(/pool\[/);
  });
});
