// Kova MCP server bootstrap (issue #311).
//
// Exposes the six wave runners (`kova.run_assess` … `kova.run_review`) as MCP
// tools over stdio. External MCP-aware runtimes — pi-mono, claude-code,
// Claude Desktop — can drive a kova wave as a single RPC instead of
// re-implementing the wave loop.
//
// Architecture:
//   - `createKovaMcpServer({ spawnWave? })` builds an `McpServer` with all
//     six tools registered. The `spawnWave` injection point keeps the unit
//     tests offline.
//   - `startKovaMcpServerOnStdio()` wires the server to a
//     `StdioServerTransport` and runs until the transport closes.
//
// Notes:
//   - We register every tool against the SAME hand-written input schema
//     (`WaveInputSchema`) because the per-wave variation lives in the
//     `user_message` payload, not in the schema. The output schema IS
//     per-wave because it's auto-derived from `src/types/waves.ts`.
//   - We use the SDK's `Server` low-level API rather than the `McpServer`
//     high-level helper to avoid coupling to the SDK's Zod-shape wrapper —
//     we already hand kova-Zod schemas around the rest of the codebase, so
//     a thin `setRequestHandler` shim is the cleanest seam.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from '../../utils/logger.js';
import { adaptWaveCall, type SpawnWaveFn } from './adapter.js';
import {
  getMcpServerToolName,
  getWaveInputSchema,
  getWaveOutputJsonSchema,
  KOVA_MCP_WAVES,
  type KovaMcpWave,
  parseWaveInput,
} from './schemas.js';

export interface CreateKovaMcpServerOptions {
  /** Inject a custom wave spawner. Defaults to the real `spawnWaveAgent`. */
  spawnWave?: SpawnWaveFn;
  /** Server name advertised to MCP clients. Defaults to `kova`. */
  serverName?: string;
  /** Server version advertised to MCP clients. Defaults to kova package version. */
  serverVersion?: string;
}

export interface CreateKovaMcpServerResult {
  server: Server;
  registeredTools: string[];
}

const TOOL_DESCRIPTION_BY_WAVE: Record<KovaMcpWave, string> = {
  assess: 'Run kova ASSESS wave: grade feasibility (A-F), enumerate surface area, classify risk. Returns AssessResult.',
  spec: 'Run kova SPEC wave: decompose into testable pieces with acceptance criteria. Returns SpecResult.',
  test: 'Run kova TEST wave: write failing tests (red phase) per the spec. Returns TestResult.',
  impl: 'Run kova IMPL wave: write minimal code to pass tests (green phase). Returns ImplResult.',
  quality:
    'Run kova QUALITY wave: lint, typecheck, test, audit, secrets-scan. Auto-fixes mechanical issues. Returns QualityResult.',
  review:
    'Run kova REVIEW wave: review changes, categorize findings (needs_new_tests | mechanical_fix). Returns ReviewResult.',
};

/** Build (but do not start) a kova MCP server. Caller is responsible for
 *  attaching a transport via `server.connect(transport)`. */
export function createKovaMcpServer(options?: CreateKovaMcpServerOptions): CreateKovaMcpServerResult {
  const spawnFn = options?.spawnWave;
  const server = new Server(
    {
      name: options?.serverName ?? 'kova',
      version: options?.serverVersion ?? '0.2.75',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const registeredTools: string[] = [];
  for (const wave of KOVA_MCP_WAVES) {
    registeredTools.push(getMcpServerToolName(wave));
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: KOVA_MCP_WAVES.map((wave) => ({
        name: getMcpServerToolName(wave),
        description: TOOL_DESCRIPTION_BY_WAVE[wave],
        inputSchema: getWaveInputSchema(wave),
        outputSchema: getWaveOutputJsonSchema(wave),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const wave = waveFromToolName(toolName);
    if (wave == null) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      };
    }

    let parsed: ReturnType<typeof parseWaveInput>;
    try {
      parsed = parseWaveInput(wave, request.params.arguments ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid input for ${toolName}: ${message}` }],
      };
    }

    const result = await adaptWaveCall(wave, parsed, spawnFn ? { spawnWave: spawnFn } : undefined);
    return result as CallToolResult;
  });

  return { server, registeredTools };
}

const TOOL_NAME_TO_WAVE = new Map<string, KovaMcpWave>(KOVA_MCP_WAVES.map((w) => [getMcpServerToolName(w), w]));

function waveFromToolName(name: string): KovaMcpWave | null {
  return TOOL_NAME_TO_WAVE.get(name) ?? null;
}

/** Start the kova MCP server on stdio. Resolves once the transport is
 *  connected; the process should remain alive on its own (the transport
 *  holds the event loop open via stdin reads). */
export async function startKovaMcpServerOnStdio(options?: CreateKovaMcpServerOptions): Promise<Server> {
  const { server, registeredTools } = createKovaMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`[mcp-server] listening on stdio with ${registeredTools.length} tools: ${registeredTools.join(', ')}`);
  return server;
}
