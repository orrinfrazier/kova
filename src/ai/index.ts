export { classifyError, type ErrorClassification, isRetryable, isSpendingCapBehavior, KovaError } from './errors.js';
export { type ModelSpec, parseModelSpec, resolveModel, resolveModelFromString } from './models.js';
export {
  executeWave,
  executeWaveWithRetry,
  type OutputFormat,
  type SpawnWaveAgentConfig,
  spawnWaveAgent,
  type WaveExecutionResult,
  type WaveOptions,
} from './wave-executor.js';
export { type AIWaveName, DEFAULT_THINKING_LEVELS, getWaveTools, WAVE_TOOLS } from './wave-tools.js';
