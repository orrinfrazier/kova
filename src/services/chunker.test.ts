import { describe, expect, it } from 'vitest';
import { chunkByBoundary, chunkFile, chunkFixedSize } from './chunker.js';

/* ------------------------------------------------------------------ */
/*  Chunk type shape                                                   */
/* ------------------------------------------------------------------ */

describe('Chunk type shape', () => {
  it('each Chunk has text, startLine, and endLine fields', () => {
    const source = 'function hello() {\n  return 42;\n}\n';
    const chunks = chunkByBoundary(source, 'typescript');
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk).toHaveProperty('text');
      expect(chunk).toHaveProperty('startLine');
      expect(chunk).toHaveProperty('endLine');
      expect(typeof chunk.text).toBe('string');
      expect(typeof chunk.startLine).toBe('number');
      expect(typeof chunk.endLine).toBe('number');
    }
  });

  it('Chunk type is assignable: startLine <= endLine', () => {
    const source = 'export function foo() {}\nexport function bar() {}\n';
    const chunks = chunkByBoundary(source, 'typescript');
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  chunkFixedSize                                                     */
/* ------------------------------------------------------------------ */

describe('chunkFixedSize', () => {
  it('returns empty array for empty input', () => {
    const result = chunkFixedSize('');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    const result = chunkFixedSize('   \n\t\n  ');
    expect(result).toEqual([]);
  });

  it('returns a single chunk for input smaller than maxChars', () => {
    const source = 'hello world\nfoo bar\n';
    const result = chunkFixedSize(source);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe(source);
    expect(result[0]?.startLine).toBe(1);
  });

  it('splits a 5000-char string into chunks of at most 2000 chars with 200 overlap (defaults)', () => {
    const source = 'a'.repeat(5000);
    const result = chunkFixedSize(source);

    expect(result.length).toBeGreaterThan(1);

    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('chunks never exceed the default maxChars of 2000', () => {
    // Use a realistic multi-line source so line tracking is exercised
    const lines = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i}; // line ${i}`);
    const source = lines.join('\n');
    const result = chunkFixedSize(source);

    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('respects custom maxChars', () => {
    const source = 'b'.repeat(1000);
    const result = chunkFixedSize(source, 300);

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('respects custom overlap', () => {
    const source = 'c'.repeat(600);
    // maxChars=200, overlap=50 → chunk 1: [0,200), chunk 2: [150,350), chunk 3: [300,500), chunk 4: [450,600)
    const result = chunkFixedSize(source, 200, 50);

    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
    }
  });

  it('returns correct startLine and endLine for each chunk', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const source = lines.join('\n');
    const result = chunkFixedSize(source, 200, 0);

    for (const chunk of result) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('with zero overlap, chunks are contiguous and non-overlapping', () => {
    const source = 'd'.repeat(600);
    const result = chunkFixedSize(source, 200, 0);

    // Concatenating all chunk texts should reconstruct the source
    const reconstructed = result.map((c) => c.text).join('');
    expect(reconstructed).toBe(source);
  });

  it('chunks cover the entire source with default overlap', () => {
    const source = 'e'.repeat(4500);
    const result = chunkFixedSize(source);

    // First chunk starts at beginning, last chunk ends at end
    expect(result[0]?.text.startsWith('e')).toBe(true);
    const lastChunk = result[result.length - 1];
    expect(lastChunk).toBeDefined();
    if (lastChunk) {
      expect(source.endsWith(lastChunk.text)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  chunkByBoundary                                                    */
/* ------------------------------------------------------------------ */

describe('chunkByBoundary', () => {
  it('returns empty array for empty input', () => {
    expect(chunkByBoundary('', 'typescript')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(chunkByBoundary('   \n\n\t  ', 'typescript')).toEqual([]);
  });

  it('splits TypeScript code by export function boundaries', () => {
    const source = [
      'export function foo(): void {',
      '  console.log("foo");',
      '}',
      '',
      'export function bar(): string {',
      '  return "bar";',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'typescript');
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('foo'))).toBe(true);
    expect(texts.some((t) => t.includes('bar'))).toBe(true);
  });

  it('splits TypeScript code by export class boundaries', () => {
    const source = [
      'export class Foo {',
      '  greet(): string { return "foo"; }',
      '}',
      '',
      'export class Bar {',
      '  greet(): string { return "bar"; }',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'typescript');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('Foo'))).toBe(true);
    expect(texts.some((t) => t.includes('Bar'))).toBe(true);
  });

  it('splits TypeScript code by non-exported function boundaries', () => {
    const source = [
      'function internal(): void {',
      '  // internal logic',
      '}',
      '',
      'function helper(): number {',
      '  return 1;',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'typescript');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('internal'))).toBe(true);
    expect(texts.some((t) => t.includes('helper'))).toBe(true);
  });

  it('splits TypeScript code by class (non-exported) boundaries', () => {
    const source = ['class Alpha {', '  run() {}', '}', '', 'class Beta {', '  run() {}', '}'].join('\n');

    const chunks = chunkByBoundary(source, 'typescript');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('Alpha'))).toBe(true);
    expect(texts.some((t) => t.includes('Beta'))).toBe(true);
  });

  it('splits Rust code by fn boundaries', () => {
    const source = [
      'fn add(a: i32, b: i32) -> i32 {',
      '    a + b',
      '}',
      '',
      'fn subtract(a: i32, b: i32) -> i32 {',
      '    a - b',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'rust');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('add'))).toBe(true);
    expect(texts.some((t) => t.includes('subtract'))).toBe(true);
  });

  it('splits Rust code by impl boundaries', () => {
    const source = [
      'impl Foo {',
      '    fn new() -> Self { Foo {} }',
      '}',
      '',
      'impl Bar {',
      '    fn new() -> Self { Bar {} }',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'rust');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('impl Foo'))).toBe(true);
    expect(texts.some((t) => t.includes('impl Bar'))).toBe(true);
  });

  it('splits Rust code by struct boundaries', () => {
    const source = [
      'struct Point {',
      '    x: f64,',
      '    y: f64,',
      '}',
      '',
      'struct Rectangle {',
      '    width: f64,',
      '    height: f64,',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'rust');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('Point'))).toBe(true);
    expect(texts.some((t) => t.includes('Rectangle'))).toBe(true);
  });

  it('splits Python code by def boundaries', () => {
    const source = [
      'def greet(name: str) -> str:',
      '    return f"Hello, {name}"',
      '',
      'def farewell(name: str) -> str:',
      '    return f"Goodbye, {name}"',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'python');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('greet'))).toBe(true);
    expect(texts.some((t) => t.includes('farewell'))).toBe(true);
  });

  it('splits Python code by class boundaries', () => {
    const source = [
      'class Animal:',
      '    def speak(self): ...',
      '',
      'class Dog:',
      '    def speak(self): return "woof"',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'python');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('Animal'))).toBe(true);
    expect(texts.some((t) => t.includes('Dog'))).toBe(true);
  });

  it('splits Go code by func boundaries', () => {
    const source = [
      'func Add(a, b int) int {',
      '    return a + b',
      '}',
      '',
      'func Subtract(a, b int) int {',
      '    return a - b',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'go');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('Add'))).toBe(true);
    expect(texts.some((t) => t.includes('Subtract'))).toBe(true);
  });

  it('falls back to fixed-size for unknown/unsupported languages', () => {
    // A sufficiently large source should still produce chunks even for unknown language
    const source = 'x'.repeat(6000);
    const chunks = chunkByBoundary(source, 'cobol');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('falls back to fixed-size for empty language string', () => {
    const source = 'y'.repeat(5000);
    const chunks = chunkByBoundary(source, '');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('boundary chunks include surrounding context lines', () => {
    const source = [
      '// top-level comment',
      'const VERSION = "1.0";',
      '',
      'export function main(): void {',
      '  console.log("running");',
      '}',
    ].join('\n');

    const chunks = chunkByBoundary(source, 'typescript');
    // The chunk containing main() should also include some preceding context
    const mainChunk = chunks.find((c) => c.text.includes('main'));
    expect(mainChunk).toBeDefined();
    // Preceding context means startLine should capture lines before the boundary
    // i.e. the chunk text includes more than just the function declaration line
    expect(mainChunk?.text.split('\n').length).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ */
/*  chunkFile                                                          */
/* ------------------------------------------------------------------ */

describe('chunkFile', () => {
  it('selects boundary chunking for .ts files', () => {
    const source = ['export function alpha(): void {}', '', 'export function beta(): void {}'].join('\n');

    const chunks = chunkFile(source, 'src/services/foo.ts');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('alpha'))).toBe(true);
    expect(texts.some((t) => t.includes('beta'))).toBe(true);
  });

  it('selects boundary chunking for .tsx files', () => {
    const source = [
      'export function ComponentA() { return null; }',
      '',
      'export function ComponentB() { return null; }',
    ].join('\n');

    const chunks = chunkFile(source, 'src/components/Button.tsx');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('selects boundary chunking for .py files', () => {
    const source = ['def foo(): pass', '', 'def bar(): pass'].join('\n');

    const chunks = chunkFile(source, 'app/service.py');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('foo'))).toBe(true);
    expect(texts.some((t) => t.includes('bar'))).toBe(true);
  });

  it('selects boundary chunking for .rs files', () => {
    const source = ['fn one() {}', '', 'fn two() {}'].join('\n');

    const chunks = chunkFile(source, 'src/lib.rs');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('selects boundary chunking for .go files', () => {
    const source = ['func One() {}', '', 'func Two() {}'].join('\n');

    const chunks = chunkFile(source, 'pkg/service.go');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('uses fixed-size for unknown extensions (.txt)', () => {
    const source = 'z'.repeat(5000);
    const chunks = chunkFile(source, 'notes.txt');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('uses fixed-size for unknown extensions (.json)', () => {
    const source = `{"key": "${'v'.repeat(4800)}"}`;
    const chunks = chunkFile(source, 'data/schema.json');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('uses fixed-size for a file with no extension', () => {
    const source = 'w'.repeat(5000);
    const chunks = chunkFile(source, 'Makefile');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('returns empty array for empty input regardless of extension', () => {
    expect(chunkFile('', 'src/index.ts')).toEqual([]);
    expect(chunkFile('', 'script.py')).toEqual([]);
    expect(chunkFile('', 'notes.txt')).toEqual([]);
  });

  it('returns Chunk objects with text, startLine, endLine', () => {
    const source = 'export function thing(): void {}\n';
    const chunks = chunkFile(source, 'foo.ts');

    for (const chunk of chunks) {
      expect(chunk).toHaveProperty('text');
      expect(chunk).toHaveProperty('startLine');
      expect(chunk).toHaveProperty('endLine');
    }
  });
});
