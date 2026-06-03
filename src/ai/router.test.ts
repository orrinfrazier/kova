import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ROUTER_DEFAULT', 'ANTHROPIC_API_KEY'] as const;

describe('router', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  describe('isRouterEnabled', () => {
    it('returns true when ANTHROPIC_BASE_URL is set', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { isRouterEnabled } = await import('./router.js');

      expect(isRouterEnabled()).toBe(true);
    });

    it('returns false when ANTHROPIC_BASE_URL is not set', async () => {
      const { isRouterEnabled } = await import('./router.js');

      expect(isRouterEnabled()).toBe(false);
    });
  });

  describe('getRouterBaseUrl', () => {
    it('returns the value of ANTHROPIC_BASE_URL', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { getRouterBaseUrl } = await import('./router.js');

      expect(getRouterBaseUrl()).toBe('https://my-router.example.com');
    });

    it('returns undefined when ANTHROPIC_BASE_URL is not set', async () => {
      const { getRouterBaseUrl } = await import('./router.js');

      expect(getRouterBaseUrl()).toBeUndefined();
    });
  });

  describe('getRouterDefaultModel', () => {
    it('returns ROUTER_DEFAULT env var when set', async () => {
      process.env.ROUTER_DEFAULT = 'openai:gpt-4o';
      const { getRouterDefaultModel } = await import('./router.js');

      expect(getRouterDefaultModel()).toBe('openai:gpt-4o');
    });

    it('returns anthropic:claude-sonnet-4-6 when ROUTER_DEFAULT is not set', async () => {
      const { getRouterDefaultModel } = await import('./router.js');

      expect(getRouterDefaultModel()).toBe('anthropic:claude-sonnet-4-6');
    });
  });

  describe('createRouterModel', () => {
    it('returns a model with provider "router"', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel();

      expect(model.provider).toBe('router');
    });

    it('returns a model with baseUrl from ANTHROPIC_BASE_URL', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel();

      expect(model.baseUrl).toBe('https://my-router.example.com');
    });

    it('returns a model with api "anthropic-messages"', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel();

      expect(model.api).toBe('anthropic-messages');
    });

    it('uses the default model ID when no argument is passed', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel, getRouterDefaultModel } = await import('./router.js');

      const model = createRouterModel();
      const defaultModelSpec = getRouterDefaultModel();
      // The model ID should be the model portion of the default spec (e.g. 'claude-sonnet-4-6')
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      // The returned model ID should be derived from the default
      expect(defaultModelSpec).toContain(model.id);
    });

    it('uses the passed model ID when createRouterModel("openai:gpt-4o") is called', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel('openai:gpt-4o');

      expect(model.id).toBe('gpt-4o');
    });

    it('still sets provider "router" when a model ID is passed', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel('openai:gpt-4o');

      expect(model.provider).toBe('router');
    });

    it('still sets api "anthropic-messages" when a model ID is passed', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const model = createRouterModel('openai:gpt-4o');

      expect(model.api).toBe('anthropic-messages');
    });
  });

  describe('resolveRouterApiKey', () => {
    it('returns the value of ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      const { resolveRouterApiKey } = await import('./router.js');

      expect(resolveRouterApiKey()).toBe('sk-ant-test-key');
    });

    it('returns undefined when ANTHROPIC_API_KEY is not set', async () => {
      const { resolveRouterApiKey } = await import('./router.js');

      expect(resolveRouterApiKey()).toBeUndefined();
    });
  });

  // --- Pricing lookup (kova#314) ---
  // Router-proxied requests must carry the upstream provider's pricing so the
  // user-configured cost cap (KOVA_MAX_COST_USD), cost-report aggregation, and
  // shared budget tracker all see non-zero per-turn cost.
  describe('createRouterModel pricing lookup', () => {
    it('copies pi-ai pricing for "anthropic:claude-opus-4-6"', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');
      const { getModel, registerBuiltInApiProviders } = await import('@earendil-works/pi-ai');
      registerBuiltInApiProviders();
      const upstream = getModel('anthropic', 'claude-opus-4-6');

      const routed = createRouterModel('anthropic:claude-opus-4-6');

      expect(routed.cost.input).toBe(upstream.cost.input);
      expect(routed.cost.output).toBe(upstream.cost.output);
      expect(routed.cost.cacheRead).toBe(upstream.cost.cacheRead);
      expect(routed.cost.cacheWrite).toBe(upstream.cost.cacheWrite);
    });

    it('copies pi-ai pricing for "anthropic:claude-haiku-4-5-20251001" — $1/$5 per Mtok', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const routed = createRouterModel('anthropic:claude-haiku-4-5-20251001');

      // Per pi-ai's published rates (verified at issue write-time): $1 input,
      // $5 output per million tokens. If pi-ai's rates change upstream, the
      // assertion can be loosened to "> 0", but pinning catches silent zeroing.
      expect(routed.cost.input).toBe(1);
      expect(routed.cost.output).toBe(5);
    });

    it('uses default ROUTER_DEFAULT when no modelId argument is passed', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      process.env.ROUTER_DEFAULT = 'anthropic:claude-opus-4-6';
      const { createRouterModel } = await import('./router.js');

      const routed = createRouterModel();

      // Should pick up pricing from anthropic:claude-opus-4-6 (non-zero).
      expect(routed.cost.input).toBeGreaterThan(0);
      expect(routed.cost.output).toBeGreaterThan(0);
    });

    it('falls back to cost: 0 for unresolvable models and does not throw', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const routed = createRouterModel('unknown:fake-model');

      // Graceful fallback: zero cost (caller is warned via log), no throw.
      expect(routed.cost.input).toBe(0);
      expect(routed.cost.output).toBe(0);
      expect(routed.id).toBe('fake-model');
      expect(routed.provider).toBe('router');
    });

    it('exposes the upstream provider via getRouterUpstreamProvider when resolved', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel, getRouterUpstreamProvider } = await import('./router.js');

      createRouterModel('anthropic:claude-opus-4-6');

      // Lookup by model id (the field cost-report has access to via WaveResult.model).
      expect(getRouterUpstreamProvider('claude-opus-4-6')).toBe('anthropic');
    });

    it('getRouterUpstreamProvider returns undefined for unresolved models', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel, getRouterUpstreamProvider } = await import('./router.js');

      createRouterModel('unknown:fake-model');

      expect(getRouterUpstreamProvider('fake-model')).toBeUndefined();
    });

    it('keeps provider === "router" so resolveApiKey routes through ANTHROPIC_API_KEY', async () => {
      // Regression guard: do NOT change provider to 'anthropic' — that would
      // break wave-executor.ts:1008 resolveApiKey routing and any other
      // isRouterProvider() checks throughout the code.
      process.env.ANTHROPIC_BASE_URL = 'https://my-router.example.com';
      const { createRouterModel } = await import('./router.js');

      const routed = createRouterModel('anthropic:claude-opus-4-6');

      expect(routed.provider).toBe('router');
    });
  });
});
