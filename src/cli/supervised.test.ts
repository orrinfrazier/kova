import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CLI_CWD = '/Users/orrinfrazier/dev/orrinfrazier/kova-wt-63';

function runCli(args: string): string {
  // Commander writes --help to stdout; supervised --help exits 0
  try {
    return execSync(`npx tsx src/cli/index.ts ${args}`, {
      cwd: CLI_CWD,
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (err: unknown) {
    // execSync throws on non-zero exit, but --help may exit 0; re-throw as readable message
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout ?? '', e.stderr ?? ''].join('\n');
    if (combined.trim()) {
      return combined;
    }
    throw err;
  }
}

describe('kova supervised command', () => {
  it('shows command description in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('Supervised mode — brainstorm, approve, fix batch, review PRs');
  });

  it('lists --skip-brainstorm flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--skip-brainstorm');
  });

  it('lists --repo flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--repo');
  });

  it('lists --threshold flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--threshold');
  });

  it('lists --focus flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--focus');
  });

  it('lists --yes flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--yes');
  });

  it('lists --budget flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--budget');
  });

  it('lists --max flag in --help output', () => {
    const output = runCli('supervised --help');
    expect(output).toContain('--max');
  });
});
