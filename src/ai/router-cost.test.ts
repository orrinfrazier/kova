// Integration test for the router-pricing → cost-cap path (kova#314).
//
// The fix has two parts:
//   1. `createRouterModel` must populate `model.cost` from the upstream
//      provider's pricing (router.ts).
//   2. Pi-ai's `calculateCost` must therefore produce non-zero per-turn cost
//      when given that model + realistic token usage.
//
// This test is intentionally narrow: it exercises the pricing pipeline end-to-
// end at the model layer (router.ts + pi-ai's calculateCost) without spinning
// up the full Agent runtime. The full wave-executor cost-cap path is covered
// by wave-cost-cap.test.ts using synthesized `usage.cost.total` values.
import { afterEach, describe, expect, it } from 'vitest';

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ROUTER_DEFAULT', 'ANTHROPIC_API_KEY'] as const;

describe('router pricing → calculateCost integration (kova#314)', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('produces non-zero per-turn cost when usage is fed through pi-ai calculateCost', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
    const { createRouterModel } = await import('./router.js');
    const { calculateCost, registerBuiltInApiProviders } = await import('@earendil-works/pi-ai');
    registerBuiltInApiProviders();

    const model = createRouterModel('anthropic:claude-opus-4-6');

    // Simulate a turn: 1000 input + 200 output tokens.
    const usage = {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);

    // Before fix: usage.cost.total === 0 (router cost hardcoded to 0).
    // After fix: must be > 0 — proves the cost cap will see non-zero
    // accumulation per turn for routed waves.
    expect(usage.cost.total).toBeGreaterThan(0);
  });

  it('would trip a 1¢ cost cap within a single turn at production-realistic usage', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
    const { createRouterModel } = await import('./router.js');
    const { calculateCost, registerBuiltInApiProviders } = await import('@earendil-works/pi-ai');
    registerBuiltInApiProviders();

    const model = createRouterModel('anthropic:claude-opus-4-6');

    // Realistic single-turn usage on a non-trivial prompt: ~10k input, ~1k output.
    // At Opus rates ($5/Mtok in, $25/Mtok out) this is $0.05 + $0.025 = $0.075 — far above 1¢.
    const usage = {
      input: 10_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);

    // 1¢ cap would have aborted on this turn.
    const ONE_CENT = 0.01;
    expect(usage.cost.total).toBeGreaterThan(ONE_CENT);
  });

  it('falls back to $0/turn for unresolved models (silent no-op preserved as documented behavior)', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
    const { createRouterModel } = await import('./router.js');
    const { calculateCost, registerBuiltInApiProviders } = await import('@earendil-works/pi-ai');
    registerBuiltInApiProviders();

    const model = createRouterModel('unknown:fake-model');

    const usage = {
      input: 10_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);

    // No pricing available → cost stays 0. Caller has been log.warn'd by createRouterModel.
    expect(usage.cost.total).toBe(0);
  });
});
