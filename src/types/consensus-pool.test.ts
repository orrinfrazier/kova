import { describe, expect, it } from 'vitest';

import { WaveConsensusConfigSchema, WaveModelConfigSchema } from './config.js';

describe('WaveConsensusConfigSchema', () => {
  it('parses a pool of mixed-provider tier strings and override objects', () => {
    const parsed = WaveConsensusConfigSchema.parse({
      pool: ['large', { provider: 'openai', model: 'gpt-4o' }, { provider: 'google', model: 'gemini-2.5-pro' }],
      adjudicator: 'large',
    });
    expect(parsed.pool).toHaveLength(3);
    expect(parsed.pool[0]).toBe('large');
    expect(parsed.pool[1]).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parsed.adjudicator).toBe('large');
  });

  it('accepts a pool of bare model strings', () => {
    const parsed = WaveConsensusConfigSchema.parse({
      pool: ['openai:gpt-4o', 'anthropic:claude-opus-4-6'],
    });
    expect(parsed.pool).toHaveLength(2);
    expect(parsed.pool[0]).toBe('openai:gpt-4o');
  });

  it('defaults adjudicator to "large" when omitted', () => {
    const parsed = WaveConsensusConfigSchema.parse({
      pool: ['large', { provider: 'openai', model: 'gpt-4o' }],
    });
    expect(parsed.adjudicator).toBe('large');
  });

  it('rejects a pool with fewer than 2 members', () => {
    expect(() => WaveConsensusConfigSchema.parse({ pool: ['large'] })).toThrow();
  });

  it('rejects a pool with more than 5 members', () => {
    expect(() =>
      WaveConsensusConfigSchema.parse({
        pool: ['large', 'large', 'large', 'large', 'large', 'large'],
      }),
    ).toThrow();
  });

  it('rejects a pool with invalid member', () => {
    expect(() =>
      WaveConsensusConfigSchema.parse({
        pool: ['large', 123 as unknown as string],
      }),
    ).toThrow();
  });

  it('parses adjudicator as an override object', () => {
    const parsed = WaveConsensusConfigSchema.parse({
      pool: ['large', { provider: 'openai', model: 'gpt-4o' }],
      adjudicator: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });
    expect(parsed.adjudicator).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });
});

describe('WaveModelConfigSchema with pool variant', () => {
  it('accepts a pool config as a wave model config', () => {
    const parsed = WaveModelConfigSchema.parse({
      pool: ['large', { provider: 'openai', model: 'gpt-4o' }],
      adjudicator: 'large',
    });
    expect(parsed).toMatchObject({ pool: expect.any(Array) });
  });

  it('still accepts tier strings as before', () => {
    expect(WaveModelConfigSchema.parse('large')).toBe('large');
    expect(WaveModelConfigSchema.parse('medium')).toBe('medium');
    expect(WaveModelConfigSchema.parse('small')).toBe('small');
  });

  it('still accepts override objects as before', () => {
    const parsed = WaveModelConfigSchema.parse({ provider: 'openai', model: 'gpt-4o' });
    expect(parsed).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('still accepts bare model strings as before', () => {
    const parsed = WaveModelConfigSchema.parse('claude-sonnet-4-6');
    expect(parsed).toBe('claude-sonnet-4-6');
  });
});
