import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('metrics wiring in CLI entrypoints', () => {
  it('imports initMetrics and shutdownMetrics', () => {
    const src = getCliSource();
    expect(src).toContain('initMetrics');
    expect(src).toContain('shutdownMetrics');
  });

  it('calls initMetrics in the fix command action', () => {
    const src = getCliSource();
    // initMetrics should appear after resolveRepo in the fix command
    const fixCommandIdx = src.indexOf(".command('fix')");
    const autoCommandIdx = src.indexOf(".command('auto')");
    const fixSection = src.slice(fixCommandIdx, autoCommandIdx);
    expect(fixSection).toContain('initMetrics(config.metrics)');
  });

  it('calls shutdownMetrics in the fix command cleanup', () => {
    const src = getCliSource();
    const fixCommandIdx = src.indexOf(".command('fix')");
    const autoCommandIdx = src.indexOf(".command('auto')");
    const fixSection = src.slice(fixCommandIdx, autoCommandIdx);
    expect(fixSection).toContain('shutdownMetrics()');
  });

  it('calls initMetrics in the auto command action', () => {
    const src = getCliSource();
    const autoCommandIdx = src.indexOf(".command('auto')");
    const brainstormCommandIdx = src.indexOf(".command('brainstorm')");
    const autoSection = src.slice(autoCommandIdx, brainstormCommandIdx);
    expect(autoSection).toContain('initMetrics');
  });

  it('calls shutdownMetrics in the auto command cleanup', () => {
    const src = getCliSource();
    const autoCommandIdx = src.indexOf(".command('auto')");
    const brainstormCommandIdx = src.indexOf(".command('brainstorm')");
    const autoSection = src.slice(autoCommandIdx, brainstormCommandIdx);
    expect(autoSection).toContain('shutdownMetrics()');
  });

  it('calls initMetrics in the serve command action', () => {
    const src = getCliSource();
    const serveIdx = src.indexOf(".command('serve')");
    const mergeIdx = src.indexOf(".command('merge')");
    const serveSection = src.slice(serveIdx, mergeIdx);
    expect(serveSection).toContain('initMetrics(config.metrics)');
  });

  it('calls shutdownMetrics in the serve command cleanup', () => {
    const src = getCliSource();
    const serveIdx = src.indexOf(".command('serve')");
    const mergeIdx = src.indexOf(".command('merge')");
    const serveSection = src.slice(serveIdx, mergeIdx);
    expect(serveSection).toContain('shutdownMetrics()');
  });

  it('calls initMetrics in the supervised command action', () => {
    const src = getCliSource();
    const supervisedIdx = src.indexOf(".command('supervised')");
    const statusIdx = src.indexOf(".command('status')");
    const supervisedSection = src.slice(supervisedIdx, statusIdx);
    expect(supervisedSection).toContain('initMetrics(config.metrics)');
  });

  it('calls shutdownMetrics in the supervised command cleanup', () => {
    const src = getCliSource();
    const supervisedIdx = src.indexOf(".command('supervised')");
    const statusIdx = src.indexOf(".command('status')");
    const supervisedSection = src.slice(supervisedIdx, statusIdx);
    expect(supervisedSection).toContain('shutdownMetrics()');
  });
});
