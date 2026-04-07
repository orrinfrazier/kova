import { afterEach, describe, expect, it, vi } from 'vitest';

// Reset env vars between tests
const ENV_KEYS = ['KOVA_SMALL_MODEL', 'KOVA_MEDIUM_MODEL', 'KOVA_LARGE_MODEL', 'OLLAMA_HOST'] as const;

describe('models', () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    // Clear custom models between tests
    const { clearCustomModels } = await import('./models.js');
    clearCustomModels();
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

  describe('ollama models', () => {
    it('resolves a registered ollama model via ollama:modelId', async () => {
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      const model = resolveModelFromString('ollama:llama3');
      expect(model.id).toBe('llama3');
      expect(model.provider).toBe('ollama');
    });

    it('ollama models use openai-completions api', async () => {
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'codellama', contextWindow: 16384, maxTokens: 4096 }],
      });

      const model = resolveModelFromString('ollama:codellama');
      expect(model.api).toBe('openai-completions');
    });

    it('ollama models have zero cost', async () => {
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      const model = resolveModelFromString('ollama:llama3');
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it('ollama model baseUrl ends with /v1', async () => {
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://gpu-server:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      const model = resolveModelFromString('ollama:llama3');
      expect(model.baseUrl).toBe('http://gpu-server:11434/v1');
    });

    it('respects OLLAMA_HOST env var over config host', async () => {
      process.env.OLLAMA_HOST = 'http://remote:11434';
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      const model = resolveModelFromString('ollama:llama3');
      expect(model.baseUrl).toBe('http://remote:11434/v1');
    });

    it('throws for unregistered ollama model', async () => {
      const { resolveModelFromString } = await import('./models.js');

      expect(() => resolveModelFromString('ollama:nonexistent')).toThrow(/Unknown model/);
    });

    it('can use ollama model via KOVA_SMALL_MODEL env var', async () => {
      const { registerOllamaModels, resolveModel } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      process.env.KOVA_SMALL_MODEL = 'ollama:llama3';
      const model = resolveModel('small');
      expect(model.id).toBe('llama3');
      expect(model.provider).toBe('ollama');
    });

    it('uses custom name when provided', async () => {
      const { registerOllamaModels, resolveModelFromString } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'codellama', name: 'Code Llama 13B', contextWindow: 16384, maxTokens: 4096 }],
      });

      const model = resolveModelFromString('ollama:codellama');
      expect(model.name).toBe('Code Llama 13B');
    });

    it('clearCustomModels removes all registered ollama models', async () => {
      const { registerOllamaModels, resolveModelFromString, clearCustomModels } = await import('./models.js');

      registerOllamaModels({
        host: 'http://localhost:11434',
        models: [{ id: 'llama3', contextWindow: 128000, maxTokens: 32000 }],
      });

      // Works before clearing
      expect(resolveModelFromString('ollama:llama3').id).toBe('llama3');

      clearCustomModels();

      // Fails after clearing
      expect(() => resolveModelFromString('ollama:llama3')).toThrow(/Unknown model/);
    });
  });
});
