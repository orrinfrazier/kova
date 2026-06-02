import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

function getFixPipelineSource(): string {
  return readFileSync(resolve(root, 'src/pipeline/fix.ts'), 'utf-8');
}

describe('kova fix --mode flag wiring', () => {
  it('declares --mode <mode> on the fix command', () => {
    const src = getCliSource();
    // commander option line for --mode with a value parameter
    expect(src).toMatch(/--mode\s+<mode>/);
  });

  it('documents the four canonical mode values in the option description', () => {
    const src = getCliSource();
    // The option description should list simple|standard|economy|explore so
    // users see valid values in `kova fix --help`. Use a non-greedy match
    // that crosses newlines (the option call may wrap onto multiple lines).
    const optMatch = src.match(/\.option\(\s*'--mode\s+<mode>'\s*,\s*'([\s\S]+?)'/);
    expect(optMatch).not.toBeNull();
    const description = optMatch?.[1] ?? '';
    for (const mode of ['simple', 'standard', 'economy', 'explore']) {
      expect(description).toContain(mode);
    }
  });

  it('opts type includes the mode field', () => {
    const src = getCliSource();
    // The opts inline type literal for the fix command should accept mode
    expect(src).toMatch(/mode\?:\s*string/);
  });

  it('passes mode through to the fix() call', () => {
    const src = getCliSource();
    // The fix() invocation should forward opts.mode (gated on presence)
    expect(src).toMatch(/mode:\s*opts\.mode/);
  });
});

describe('FixOptions.mode wiring', () => {
  it('FixOptions interface exposes an optional mode field', () => {
    const src = getFixPipelineSource();
    // Match the FixOptions interface body shape
    expect(src).toMatch(/mode\?:\s*PipelineMode\s*\|\s*undefined/);
  });

  it('fix.ts imports PipelineMode and the mode helpers', () => {
    const src = getFixPipelineSource();
    expect(src).toMatch(/applyPipelineMode|autoSelectMode/);
  });

  it('fix.ts logs the pipeline mode decision', () => {
    const src = getFixPipelineSource();
    // The decision log line — surfaces auto-selected vs explicit
    expect(src).toMatch(/Pipeline mode/i);
  });
});
