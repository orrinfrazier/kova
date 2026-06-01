import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

/* -------------------------------------------------------------------------- */
/*  Source-level wiring tests (mirror metrics-wiring.test.ts pattern)         */
/* -------------------------------------------------------------------------- */

describe('Ollama model registration wiring in CLI entrypoints', () => {
  it('imports the ollama-wiring helper (or registerOllamaModels directly)', () => {
    const src = getCliSource();
    const importsHelper =
      /import\s+\{[^}]*registerOllamaProvidersFromConfig[^}]*\}\s+from\s+['"]\.\/ollama-wiring\.js['"]/.test(src);
    const importsDirect =
      /import\s+\{[^}]*registerOllamaModels[^}]*\}\s+from\s+['"]\.\.\/ai\/(index|models)\.js['"]/.test(src);
    expect(importsHelper || importsDirect).toBe(true);
  });

  it('wires Ollama registration in the fix command action', () => {
    const src = getCliSource();
    const fixCommandIdx = src.indexOf(".command('fix')");
    const autoCommandIdx = src.indexOf(".command('auto')");
    const fixSection = src.slice(fixCommandIdx, autoCommandIdx);
    expect(fixSection).toMatch(/registerOllamaProvidersFromConfig|registerOllamaModels/);
  });

  it('registers Ollama models BEFORE validateModelConfig in the fix command', () => {
    const src = getCliSource();
    const fixCommandIdx = src.indexOf(".command('fix')");
    const autoCommandIdx = src.indexOf(".command('auto')");
    const fixSection = src.slice(fixCommandIdx, autoCommandIdx);
    const regIdx = Math.max(
      fixSection.indexOf('registerOllamaProvidersFromConfig'),
      fixSection.indexOf('registerOllamaModels'),
    );
    const validateIdx = fixSection.indexOf('validateModelConfig');
    expect(regIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeLessThan(validateIdx);
  });

  it('wires Ollama registration in the auto command action', () => {
    const src = getCliSource();
    const autoCommandIdx = src.indexOf(".command('auto')");
    const brainstormCommandIdx = src.indexOf(".command('brainstorm')");
    const autoSection = src.slice(autoCommandIdx, brainstormCommandIdx);
    expect(autoSection).toMatch(/registerOllamaProvidersFromConfig|registerOllamaModels/);
  });

  it('wires Ollama registration in the brainstorm command action', () => {
    const src = getCliSource();
    const brainstormCommandIdx = src.indexOf(".command('brainstorm')");
    const supervisedCommandIdx = src.indexOf(".command('supervised')");
    const brainstormSection = src.slice(brainstormCommandIdx, supervisedCommandIdx);
    expect(brainstormSection).toMatch(/registerOllamaProvidersFromConfig|registerOllamaModels/);
  });

  it('wires Ollama registration in the supervised command action', () => {
    const src = getCliSource();
    const supervisedIdx = src.indexOf(".command('supervised')");
    const statusIdx = src.indexOf(".command('status')");
    const supervisedSection = src.slice(supervisedIdx, statusIdx);
    expect(supervisedSection).toMatch(/registerOllamaProvidersFromConfig|registerOllamaModels/);
  });

  it('wires Ollama registration in the serve command action', () => {
    const src = getCliSource();
    const serveIdx = src.indexOf(".command('serve')");
    const mergeIdx = src.indexOf(".command('merge')");
    const serveSection = src.slice(serveIdx, mergeIdx);
    expect(serveSection).toMatch(/registerOllamaProvidersFromConfig|registerOllamaModels/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Functional propagation tests                                              */
/* -------------------------------------------------------------------------- */

const ENV_KEYS = ['OLLAMA_HOST', 'KOVA_OLLAMA_URL'] as const;

describe('Ollama registration propagates repos.yaml settings to resolved model', () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    const { clearCustomModels } = await import('../ai/models.js');
    clearCustomModels();
  });

  it('configured contextWindow=131072 propagates to the resolved model', async () => {
    const { registerOllamaModels, resolveModelFromString } = await import('../ai/models.js');

    registerOllamaModels({
      host: 'http://localhost:11434',
      models: [{ id: 'llama3.1:70b', contextWindow: 131072, maxTokens: 32000 }],
    });

    const model = resolveModelFromString('ollama:llama3.1:70b');
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(32000);
  });

  it('configured host propagates to model baseUrl', async () => {
    const { registerOllamaModels, resolveModelFromString } = await import('../ai/models.js');

    registerOllamaModels({
      host: 'http://gpu-server:11434',
      models: [{ id: 'llama3.1:70b', contextWindow: 131072, maxTokens: 32000 }],
    });

    const model = resolveModelFromString('ollama:llama3.1:70b');
    expect(model.baseUrl).toBe('http://gpu-server:11434/v1');
  });

  it('OLLAMA_HOST env var overrides configured host', async () => {
    process.env.OLLAMA_HOST = 'http://remote-gpu:11434';
    const { registerOllamaModels, resolveModelFromString } = await import('../ai/models.js');

    registerOllamaModels({
      host: 'http://localhost:11434',
      models: [{ id: 'llama3.1:70b', contextWindow: 131072, maxTokens: 32000 }],
    });

    const model = resolveModelFromString('ollama:llama3.1:70b');
    expect(model.baseUrl).toBe('http://remote-gpu:11434/v1');
  });
});

/* -------------------------------------------------------------------------- */
/*  Helper unit test — the helper must be a safe no-op when ollama absent     */
/* -------------------------------------------------------------------------- */

describe('registerOllamaProvidersFromConfig helper', () => {
  afterEach(async () => {
    const { clearCustomModels } = await import('../ai/models.js');
    clearCustomModels();
  });

  it('exists as an importable module and registers configured models', async () => {
    const mod = (await import('./ollama-wiring.js')) as {
      registerOllamaProvidersFromConfig: (c: unknown) => void;
    };
    expect(typeof mod.registerOllamaProvidersFromConfig).toBe('function');

    // Call with a minimal RepoConfig-shaped object — only providers.ollama is read.
    mod.registerOllamaProvidersFromConfig({
      providers: {
        ollama: {
          host: 'http://localhost:11434',
          models: [{ id: 'qwen2.5-coder:32b', contextWindow: 65536, maxTokens: 8192 }],
        },
      },
    });

    const { resolveModelFromString } = await import('../ai/models.js');
    const model = resolveModelFromString('ollama:qwen2.5-coder:32b');
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(8192);
  });

  it('is a no-op when providers.ollama is undefined', async () => {
    const mod = (await import('./ollama-wiring.js')) as {
      registerOllamaProvidersFromConfig: (c: unknown) => void;
    };
    expect(typeof mod.registerOllamaProvidersFromConfig).toBe('function');

    // Should not throw, should not register anything.
    expect(() => mod.registerOllamaProvidersFromConfig({ providers: undefined })).not.toThrow();
    expect(() => mod.registerOllamaProvidersFromConfig({})).not.toThrow();

    const { resolveModelFromString } = await import('../ai/models.js');
    // A no-op registration means resolveModelFromString for an unconfigured ollama:id
    // falls back to createOllamaModel defaults (32768 context). The point is that the
    // helper did not throw and did not register the model into the custom registry.
    const model = resolveModelFromString('ollama:never-configured-model');
    // Default context window from createOllamaModel for an unknown model.
    expect(model.contextWindow).toBe(32768);
  });
});
