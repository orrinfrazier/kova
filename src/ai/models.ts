import { getModel, getProviders, type Model, registerBuiltInApiProviders } from '@earendil-works/pi-ai';
import { CODEX_ACCESS_TOKEN_ENV, CODEX_PROVIDER, hasCodexCredentials } from '../auth/codex/index.js';
import type {
  ModelTier,
  OllamaProvider,
  RepoConfig,
  WaveConsensusConfig,
  WaveModelConfig,
  WaveSingleModelConfig,
} from '../types/index.js';
import { KovaError } from './errors.js';
import { createOllamaModel, isOllamaProvider } from './ollama.js';
import { createRouterModel, isRouterEnabled, isRouterProvider } from './router.js';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  large: 'claude-opus-4-6',
};

/** Providers that run locally and don't incur API costs. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'lmstudio',
  'vllm',
  'llamacpp',
  'llamafile',
  'llama-cpp',
]);

let providersRegistered = false;

function ensureProviders(): void {
  if (!providersRegistered) {
    registerBuiltInApiProviders();
    providersRegistered = true;
  }
}

export type { Model };

export interface ModelSpec {
  provider: string;
  modelId: string;
}

// --- Custom model registry (Ollama, future local providers) ---

const customModels = new Map<string, Model<string>>();

export interface OllamaModelDef {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
}

/** Register Ollama models into the custom model registry.
 *  OLLAMA_HOST env var takes precedence over config host. */
export function registerOllamaModels(config: OllamaProvider): void {
  const host = process.env.OLLAMA_HOST ?? config.host;
  const baseUrl = `${host}/v1`;

  for (const def of config.models) {
    const model: Model<'openai-completions'> = {
      id: def.id,
      name: def.name ?? def.id,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
    };
    customModels.set(`ollama:${def.id}`, model);
  }
}

/** Clear all custom models. Primarily for test cleanup. */
export function clearCustomModels(): void {
  customModels.clear();
}

// --- Provider / model resolution ---

let _knownProviders: Set<string> | undefined;
function knownProviders(): Set<string> {
  if (!_knownProviders) {
    ensureProviders();
    _knownProviders = new Set(getProviders());
  }
  return _knownProviders;
}

export function parseModelSpec(modelString: string): ModelSpec {
  // Check custom model registry first — allows "ollama:modelId" even though
  // "ollama" isn't a known pi-mono provider
  if (customModels.has(modelString)) {
    const colonIndex = modelString.indexOf(':');
    if (colonIndex > 0) {
      return { provider: modelString.slice(0, colonIndex), modelId: modelString.slice(colonIndex + 1) };
    }
  }

  const colonIndex = modelString.indexOf(':');
  if (colonIndex > 0) {
    const candidate = modelString.slice(0, colonIndex);
    // Ollama and router are not pi-ai built-in providers — handle explicitly
    if (isOllamaProvider(candidate) || isRouterProvider(candidate) || knownProviders().has(candidate)) {
      return { provider: candidate, modelId: modelString.slice(colonIndex + 1) };
    }
  }
  // No recognized provider prefix — default to anthropic
  return { provider: 'anthropic', modelId: modelString };
}

export function resolveModelFromString(modelString: string): Model<string> {
  // Check custom model registry first (Ollama, etc.)
  const custom = customModels.get(modelString);
  if (custom) return custom;

  ensureProviders();
  const { provider, modelId } = parseModelSpec(modelString);

  // Ollama models are not in pi-ai's registry — create them directly
  if (isOllamaProvider(provider)) {
    return createOllamaModel(modelId);
  }

  // Router models proxy through claude-code-router
  if (isRouterProvider(provider)) {
    return createRouterModel(modelId);
  }

  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
  if (!model) {
    throw new KovaError(`Unknown model: ${provider}:${modelId}`, 'config', false);
  }
  return model;
}

export function resolveModel(tier: ModelTier = 'medium'): Model<string> {
  ensureProviders();
  const modelString = resolveModelString(tier);
  return resolveModelFromString(modelString);
}

function resolveModelString(tier: ModelTier): string {
  let base: string;
  switch (tier) {
    case 'small':
      base = process.env.KOVA_SMALL_MODEL ?? DEFAULT_MODELS.small;
      break;
    case 'large':
      base = process.env.KOVA_LARGE_MODEL ?? DEFAULT_MODELS.large;
      break;
    default:
      base = process.env.KOVA_MEDIUM_MODEL ?? DEFAULT_MODELS.medium;
      break;
  }

  // When router is active and the model has no explicit provider prefix, route through router
  if (isRouterEnabled() && !base.includes(':')) {
    return `router:${base}`;
  }
  return base;
}

