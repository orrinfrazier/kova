// Barrel export for the kova MCP server module (issue #311).
// Public surface kept minimal: factory, stdio bootstrap, and the schema
// helpers external callers may want when wiring kova into another runtime.

export { type AdapterCallResult, type AdaptWaveCallOptions, adaptWaveCall, type SpawnWaveFn } from './adapter.js';
export {
  getMcpServerToolName,
  getWaveInputSchema,
  getWaveOutputJsonSchema,
  type JsonSchemaObject,
  KOVA_MCP_WAVES,
  type KovaMcpWave,
  parseWaveInput,
  type WaveInput,
  type WaveInputParsed,
  WaveInputSchema,
} from './schemas.js';
export {
  type CreateKovaMcpServerOptions,
  type CreateKovaMcpServerResult,
  createKovaMcpServer,
  startKovaMcpServerOnStdio,
} from './server.js';
