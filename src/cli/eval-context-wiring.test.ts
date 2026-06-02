// Wiring tests for the `kova eval context` command (issue #278). Verifies the
// command is registered in src/cli/index.ts and that its action delegates to the
// canonical context-arm eval helpers — no behavioral logic lives in the CLI.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova eval context command wiring (issue #278)', () => {
  it('registers an `eval` top-level command', () => {
    const src = getCliSource();
    expect(src).toMatch(/\.command\(['"]eval['"]\)/);
  });

  it('registers an `eval context` subcommand', () => {
    const src = getCliSource();
    expect(src).toMatch(/\.command\(['"]context['"]\)/);
  });

  it('delegates to the eval-context-arm service rather than reimplementing logic', () => {
    const src = getCliSource();
    expect(src).toContain('eval-context-arm');
    // Must call the canonical service helpers.
    expect(src).toContain('computeContextArmDelta');
    expect(src).toContain('groupEntriesByContextArm');
    expect(src).toContain('formatContextArmDelta');
  });

  it('reads history via readHistory (reuses the existing history.jsonl source)', () => {
    const src = getCliSource();
    // The `eval context` action must read history — slice from `.command('context')`
    // forward and assert readHistory is invoked.
    const evalCtxIdx = src.indexOf(".command('context')");
    expect(evalCtxIdx).toBeGreaterThan(-1);
    const section = src.slice(evalCtxIdx, evalCtxIdx + 2000);
    expect(section).toContain('readHistory');
  });
});