const MODEL_TIERS: ReadonlySet<string> = new Set(['small', 'medium', 'large']);

/** Type guard: true when a wave model config is a consensus pool (object with `pool` array).
 *  Accepts a broader input type than `WaveModelConfig` so that callers holding the raw
 *  pre-parse input (where `adjudicator` is still optional) can also use this guard. */
export function isConsensusPool(
  config: WaveModelConfig | { pool: WaveSingleModelConfig[]; adjudicator?: WaveSingleModelConfig },
): config is WaveConsensusConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'pool' in config &&
    Array.isArray((config as { pool: unknown }).pool)
  );
}

/** Resolve a single-model wave config (tier, bare string, or {provider, model}) to a Model.
 *  Internal helper — callers handling a `WaveModelConfig` should branch on `isConsensusPool`
 *  first, then call `resolveSingleWaveModel` for the single-model case or `resolveConsensusPool`
 *  for the pool case. Exposed via `resolveWaveModel` for the common single-model path. */
function resolveSingleWaveModel(config: WaveSingleModelConfig): Model<string> {
  if (typeof config === 'string') {
    if (MODEL_TIERS.has(config)) {
      return resolveModel(config as ModelTier);
    }
    return resolveModelFromString(config);
  }
  return resolveModelFromString(`${config.provider}:${config.model}`);
}

/** Resolve a WaveModelConfig (tier string, bare model string, or {provider, model} override) to a Model.
 *  Throws if called with a consensus pool config — callers handling pools must call
 *  `resolveConsensusPool` explicitly instead of silently collapsing to the first member. */
export function resolveWaveModel(config: WaveModelConfig): Model<string> {
  if (isConsensusPool(config)) {
    throw new KovaError(
      'resolveWaveModel called on a consensus pool config — use resolveConsensusPool instead.',
      'config',
      false,
    );
  }
  return resolveSingleWaveModel(config);
}

/** Resolve a consensus pool: every pool member + the adjudicator (defaults to `large`).
 *  Returns models in pool-config order, so callers can map results back to their config.
 *  Accepts either a parsed `WaveConsensusConfig` (adjudicator always present) or the raw
 *  input shape where adjudicator may be omitted — the `'large'` default is re-applied
 *  here defensively so direct callers don't need to round-trip through Zod. */
export function resolveConsensusPool(
  config: WaveConsensusConfig | { pool: WaveSingleModelConfig[]; adjudicator?: WaveSingleModelConfig },
): { pool: Model<string>[]; adjudicator: Model<string> } {
  const adjudicator = config.adjudicator ?? 'large';
  return {
    pool: config.pool.map(resolveSingleWaveModel),
    adjudicator: resolveSingleWaveModel(adjudicator),
  };
}

/** Return a round-trip-safe identifier for a resolved Model.
 *
 *  `model.id` alone is NOT round-trip-safe: for any provider where the model's
 *  bare id does not match its canonical resolution path (Ollama, OpenAI, Google,
 *  router, …), passing `model.id` back through `resolveModelFromString` silently
 *  defaults to anthropic. Always emit `${provider}:${id}` so downstream code can
 *  re-resolve to the same model. See orrinfrazier/kova#239.
 */
export function getModelString(model: Model<string>): string {
  return `${model.provider}:${model.id}`;
}

/** Returns true if the provider runs locally (no API cost). */
export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

/** Check whether a model string refers to a local provider (ollama, lmstudio, etc.). */
export function isLocalModel(modelString: string): boolean {
  // Check the raw prefix first — local providers may not be registered with pi-mono
  const colonIndex = modelString.indexOf(':');
  if (colonIndex > 0) {
    const prefix = modelString.slice(0, colonIndex);
    if (isLocalProvider(prefix)) return true;
  }
  const { provider } = parseModelSpec(modelString);
  return isLocalProvider(provider);
}

/** Return the default API model string for a tier, ignoring env overrides. */
export function getApiFallbackModelString(tier: ModelTier): string {
  return DEFAULT_MODELS[tier];
}

// --- Provider → API key env var mapping ---
//
// Each provider lists the env var(s) hasApiKey accepts. This MUST stay in sync
// with `resolveApiKey` in wave-executor.ts — if resolveApiKey would find a key
// at runtime, validateModelConfig must accept that wave at startup (and vice
// versa). When the two drift, a config that would run gets rejected up front
// (or, worse, the opposite). See orrinfrazier/kova#263.
//
// Order matters for error messages: env vars are listed in the same priority
// order as resolveApiKey, and `describeApiKeyEnv` joins them with "or".

