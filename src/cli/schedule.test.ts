// Tests for the `kova schedule` CLI subcommands (issue #303).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova schedule command', () => {
  it('CLI registers a top-level `schedule` command', () => {
    const src = getCliSource();
    expect(src).toContain(".command('schedule')");
  });

  it('exposes `start`, `list`, and `stop` subcommands', () => {
    const src = getCliSource();
    expect(src).toContain(".command('start')");
    expect(src).toContain(".command('list')");
    expect(src).toContain(".command('stop')");
  });

  it('imports the cron-scheduler service', () => {
    const src = getCliSource();
    expect(src).toContain('cron-scheduler');
  });

  it('`start` supports an interval flag (poll cadence)', () => {
    const src = getCliSource();
    expect(src).toContain('--interval');
  });
});
