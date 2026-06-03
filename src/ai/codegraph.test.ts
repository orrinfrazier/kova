// Tests for src/ai/codegraph.ts — wrappers around the external `codegraph` CLI.
// Helpers are dep-injected (the optional `exec` arg) so tests inject a fake
// without vi.mock'ing child_process. Real execFile is exercised by the integration
// path in fix.ts (manually verified) — kept out of unit tests to stay hermetic.

import { describe, expect, it } from 'vitest';
import {
  initCodegraph,
  isCodegraphOnPath,
  probeCodegraphStatus,
  shouldWithholdCodegraphTools,
  syncCodegraph,
} from './codegraph.js';

type FakeExecResult = { stdout: string; stderr: string; code: number };
type FakeExec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<FakeExecResult>;

function makeExec(map: Record<string, FakeExecResult | Error>): FakeExec {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    const v = map[key];
    if (v === undefined) {
      // Default: missing command -> ENOENT-like rejection
      throw Object.assign(new Error(`command not found: ${cmd}`), { code: 'ENOENT' });
    }
    if (v instanceof Error) throw v;
    if (v.code !== 0) {
      // Match Node's execFile error shape: rejected error with code/stdout/stderr
      throw Object.assign(new Error(`exit ${v.code}: ${v.stderr || v.stdout}`), {
        code: v.code,
        stdout: v.stdout,
        stderr: v.stderr,
      });
    }
    return v;
  };
}

describe('isCodegraphOnPath', () => {
  it('returns true when `codegraph --version` exits 0', async () => {
    const exec = makeExec({ 'codegraph --version': { stdout: 'codegraph 1.2.3', stderr: '', code: 0 } });
    expect(await isCodegraphOnPath(exec)).toBe(true);
  });

  it('returns false when codegraph is not installed (ENOENT)', async () => {
    const exec = makeExec({});
    expect(await isCodegraphOnPath(exec)).toBe(false);
  });

  it('returns false when codegraph errors out', async () => {
    const exec = makeExec({ 'codegraph --version': { stdout: '', stderr: 'boom', code: 2 } });
    expect(await isCodegraphOnPath(exec)).toBe(false);
  });
});

describe('initCodegraph', () => {
  it('runs `codegraph init <workDir> --index` and returns ok on success', async () => {
    const exec = makeExec({
      'codegraph init /work --index': { stdout: 'indexed 42 files', stderr: '', code: 0 },
    });
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('returns ok=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('returns ok=false with reason=exec-failed on non-zero exit', async () => {
    const exec = makeExec({
      'codegraph init /work --index': { stdout: '', stderr: 'index failed', code: 1 },
    });
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exec-failed');
  });

  it('NEVER throws — wraps every error path into the typed return shape', async () => {
    const exec: FakeExec = async () => {
      throw new Error('weird non-ENOENT failure');
    };
    const r = await initCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('probeCodegraphStatus', () => {
  it('parses {"initialized": true, "nodes": 1234} JSON output', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': {
        stdout: '{"initialized": true, "nodes": 1234}',
        stderr: '',
        code: 0,
      },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(true);
    expect(r.nodeCount).toBe(1234);
  });

  it('returns initialized=false, nodeCount=0 when JSON reports uninitialized', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': {
        stdout: '{"initialized": false, "nodes": 0}',
        stderr: '',
        code: 0,
      },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.nodeCount).toBe(0);
  });

  it('returns initialized=false on parse failure with reason set', async () => {
    const exec = makeExec({
      'codegraph status --json --cwd /work': { stdout: 'not-json-at-all', stderr: '', code: 0 },
    });
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.nodeCount).toBe(0);
    expect(r.reason).toBeDefined();
  });

  it('returns initialized=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('NEVER throws', async () => {
    const exec: FakeExec = async () => {
      throw new Error('weird');
    };
    const r = await probeCodegraphStatus('/work', exec);
    expect(r.initialized).toBe(false);
  });
});

describe('syncCodegraph', () => {
  it('runs `codegraph sync --cwd <workDir>` and returns ok=true on success', async () => {
    const exec = makeExec({ 'codegraph sync --cwd /work': { stdout: 'synced', stderr: '', code: 0 } });
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(true);
  });

  it('returns ok=false with reason=not-on-path when codegraph missing', async () => {
    const exec = makeExec({});
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-on-path');
  });

  it('returns ok=false with reason=exec-failed on non-zero exit', async () => {
    const exec = makeExec({ 'codegraph sync --cwd /work': { stdout: '', stderr: 'sync failed', code: 1 } });
    const r = await syncCodegraph('/work', exec);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exec-failed');
  });
});

describe('shouldWithholdCodegraphTools', () => {
  it('returns true when probe reports uninitialized', () => {
    expect(shouldWithholdCodegraphTools({ initialized: false, nodeCount: 0 })).toBe(true);
  });

  it('returns true when probe reports zero nodes (initialized but empty)', () => {
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 0 })).toBe(true);
  });

  it('returns false only when initialized AND nodeCount > 0', () => {
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 1 })).toBe(false);
    expect(shouldWithholdCodegraphTools({ initialized: true, nodeCount: 999 })).toBe(false);
  });
});
