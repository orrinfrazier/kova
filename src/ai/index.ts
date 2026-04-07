export { classifyError, type ErrorClassification, isRetryable, isSpendingCapBehavior, KovaError } from './errors.js';
export {
  clearCustomModels,
  getApiFallbackModelString,
  isLocalModel,
  isLocalProvider,
  type ModelSpec,
  type OllamaModelDef,
  parseModelSpec,
  registerOllamaModels,
  resolveModel,
  resolveModelFromString,
  resolveWaveModel,
  validateModelConfig,
} from './models.js';
export {
  createOllamaModel,
  detectOllama,
  getOllamaBaseUrl,
  isOllamaProvider,
  isToolCapable,
  listOllamaModels,
  OLLAMA_TIER_DEFAULTS,
  type OllamaModelInfo,
  resolveOllamaApiKey,
} from './ollama.js';
export {
  createRouterModel,
  getRouterBaseUrl,
  getRouterDefaultModel,
  isRouterEnabled,
  isRouterProvider,
  resolveRouterApiKey,
} from './router.js';
export {
  executeWave,
  executeWaveWithRetry,
  type FallbackWaveHandoff,
  type OutputFormat,
  resolveApiKey,
  type SpawnWaveAgentConfig,
  type SpawnWithFallbackConfig,
  spawnWaveAgent,
  spawnWaveAgentWithFallback,
  type WaveExecutionResult,
  type WaveOptions,
} from './wave-executor.js';
export {
  type AIWaveName,
  DEFAULT_THINKING_LEVELS,
  type FixAIWaveName,
  getWaveTools,
  resolveThinkingLevel,
  WAVE_TOOLS,
} from './wave-tools.js';
