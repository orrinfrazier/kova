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
});
