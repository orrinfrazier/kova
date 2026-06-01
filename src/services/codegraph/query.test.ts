import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSource, openCodegraph } from './query.js';

describe('codegraph query (integration: extract -> store)', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-codegraph-q-'));
    dbPath = join(tmp, 'codegraph.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('findSymbol resolves a function declared in indexed source', async () => {
    const cg = openCodegraph(dbPath);
    await indexSource(cg, 'src/a.ts', 'export function greet() { return "hi"; }\n');
    const hits = cg.findSymbol('greet');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'greet', filePath: 'src/a.ts', startLine: 1, endLine: 1 });
    cg.close();
  });

  it('getCallers/getCallees return correct same-file neighbors after indexing', async () => {
    const cg = openCodegraph(dbPath);
    await indexSource(
      cg,
      'src/m.ts',
      `function helper() { return 1; }
function main() { return helper(); }
`,
    );
    const helper = cg.findSymbol('helper')[0];
    const main = cg.findSymbol('main')[0];
    if (!helper || !main) throw new Error('expected helper and main symbols');
    expect(cg.getCallers(helper.id).map((n) => n.name)).toEqual(['main']);
    expect(cg.getCallees(main.id).map((n) => n.name)).toEqual(['helper']);
    cg.close();
  });

  it('incremental re-index skips unchanged files', async () => {
    const cg = openCodegraph(dbPath);
    const r1 = await indexSource(cg, 'src/a.ts', 'export function a() {}\n');
    expect(r1.changed).toBe(true);
    const r2 = await indexSource(cg, 'src/a.ts', 'export function a() {}\n');
    expect(r2.changed).toBe(false);
    expect(r2.nodesWritten).toBe(0);
    cg.close();
  });

  it('getImpactRadius walks reverse call edges across files', async () => {
    const cg = openCodegraph(dbPath);
    await indexSource(cg, 'src/lib.ts', 'export function leaf() { return 1; }\n');
    // Manually wire a cross-file edge through the store layer — the extractor's
    // cross-file resolution is intentionally out of scope for the initial cut.
    const leaf = cg.findSymbol('leaf')[0];
    if (!leaf) throw new Error('expected leaf symbol');
    const leafId = leaf.id;
    cg.upsertFile(
      'src/up.ts',
      'h-up',
      [
        {
          id: 'src/up.ts::caller@1',
          kind: 'function',
          name: 'caller',
          filePath: 'src/up.ts',
          startLine: 1,
          endLine: 2,
          signature: 'function caller()',
          isExported: false,
        },
      ],
      [{ source: 'src/up.ts::caller@1', target: leafId, kind: 'calls' }],
    );
    const radius = cg.getImpactRadius('src/lib.ts');
    expect(radius).toContain('src/up.ts::caller@1');
    cg.close();
  });
});
