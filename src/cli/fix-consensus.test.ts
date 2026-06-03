// CLI wiring tests for `kova fix --consensus / --pool / --consensus-waves` (#261).
//
// Source-inspection tests mirror the pattern in fix-mode.test.ts. We assert
// that the flags are declared on the Commander command, the opts shape
// includes the new fields, and the parsed values flow into the fix() call.

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

describe('kova fix --consensus flag wiring', () => {
  it('declares --consensus as a boolean flag on the fix command', () => {
    const src = getCliSource();
    expect(src).toMatch(/--consensus/);
  });

  it('declares --pool <spec> on the fix command', () => {
    const src = getCliSource();
    expect(src).toMatch(/--pool\s+<spec>/);
  });

  it('declares --consensus-waves <waves> on the fix command', () => {
    const src = getCliSource();
    expect(src).toMatch(/--consensus-waves\s+<waves>/);
  });

  it('documents pool spec format in the help text', () => {
    const src = getCliSource();
    // The --pool option description should hint at the format users can pass:
    // `diverse` shorthand or a comma list of `provider:model` pairs.
    const optMatch = src.match(/\.option\(\s*'--pool\s+<spec>'\s*,\s*'([\s\S]+?)'/);
    expect(optMatch).not.toBeNull();
    const description = optMatch?.[1] ?? '';
    expect(description).toMatch(/diverse|provider:model/i);
  });

  it('documents valid consensus waves in the help text', () => {
    const src = getCliSource();
    const optMatch = src.match(/\.option\(\s*'--consensus-waves\s+<waves>'\s*,\s*'([\s\S]+?)'/);
    expect(optMatch).not.toBeNull();
    const description = optMatch?.[1] ?? '';
    // Mentions the default-on waves so users see what kicks off without --consensus-waves.
    expect(description).toMatch(/assess|spec|review/i);
  });

  it('opts type includes the consensus / pool / consensusWaves fields', () => {
    const src = getCliSource();
    // Commander converts --consensus-waves to consensusWaves on the opts object.
    expect(src).toMatch(/consensus\?:\s*boolean/);
    expect(src).toMatch(/pool\?:\s*string/);
    expect(src).toMatch(/consensusWaves\?:\s*string/);
  });

  it('forwards consensus flags into the fix() call', () => {
    const src = getCliSource();
    // The fix() invocation should forward parsed consensus pool / waves via
    // the new FixOptions fields. We assert presence of the field names in the
    // call site; exact value is the consensus-flags helpers.
    expect(src).toMatch(/consensusPool\??:|consensusPool:\s*/);
    expect(src).toMatch(/consensusWaves\??:|consensusWaves:\s*/);
  });
});

describe('FixOptions consensus fields', () => {
  it('FixOptions interface exposes optional consensusPool field', () => {
    const src = getFixPipelineSource();
    // The interface body should declare an optional pool array field.
    expect(src).toMatch(/consensusPool\?:/);
  });

  it('FixOptions interface exposes optional consensusWaves field', () => {
    const src = getFixPipelineSource();
    expect(src).toMatch(/consensusWaves\?:/);
  });

  it('fix.ts imports applyConsensusToConfig', () => {
    const src = getFixPipelineSource();
    expect(src).toMatch(/applyConsensusToConfig/);
  });
});
