import { describe, expect, it } from 'vitest';
import { type ActionInputs, buildKovaArgs, validateInputs } from '../build-command.js';

/* ------------------------------------------------------------------ */
/*  validateInputs                                                     */
/* ------------------------------------------------------------------ */

describe('validateInputs', () => {
  it('rejects unknown mode', () => {
    expect(() => validateInputs({ mode: 'destroy' as ActionInputs['mode'] })).toThrow(/Invalid mode/);
  });

  it('requires issue_number for fix mode without all flag', () => {
    expect(() => validateInputs({ mode: 'fix' })).toThrow(/issue_number.+required/i);
  });

  it('accepts fix mode with issue_number', () => {
    expect(() => validateInputs({ mode: 'fix', issue_number: '42' })).not.toThrow();
  });

  it('accepts fix mode with all flag', () => {
    expect(() => validateInputs({ mode: 'fix', all: true })).not.toThrow();
  });

  it('accepts auto mode without issue_number', () => {
    expect(() => validateInputs({ mode: 'auto' })).not.toThrow();
  });

  it('accepts brainstorm mode without issue_number', () => {
    expect(() => validateInputs({ mode: 'brainstorm' })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  buildKovaArgs — fix mode                                           */
/* ------------------------------------------------------------------ */

describe('buildKovaArgs — fix mode', () => {
  it('builds single issue fix command', () => {
    const args = buildKovaArgs({ mode: 'fix', issue_number: '123' });
    expect(args).toEqual(['fix', '123']);
  });

  it('builds fix --all command', () => {
    const args = buildKovaArgs({ mode: 'fix', all: true });
    expect(args).toEqual(['fix', '--all']);
  });

  it('includes filter', () => {
    const args = buildKovaArgs({ mode: 'fix', all: true, filter: 'bug' });
    expect(args).toEqual(['fix', '--all', '--filter', 'bug']);
  });

  it('includes max_issues', () => {
    const args = buildKovaArgs({ mode: 'fix', all: true, max_issues: '5' });
    expect(args).toEqual(['fix', '--all', '--max', '5']);
  });

  it('includes budget', () => {
    const args = buildKovaArgs({ mode: 'fix', issue_number: '10', budget: '25' });
    expect(args).toEqual(['fix', '10', '--budget', '25']);
  });

  it('includes force flag', () => {
    const args = buildKovaArgs({ mode: 'fix', issue_number: '10', force: true });
    expect(args).toEqual(['fix', '10', '--force']);
  });

  it('includes config path', () => {
    const args = buildKovaArgs({ mode: 'fix', issue_number: '10', config: './repos.yaml' });
    expect(args).toEqual(['--config', './repos.yaml', 'fix', '10']);
  });

  it('combines all fix options', () => {
    const args = buildKovaArgs({
      mode: 'fix',
      all: true,
      filter: 'auto-fix',
      max_issues: '3',
      budget: '50',
      force: true,
      config: '/etc/kova.yaml',
    });
    expect(args).toEqual([
      '--config',
      '/etc/kova.yaml',
      'fix',
      '--all',
      '--filter',
      'auto-fix',
      '--max',
      '3',
      '--budget',
      '50',
      '--force',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  buildKovaArgs — auto mode                                          */
/* ------------------------------------------------------------------ */

describe('buildKovaArgs — auto mode', () => {
  it('builds basic auto command', () => {
    const args = buildKovaArgs({ mode: 'auto' });
    expect(args).toEqual(['auto']);
  });

  it('includes filter and max', () => {
    const args = buildKovaArgs({ mode: 'auto', filter: 'kova', max_issues: '5' });
    expect(args).toEqual(['auto', '--filter', 'kova', '--max', '5']);
  });

  it('includes force', () => {
    const args = buildKovaArgs({ mode: 'auto', force: true });
    expect(args).toEqual(['auto', '--force']);
  });
});

/* ------------------------------------------------------------------ */
/*  buildKovaArgs — brainstorm mode                                    */
/* ------------------------------------------------------------------ */

describe('buildKovaArgs — brainstorm mode', () => {
  it('builds brainstorm with --yes (non-interactive CI)', () => {
    const args = buildKovaArgs({ mode: 'brainstorm' });
    expect(args).toEqual(['brainstorm', '--yes']);
  });

  it('includes focus areas', () => {
    const args = buildKovaArgs({ mode: 'brainstorm', focus: 'security,performance' });
    expect(args).toEqual(['brainstorm', '--yes', '--focus', 'security,performance']);
  });
});

/* ------------------------------------------------------------------ */
/*  buildKovaArgs — global options                                     */
/* ------------------------------------------------------------------ */

describe('buildKovaArgs — global options', () => {
  it('prepends config before subcommand', () => {
    const args = buildKovaArgs({ mode: 'auto', config: '/path/to/repos.yaml' });
    expect(args[0]).toBe('--config');
    expect(args[1]).toBe('/path/to/repos.yaml');
    expect(args[2]).toBe('auto');
  });
});
