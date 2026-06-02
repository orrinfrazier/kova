// Tests for createPipelineTool — programmatic tool calling via in-process RPC.
// The model emits a JS script that calls tools.<name>(args) in-process; only
// the script's captured stdout returns to the agent. Intermediate tool results
// never enter the agent's content array.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPipelineTool, PIPELINE_TOOL_DEFAULTS } from './pipeline-tool.js';

// biome-ignore lint/suspicious/noExplicitAny: AgentTool uses any for parameter schemas
type AnyTool = AgentTool<any>;

/** Make a fake AgentTool with deterministic behavior for testing. */
function makeFakeTool(name: string, run: (params: Record<string, unknown>) => string): AnyTool {
  return {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: Type.Object({}),
    async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> {
      const out = run((params ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: out }], details: undefined };
    },
  };
}

describe('createPipelineTool', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pipeline-tool-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an AgentTool named execute_pipeline', () => {
    const tool = createPipelineTool(tmp, []);
    expect(tool.name).toBe('execute_pipeline');
    expect(typeof tool.execute).toBe('function');
    expect(tool.description).toBeTruthy();
  });

  it('runs a script that calls one tool and returns only the script stdout', async () => {
    const echo = makeFakeTool('echo', (p) => `echo:${String(p.text ?? '')}`);
    const pipe = createPipelineTool(tmp, [echo]);
    const result = await pipe.execute('call-1', {
      script: "const r = await tools.echo({ text: 'hi' }); console.log(r.content[0].text);",
    });
    expect(result.content).toHaveLength(1);
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('echo:hi');
  });

  it('intermediate tool outputs are NOT in returned content (only script stdout)', async () => {
    const secret = makeFakeTool('secret', () => 'INTERMEDIATE_SECRET_VALUE');
    const pipe = createPipelineTool(tmp, [secret]);
    // Script calls the tool but only logs a derived summary — the intermediate
    // tool output must not leak into the returned content.
    const result = await pipe.execute('call-1', {
      script: `
        const r = await tools.secret({});
        const text = r.content[0].text;
        // Deliberately log only the length, not the secret itself
        console.log('len=' + text.length);
      `,
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(allText).toContain('len=25');
    expect(allText).not.toContain('INTERMEDIATE_SECRET_VALUE');
  });

  it('supports multiple sequential tool calls in one script', async () => {
    const a = makeFakeTool('a', () => 'A');
    const b = makeFakeTool('b', () => 'B');
    const c = makeFakeTool('c', () => 'C');
    const pipe = createPipelineTool(tmp, [a, b, c]);
    const result = await pipe.execute('call-1', {
      script: `
        const x = (await tools.a({})).content[0].text;
        const y = (await tools.b({})).content[0].text;
        const z = (await tools.c({})).content[0].text;
        console.log(x + y + z);
      `,
    });
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('ABC');
  });

  it('dispatches against real read tool', async () => {
    // Write a real file in the cwd so the script can read it
    const filePath = join(tmp, 'hello.txt');
    writeFileSync(filePath, 'hello-from-disk', 'utf-8');

    // Lazy-import the real read tool from pi-coding-agent
    const { createReadTool } = await import('@earendil-works/pi-coding-agent');
    const readTool = createReadTool(tmp);
    const pipe = createPipelineTool(tmp, [readTool]);

    const result = await pipe.execute('call-1', {
      script: `
        const r = await tools.${readTool.name}({ path: ${JSON.stringify(filePath)} });
        // r is an AgentToolResult — content[0].text holds the file body (possibly with line numbers)
        const text = r.content[0].text;
        console.log('READ:' + (text.includes('hello-from-disk') ? 'ok' : 'fail'));
      `,
    });
    const first = result.content[0];
    expect(first?.type === 'text' && first.text).toContain('READ:ok');
  });

  it('enforces max-call cap and returns an error', async () => {
    const noop = makeFakeTool('noop', () => 'x');
    const pipe = createPipelineTool(tmp, [noop], { maxCalls: 3 });
    const result = await pipe.execute('call-1', {
      script: `
        for (let i = 0; i < 10; i++) {
          await tools.noop({});
        }
        console.log('should-not-reach');
      `,
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(allText.toLowerCase()).toContain('max');
    expect(allText).not.toContain('should-not-reach');
  });

  it('enforces script timeout and returns an error', async () => {
    const pipe = createPipelineTool(tmp, [], { timeoutMs: 50 });
    const result = await pipe.execute('call-1', {
      // Busy-wait synchronously so vm timeout fires
      script: 'const end = Date.now() + 2000; while (Date.now() < end) { /* spin */ }',
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(allText.toLowerCase()).toMatch(/timeout|timed out/);
  });

  it('caps captured stdout to maxOutputBytes', async () => {
    const pipe = createPipelineTool(tmp, [], { maxOutputBytes: 100 });
    const result = await pipe.execute('call-1', {
      script: "console.log('X'.repeat(10000));",
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    // Truncation indicator should be present, and total length should be bounded
    expect(allText.length).toBeLessThan(500);
    expect(allText.toLowerCase()).toContain('truncated');
  });

  it('returns script error message when script throws', async () => {
    const pipe = createPipelineTool(tmp, []);
    const result = await pipe.execute('call-1', {
      script: "throw new Error('boom-from-script');",
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(allText).toContain('boom-from-script');
  });

  it('rejects a tool call to a name not in the allowlist', async () => {
    const a = makeFakeTool('a', () => 'A');
    const pipe = createPipelineTool(tmp, [a]);
    const result = await pipe.execute('call-1', {
      script: 'await tools.b({});',
    });
    const allText = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    // The script will fail because tools.b is undefined; assert error is surfaced
    expect(allText.toLowerCase()).toMatch(/undefined|not a function|tools\.b/);
  });

  it('exposes script parameter in the tool schema (parameters.properties.script)', () => {
    const tool = createPipelineTool(tmp, []);
    // The parameter schema should be a JSON-Schema-like TSchema with a script property
    const params = tool.parameters as { properties?: Record<string, unknown> };
    expect(params.properties?.script).toBeDefined();
  });

  it('defaults are exported and sane', () => {
    expect(PIPELINE_TOOL_DEFAULTS.maxCalls).toBeGreaterThan(0);
    expect(PIPELINE_TOOL_DEFAULTS.timeoutMs).toBeGreaterThan(0);
    expect(PIPELINE_TOOL_DEFAULTS.maxOutputBytes).toBeGreaterThan(0);
  });
});
