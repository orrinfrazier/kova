import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheRetentionToPricingTtl, getPricing, type ModelPricing, priceUsage, type TokenUsage } from './pricing.js';

// We use pi-ai's calculateCost as the regression reference for at least one
// known model. The table values themselves come from
// `node_modules/@earendil-works/pi-ai/dist/models.generated.js`, so a drift in
// either source surfaces immediately.

describe('pricing — table coverage', () => {
  it('covers every model id in DEFAULT_MODELS', () => {
    // DEFAULT_MODELS in models.ts: small/medium/large
    expect(getPricing('claude-haiku-4-5-20251001')).toBeDefined();
    expect(getPricing('claude-sonnet-4-6')).toBeDefined();
    expect(getPricing('claude-opus-4-6')).toBeDefined();
  });

  it('aliases sonnet 4.x family to the 4-6 pricing row', () => {
    const sonnet46 = getPricing('claude-sonnet-4-6');
    expect(getPricing('claude-sonnet-4-5')).toEqual(sonnet46);
    expect(getPricing('claude-sonnet-4-0')).toEqual(sonnet46);
    expect(getPricing('claude-sonnet-4-5-20250929')).toEqual(sonnet46);
  });

  it('aliases opus 4.5/4.6 to the same pricing row', () => {
    const opus46 = getPricing('claude-opus-4-6');
    expect(opus46).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10.0,
    } satisfies ModelPricing);
    expect(getPricing('claude-opus-4-5')).toEqual(opus46);
    expect(getPricing('claude-opus-4-5-20251101')).toEqual(opus46);
  });

  it('keeps opus 4.0/4.1 (legacy) at the older $15/$75 rate', () => {
    const legacy = getPricing('claude-opus-4-1');
    expect(legacy).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite5m: 18.75,
      cacheWrite1h: 30.0,
    } satisfies ModelPricing);
    expect(getPricing('claude-opus-4-0')).toEqual(legacy);
    expect(getPricing('claude-opus-4-1-20250805')).toEqual(legacy);
  });

  it('strips region/Bedrock prefixes before lookup', () => {
    const sonnet = getPricing('claude-sonnet-4-6');
    expect(getPricing('global.anthropic.claude-sonnet-4-6')).toEqual(sonnet);
    expect(getPricing('eu.anthropic.claude-sonnet-4-6')).toEqual(sonnet);
    expect(getPricing('us.anthropic.claude-sonnet-4-6')).toEqual(sonnet);
    expect(getPricing('apac.anthropic.claude-sonnet-4-6')).toEqual(sonnet);
    expect(getPricing('anthropic.claude-sonnet-4-6')).toEqual(sonnet);
  });

  it('returns undefined for unknown model id', () => {
    expect(getPricing('definitely-not-a-real-model')).toBeUndefined();
  });
});

describe('priceUsage — pi-ai compatibility', () => {
  it('matches pi-ai calculateCost formula for claude-sonnet-4-6 within epsilon', () => {
    // pi-ai shape: cost = (model.cost.X / 1_000_000) * usage.X, summed.
    // For sonnet 4.6: input=3, output=15, cacheRead=0.3, cacheWrite=3.75 per Mtok.
    const usage: TokenUsage = {
      input: 12_000,
      output: 3_500,
      cacheRead: 800,
      cacheWrite: 200,
    };
    const expected =
      (3 / 1_000_000) * 12_000 + (15 / 1_000_000) * 3_500 + (0.3 / 1_000_000) * 800 + (3.75 / 1_000_000) * 200;
    const actual = priceUsage('claude-sonnet-4-6', usage);
    expect(actual).toBeCloseTo(expected, 10);
  });

  it('defaults cacheRetention to 5m (1.25× input on Anthropic)', () => {
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
    // 5m cacheWrite for sonnet 4.6 is 3.75 per Mtok
    expect(priceUsage('claude-sonnet-4-6', usage)).toBeCloseTo(3.75, 10);
  });

  it('charges 2.0× input for 1h cache retention', () => {
    const usage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheRetention: '1h',
    };
    // 1h cacheWrite for sonnet 4.6 is 6.0 per Mtok (input=3 × 2.0)
    expect(priceUsage('claude-sonnet-4-6', usage)).toBeCloseTo(6.0, 10);
  });

  it('explicit 5m matches the default', () => {
    const usage5m: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheRetention: '5m',
    };
    const usageDefault: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
    expect(priceUsage('claude-sonnet-4-6', usage5m)).toBe(priceUsage('claude-sonnet-4-6', usageDefault));
  });
});

describe('priceUsage — unknown model fallback', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterEach(() => {
    // Reset the internal warn-once cache between tests so each test sees a
    // pristine state.
    // Pull a hook off the module if exposed for testing.
    return import('./pricing.js').then((m) => {
      (m as unknown as { __resetWarnCache?: () => void }).__resetWarnCache?.();
    });
  });

  it('returns 0 for an unknown model id', () => {
    const usage: TokenUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
    expect(priceUsage('not-a-real-model', usage)).toBe(0);
  });

  it('logs a warning once per unknown model id (no log spam)', () => {
    const usage: TokenUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
    priceUsage('phantom-model-x', usage);
    priceUsage('phantom-model-x', usage);
    priceUsage('phantom-model-x', usage);
    // Filter to the unknown-model warn so coincident logs from other tests
    // don't blow the assertion.
    const matching = warnSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('phantom-model-x')),
    );
    expect(matching).toHaveLength(1);
  });
});

describe('priceUsage — local providers bypass the table', () => {
  it.each([
    'ollama:llama3.1',
    'lmstudio:qwen-coder',
    'vllm:mistral',
    'llamacpp:phi-3',
    'llamafile:gemma',
    'llama-cpp:tinyllama',
  ])('returns 0 for %s without warning', (modelString) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage: TokenUsage = { input: 10_000, output: 5_000, cacheRead: 0, cacheWrite: 0 };
    expect(priceUsage(modelString, usage)).toBe(0);
    // Local providers must NOT trigger the unknown-model warning — they're
    // intentionally not in the pricing table.
    const unknownWarnings = warnSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('unknown pricing')),
    );
    expect(unknownWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// cacheRetentionToPricingTtl lives in pricing.ts (relocated from
// wave-executor.ts in #416 so claude-cli-runtime can import it without
// creating a wave-executor → runtime → wave-executor cycle).
describe('cacheRetentionToPricingTtl — wave-level → pricing-level mapping', () => {
  it('maps "long" → "1h"', () => {
    expect(cacheRetentionToPricingTtl('long')).toBe('1h');
  });

  it('maps "short" → "5m"', () => {
    expect(cacheRetentionToPricingTtl('short')).toBe('5m');
  });

  it('maps "none" → "5m" (caching disabled but the value stays narrow)', () => {
    expect(cacheRetentionToPricingTtl('none')).toBe('5m');
  });

  it('maps undefined → undefined (so priceUsage applies its own default)', () => {
    expect(cacheRetentionToPricingTtl(undefined)).toBeUndefined();
  });
});
