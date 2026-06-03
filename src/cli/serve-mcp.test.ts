// Source-inspection tests for the `kova serve --mcp` flag (issue #311).
//
// Mirrors the pattern in fix-mode.test.ts: we don't spawn the CLI, we read
// the source and assert the option is declared + wired. Spawning would
// require building first and starting a stdio MCP server, which is covered
// at the unit level by src/ai/mcp-server/server.test.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova serve --mcp flag wiring', () => {
  it('declares --mcp on the serve command', () => {
    const src = getCliSource();
    // commander option line for --mcp (boolean flag — no value parameter)
    expect(src).toMatch(/\.option\(\s*'--mcp'/);
  });

  it('mentions issue #311 in the option description for traceability', () => {
    const src = getCliSource();
    expect(src).toMatch(/--mcp[\s\S]+?311/);
  });

  it('opts type for serve includes the optional mcp boolean field', () => {
    const src = getCliSource();
    // The opts inline type literal for the serve command should accept mcp
    expect(src).toMatch(/mcp\?:\s*boolean/);
  });

  it('calls startKovaMcpServerOnStdio when the flag is set', () => {
    const src = getCliSource();
    expect(src).toMatch(/startKovaMcpServerOnStdio/);
  });

  it('imports the mcp-server module dynamically from the serve action', () => {
    const src = getCliSource();
    expect(src).toMatch(/await\s+import\(\s*['"]\.\.\/ai\/mcp-server\/index\.js['"]\s*\)/);
  });
});
