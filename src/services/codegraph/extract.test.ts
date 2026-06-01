import { describe, expect, it } from 'vitest';
import { extractSymbols } from './extract.js';

describe('extractSymbols (TypeScript)', () => {
  it('extracts top-level function declarations with line ranges', async () => {
    const src = `export function foo(): number {
  return 1;
}

function bar(x: string) {
  return x;
}
`;
    const { nodes } = await extractSymbols('src/a.ts', src);
    const foo = nodes.find((n) => n.name === 'foo');
    const bar = nodes.find((n) => n.name === 'bar');
    expect(foo).toBeDefined();
    expect(bar).toBeDefined();
    expect(foo).toMatchObject({ kind: 'function', isExported: true, filePath: 'src/a.ts', startLine: 1, endLine: 3 });
    expect(bar).toMatchObject({ kind: 'function', isExported: false, filePath: 'src/a.ts', startLine: 5, endLine: 7 });
    expect(foo?.signature).toMatch(/^export function foo/);
    expect(bar?.signature).toMatch(/^function bar/);
  });

  it('extracts class declarations and methods', async () => {
    const src = `export class Foo {
  bar(): void {}
  baz(x: number): number { return x; }
}
`;
    const { nodes } = await extractSymbols('src/c.ts', src);
    expect(nodes.find((n) => n.name === 'Foo' && n.kind === 'class')).toMatchObject({ isExported: true });
    expect(nodes.find((n) => n.name === 'bar' && n.kind === 'method')).toBeDefined();
    expect(nodes.find((n) => n.name === 'baz' && n.kind === 'method')).toBeDefined();
  });

  it('extracts call edges between same-file functions', async () => {
    const src = `function helper() { return 1; }
function main() {
  return helper();
}
`;
    const { nodes, edges } = await extractSymbols('src/m.ts', src);
    const helper = nodes.find((n) => n.name === 'helper');
    const main = nodes.find((n) => n.name === 'main');
    expect(helper).toBeDefined();
    expect(main).toBeDefined();
    const callEdge = edges.find((e) => e.source === main?.id && e.target === helper?.id && e.kind === 'calls');
    expect(callEdge).toBeDefined();
  });

  it('emits imports edges as module: prefixed targets', async () => {
    const src = `import { readFile } from 'node:fs/promises';
import './sibling.js';
export function load() {
  return readFile('x');
}
`;
    const { edges } = await extractSymbols('src/i.ts', src);
    const imports = edges.filter((e) => e.kind === 'imports').map((e) => e.target);
    expect(imports).toEqual(expect.arrayContaining(['module:node:fs/promises', 'module:./sibling.js']));
  });

  it('marks exported declarations correctly', async () => {
    const src = `export function pub() {}
function priv() {}
export const arrow = () => {};
`;
    const { nodes } = await extractSymbols('src/x.ts', src);
    expect(nodes.find((n) => n.name === 'pub')?.isExported).toBe(true);
    expect(nodes.find((n) => n.name === 'priv')?.isExported).toBe(false);
    expect(nodes.find((n) => n.name === 'arrow')?.isExported).toBe(true);
  });

  it('extracts interface and type-alias declarations', async () => {
    const src = `export interface Point { x: number; y: number }
type Pair = [number, number];
`;
    const { nodes } = await extractSymbols('src/t.ts', src);
    expect(nodes.find((n) => n.name === 'Point' && n.kind === 'interface')).toBeDefined();
    expect(nodes.find((n) => n.name === 'Pair' && n.kind === 'type')).toBeDefined();
  });

  it('returns empty extract result for empty/whitespace input', async () => {
    const { nodes, edges } = await extractSymbols('src/empty.ts', '\n   \n');
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('uses stable IDs that include the start line so shadowed names stay distinct', async () => {
    const src = `function foo() { return 1; }
{
  function foo() { return 2; }
}
`;
    const { nodes } = await extractSymbols('src/s.ts', src);
    const foos = nodes.filter((n) => n.name === 'foo');
    expect(foos.length).toBe(2);
    expect(new Set(foos.map((n) => n.id)).size).toBe(2);
  });
});
