import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova serve command', () => {
  it('CLI registers a serve command', () => {
    const src = getCliSource();
    expect(src).toContain(".command('serve')");
  });

  it('serve command has --port option', () => {
    const src = getCliSource();
    expect(src).toContain("'--port <number>'");
  });

  it('serve command imports webhook server', () => {
    const src = getCliSource();
    expect(src).toContain('webhook-server');
  });
});
