// Integration test: indexCodebase populates a codegraph DB alongside the vectordb.
//
// Uses a real git repo + real SQLite (no mocks of the codegraph internals) so the
// wiring is genuinely exercised. The vectordb side is stubbed because it requires
// a remote endpoint.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/memory/code-rest.js', () => ({
  upsertChunks: vi.fn().mockResolvedValue(undefined),
}));

import { openCodegraph } from '../services/codegraph/index.js';
import { indexCodebase } from './index-codebase.js';

describe('indexCodebase + codegraph wiring', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kova-idx-cg-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'lib.ts'),
      `export function helper() { return 1; }
export function main() { return helper(); }
`,
    );
    execSync('git add -A', { cwd: repo });
    execSync('git commit -q -m init', { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('populates .kova/codegraph.db with nodes during a full index', async () => {
    await indexCodebase({ repoPath: repo, full: true });
    const dbPath = join(repo, '.kova', 'codegraph.db');
    expect(existsSync(dbPath)).toBe(true);
    const cg = openCodegraph(dbPath);
    const helper = cg.findSymbol('helper');
    const main = cg.findSymbol('main');
    expect(helper).toHaveLength(1);
    expect(main).toHaveLength(1);
    expect(helper[0]?.filePath).toBe('src/lib.ts');
    cg.close();
  });

  it('captures same-file calls edges (main -> helper)', async () => {
    await indexCodebase({ repoPath: repo, full: true });
    const cg = openCodegraph(join(repo, '.kova', 'codegraph.db'));
    const main = cg.findSymbol('main')[0];
    if (!main) throw new Error('expected main symbol');
    const callees = cg.getCallees(main.id).map((n) => n.name);
    expect(callees).toContain('helper');
    cg.close();
  });
});
