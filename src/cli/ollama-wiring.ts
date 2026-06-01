// Wires repos.yaml `providers.ollama` configuration into the runtime model registry.
//
// Without this, `contextWindow`, `maxTokens`, and `host` set in `repos.yaml` are
// silently ignored — models fall back to `createOllamaModel`'s hardcoded defaults
// (32768 context window instead of the configured value).
//
// Must be called at CLI startup, before any wave runs `validateModelConfig` or
// resolves a model. Safe to call multiple times — re-registering the same id
// overwrites the previous registration (Map.set semantics).
//
// See orrinfrazier/kova#241.

import { registerOllamaModels } from '../ai/index.js';
import type { RepoConfig } from '../types/index.js';

/** Register Ollama models from a resolved RepoConfig.
 *
 *  No-op when `config.providers?.ollama` is undefined — runs that don't use
 *  Ollama incur no cost and no error.
 */
export function registerOllamaProvidersFromConfig(config: Pick<RepoConfig, 'providers'> | undefined | null): void {
  const ollama = config?.providers?.ollama;
  if (!ollama) return;
  registerOllamaModels(ollama);
}