const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  // resolveApiKey('google') prefers GEMINI_API_KEY, falls back to GOOGLE_API_KEY.
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  'amazon-bedrock': ['AWS_ACCESS_KEY_ID'],
  'vertex-ai': ['GOOGLE_APPLICATION_CREDENTIALS'],
  // ChatGPT Pro/Plus (Codex) subscription auth. The env var is a CI escape
  // hatch holding a pre-extracted access_token; the normal path is the OAuth
  // file at ~/.kova/auth/openai.json (see src/auth/codex). Both are accepted
  // — hasApiKey overrides the default env-only check below for this provider.
  [CODEX_PROVIDER]: [CODEX_ACCESS_TOKEN_ENV],
};

/** Check whether the required API key is available for a provider.
 *  A provider with multiple accepted env vars passes if ANY of them is set.
 *  openai-codex additionally accepts a logged-in OAuth credentials file. */
function hasApiKey(provider: string): boolean {
  if (provider === CODEX_PROVIDER) return hasCodexCredentials();
  const envVars = PROVIDER_API_KEY_ENV[provider];
  if (!envVars) return true; // Unknown provider — assume key is handled elsewhere
  return envVars.some((v) => !!process.env[v]);
}

/** Human-readable description of the env var(s) a provider accepts.
 *  "GEMINI_API_KEY or GOOGLE_API_KEY" for google, "OPENAI_API_KEY" for openai. */
function describeApiKeyEnv(provider: string): string {
  if (provider === CODEX_PROVIDER) return `${CODEX_ACCESS_TOKEN_ENV} or run \`kova auth login\``;
  const envVars = PROVIDER_API_KEY_ENV[provider];
  if (!envVars || envVars.length === 0) return 'the appropriate env var';
  if (envVars.length === 1) return envVars[0] as string;
  return envVars.join(' or ');
}

// --- Startup model validation ---

const WAVE_NAMES = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'brainstorm'] as const;

/** Validate that all configured models are resolvable and have API keys present.
 *  Call at startup before the pipeline begins to fail fast on config errors.
 *  Pool members and adjudicators are validated individually, with errors naming
 *  the wave and pool index (or `adjudicator`) so misconfiguration is easy to pinpoint. */
export function validateModelConfig(config: RepoConfig): void {
  for (const wave of WAVE_NAMES) {
    const waveConfig = config.model[wave];
    if (isConsensusPool(waveConfig)) {
      validatePoolMember(wave, 'pool', waveConfig.pool);
      validatePoolMember(wave, 'adjudicator', [waveConfig.adjudicator]);
      continue;
    }
    try {
      const model = resolveWaveModel(waveConfig);
      assertHasApiKey(wave, model);
    } catch (e) {
      if (e instanceof KovaError) throw e;
      throw new KovaError(
        `Model validation failed for wave "${wave}": ${e instanceof Error ? e.message : String(e)}`,
        'config',
        false,
      );
    }
  }
}

/** Throw a KovaError naming wave + member when a model lacks its provider's API key.
 *  Uses `describeApiKeyEnv` so multi-key providers (e.g. google = GEMINI_API_KEY or
 *  GOOGLE_API_KEY) get an accurate "set X or Y" hint. */
function assertHasApiKey(wave: string, model: Model<string>, locator?: string): void {
  if (isLocalProvider(model.provider) || hasApiKey(model.provider)) return;
  const envHint = describeApiKeyEnv(model.provider);
  const where = locator ? `Wave "${wave}" ${locator}` : `Wave "${wave}"`;
  throw new KovaError(
    `${where} uses provider "${model.provider}" (model: ${model.id}) but no API key is set — set ${envHint}.`,
    'config',
    false,
  );
}

/** Validate each member in a pool (or the single-element adjudicator array). Errors include
 *  the wave name and locator (e.g. `pool[1]` / `adjudicator`) so misconfig is easy to find. */
function validatePoolMember(wave: string, kind: 'pool' | 'adjudicator', members: WaveSingleModelConfig[]): void {
  members.forEach((member, idx) => {
    const locator = kind === 'pool' ? `pool[${idx}]` : 'adjudicator';
    let model: Model<string>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- internal helper
      model = resolveSingleWaveModel(member);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new KovaError(`Model validation failed for wave "${wave}" ${locator}: ${message}`, 'config', false);
    }
    assertHasApiKey(wave, model, locator);
  });
}
