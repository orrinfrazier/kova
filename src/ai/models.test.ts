import { afterEach, describe, expect, it, vi } from 'vitest';

// Reset env vars between tests
const ENV_KEYS = ['KOVA_SMALL_MODEL', 'KOVA_MEDIUM_MODEL', 'KOVA_LARGE_MODEL'] as const;

describe('models', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  describe('resolveModel', () => {
    it('resolves default anthropic models for each tier', async () => {
      const { resolveModel } = await import('./models.js');

      const small = resolveModel('small');
      expect(small.id).toBe('claude-haiku-4-5-20251001');
      expect(small.provider).toBe('anthropic');

      const medium = resolveModel('medium');
      expect(medium.id).toBe('claude-sonnet-4-6');
      expect(medium.provider).toBe('anthropic');

      const large = resolveModel('large');
      expect(large.id).toBe('claude-opus-4-6');
      expect(large.provider).toBe('anthropic');
    });

    it('respects KOVA_MEDIUM_MODEL env var with bare model ID (defaults to anthropic)', async () => {
      process.env.KOVA_MEDIUM_MODEL = 'claude-opus-4-6';
      // Re-import to get fresh module
      const { resolveModel } = await import('./models.js');

      const model = resolveModel('medium');
      expect(model.id).toBe('claude-opus-4-6');
      expect(model.provider).toBe('anthropic');
    });

    it('resolves provider:modelId format from env var', async () => {
      process.env.KOVA_MEDIUM_MODEL = 'openai:gpt-4o';
      const { resolveModel } = await import('./models.js');

      const model = resolveModel('medium');
      expect(model.id).toBe('gpt-4o');
      expect(model.provider).toBe('openai');
    });

    it('resolves provider:modelId format for all tiers via env vars', async () => {
      process.env.KOVA_SMALL_MODEL = 'openai:gpt-4o-mini';
      process.env.KOVA_LARGE_MODEL = 'google:gemini-2.5-pro';
      const { resolveModel } = await import('./models.js');

      const small = resolveModel('small');
      expect(small.id).toBe('gpt-4o-mini');
      expect(small.provider).toBe('openai');

      const large = resolveModel('large');
      expect(large.provider).toBe('google');
    });

    it('throws KovaError for unknown provider:model combination', async () => {
      process.env.KOVA_MEDIUM_MODEL = 'fake-provider:nonexistent-model';
      const { resolveModel } = await import('./models.js');

      expect(() => resolveModel('medium')).toThrow(/Unknown model/);
    });

    it('resolves model string with provider prefix (non-env, direct call)', async () => {
      const { resolveModelFromString } = await import('./models.js');

      const model = resolveModelFromString('openai:gpt-4o');
      expect(model.id).toBe('gpt-4o');
      expect(model.provider).toBe('openai');
    });

    it('resolves bare model ID defaulting to anthropic provider', async () => {
      const { resolveModelFromString } = await import('./models.js');

      const model = resolveModelFromString('claude-sonnet-4-6');
      expect(model.id).toBe('claude-sonnet-4-6');
      expect(model.provider).toBe('anthropic');
    });
  });

  describe('parseModelSpec', () => {
    it('parses provider:modelId format', async () => {
      const { parseModelSpec } = await import('./models.js');

      const spec = parseModelSpec('openai:gpt-4o');
      expect(spec).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
    });

    it('defaults to anthropic for bare model ID', async () => {
      const { parseModelSpec } = await import('./models.js');

      const spec = parseModelSpec('claude-sonnet-4-6');
      expect(spec).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
    });

    it('handles provider with colons in model ID', async () => {
      // e.g. amazon-bedrock model IDs contain colons
      const { parseModelSpec } = await import('./models.js');

      const spec = parseModelSpec('amazon-bedrock:amazon.nova-lite-v1:0');
      expect(spec).toEqual({ provider: 'amazon-bedrock', modelId: 'amazon.nova-lite-v1:0' });
    });
  });

  describe('provider registration', () => {
    it('non-anthropic models resolve successfully (proves providers are registered)', async () => {
      process.env.KOVA_MEDIUM_MODEL = 'openai:gpt-4o';
      const { resolveModel } = await import('./models.js');

      // This would fail if providers weren't registered — getModel needs API providers
      const model = resolveModel('medium');
      expect(model.id).toBe('gpt-4o');
      expect(model.provider).toBe('openai');
    });
  });
});
