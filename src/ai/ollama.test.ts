import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock global fetch for Ollama HTTP API tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ollama', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env.KOVA_OLLAMA_URL;
  });

  afterEach(() => {
    delete process.env.KOVA_OLLAMA_URL;
    vi.restoreAllMocks();
  });

  describe('getOllamaBaseUrl', () => {
    it('returns default localhost URL when KOVA_OLLAMA_URL is not set', async () => {
      const { getOllamaBaseUrl } = await import('./ollama.js');
      expect(getOllamaBaseUrl()).toBe('http://localhost:11434');
    });

    it('respects KOVA_OLLAMA_URL env var', async () => {
      process.env.KOVA_OLLAMA_URL = 'http://gpu-server:11434';
      const { getOllamaBaseUrl } = await import('./ollama.js');
      expect(getOllamaBaseUrl()).toBe('http://gpu-server:11434');
    });
  });

  describe('detectOllama', () => {
    it('returns true when Ollama is running', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const { detectOllama } = await import('./ollama.js');

      const result = await detectOllama();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/version',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('returns false when Ollama is not running', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const { detectOllama } = await import('./ollama.js');

      const result = await detectOllama();

      expect(result).toBe(false);
    });

    it('returns false when Ollama responds with non-OK status', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const { detectOllama } = await import('./ollama.js');

      const result = await detectOllama();

      expect(result).toBe(false);
    });

    it('uses custom URL from KOVA_OLLAMA_URL', async () => {
      process.env.KOVA_OLLAMA_URL = 'http://remote:11434';
      mockFetch.mockResolvedValueOnce({ ok: true });
      const { detectOllama } = await import('./ollama.js');

      await detectOllama();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://remote:11434/api/version',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe('listOllamaModels', () => {
    it('returns parsed model list from Ollama API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'qwen2.5-coder:32b', size: 18_000_000_000, modified_at: '2026-01-15T10:00:00Z' },
            { name: 'qwen2.5-coder:7b', size: 4_000_000_000, modified_at: '2026-01-14T10:00:00Z' },
          ],
        }),
      });
      const { listOllamaModels } = await import('./ollama.js');

      const models = await listOllamaModels();

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        name: 'qwen2.5-coder:32b',
        size: 18_000_000_000,
        modifiedAt: '2026-01-15T10:00:00Z',
      });
    });

    it('throws when Ollama API is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const { listOllamaModels } = await import('./ollama.js');

      await expect(listOllamaModels()).rejects.toThrow();
    });

    it('throws when Ollama API returns error status', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, statusText: 'Internal Server Error' });
      const { listOllamaModels } = await import('./ollama.js');

      await expect(listOllamaModels()).rejects.toThrow(/Failed to list Ollama models/);
    });
  });

  describe('createOllamaModel', () => {
    it('creates a valid Model<openai-completions> object', async () => {
      const { createOllamaModel } = await import('./ollama.js');

      const model = createOllamaModel('qwen2.5-coder:32b');

      expect(model.id).toBe('qwen2.5-coder:32b');
      expect(model.name).toBe('qwen2.5-coder:32b');
      expect(model.api).toBe('openai-completions');
      expect(model.provider).toBe('ollama');
      expect(model.baseUrl).toBe('http://localhost:11434/v1');
      expect(model.reasoning).toBe(false);
      expect(model.input).toEqual(['text']);
      // Ollama is free — all costs zero
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it('uses known context window size for recognized models', async () => {
      const { createOllamaModel } = await import('./ollama.js');

      const qwen32b = createOllamaModel('qwen2.5-coder:32b');
      expect(qwen32b.contextWindow).toBe(32768);

      const llama = createOllamaModel('llama3.1:70b');
      expect(llama.contextWindow).toBe(131072);
    });

    it('uses default context window for unknown models', async () => {
      const { createOllamaModel } = await import('./ollama.js');

      const unknown = createOllamaModel('some-custom-model:latest');
      expect(unknown.contextWindow).toBe(32768);
    });

    it('uses custom base URL from KOVA_OLLAMA_URL', async () => {
      process.env.KOVA_OLLAMA_URL = 'http://gpu-server:11434';
      const { createOllamaModel } = await import('./ollama.js');

      const model = createOllamaModel('qwen2.5-coder:7b');
      expect(model.baseUrl).toBe('http://gpu-server:11434/v1');
    });

    it('sets OpenAI compat flags for Ollama quirks', async () => {
      const { createOllamaModel } = await import('./ollama.js');

      const model = createOllamaModel('qwen2.5-coder:32b');
      expect(model.compat).toBeDefined();
      expect(model.compat?.supportsStore).toBe(false);
      expect(model.compat?.supportsDeveloperRole).toBe(false);
      expect(model.compat?.supportsReasoningEffort).toBe(false);
      expect(model.compat?.supportsStrictMode).toBe(false);
    });
  });

  describe('OLLAMA_TIER_DEFAULTS', () => {
    it('maps medium to qwen2.5-coder:32b', async () => {
      const { OLLAMA_TIER_DEFAULTS } = await import('./ollama.js');
      expect(OLLAMA_TIER_DEFAULTS.medium).toBe('qwen2.5-coder:32b');
    });

    it('maps small to qwen2.5-coder:7b', async () => {
      const { OLLAMA_TIER_DEFAULTS } = await import('./ollama.js');
      expect(OLLAMA_TIER_DEFAULTS.small).toBe('qwen2.5-coder:7b');
    });
  });

  describe('isOllamaProvider', () => {
    it('returns true for "ollama"', async () => {
      const { isOllamaProvider } = await import('./ollama.js');
      expect(isOllamaProvider('ollama')).toBe(true);
    });

    it('returns false for other providers', async () => {
      const { isOllamaProvider } = await import('./ollama.js');
      expect(isOllamaProvider('anthropic')).toBe(false);
      expect(isOllamaProvider('openai')).toBe(false);
    });
  });

  describe('isToolCapable', () => {
    it('returns true for models known to support function calling', async () => {
      const { isToolCapable } = await import('./ollama.js');
      expect(isToolCapable('qwen2.5-coder:32b')).toBe(true);
      expect(isToolCapable('qwen2.5-coder:7b')).toBe(true);
      expect(isToolCapable('llama3.1:70b')).toBe(true);
    });

    it('returns false for unknown models', async () => {
      const { isToolCapable } = await import('./ollama.js');
      expect(isToolCapable('codellama:34b')).toBe(false);
      expect(isToolCapable('random-model:latest')).toBe(false);
    });
  });

  describe('resolveOllamaApiKey', () => {
    it('returns "ollama" as dummy API key', async () => {
      const { resolveOllamaApiKey } = await import('./ollama.js');
      expect(resolveOllamaApiKey()).toBe('ollama');
    });
  });
});
