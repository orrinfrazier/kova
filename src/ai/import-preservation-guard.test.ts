import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createImportPreservationGuard } from './import-preservation-guard.js';

// --- Helpers ---

function makeToolCallContext(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    assistantMessage: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc_1', name: toolName, arguments: args }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 }, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'tool_call',
    } as unknown as BeforeToolCallContext['assistantMessage'],
    toolCall: {
      type: 'toolCall',
      id: 'tc_1',
      name: toolName,
      arguments: args,
    } as unknown as BeforeToolCallContext['toolCall'],
    args,
    context: {} as unknown as BeforeToolCallContext['context'],
  };
}

function makeWriteContext(opts: { path: string; content: string }): BeforeToolCallContext {
  return makeToolCallContext('write', opts);
}

function makeEditContext(opts: { path: string; edits: { oldText: string; newText: string }[] }): BeforeToolCallContext {
  return makeToolCallContext('edit', opts);
}

// --- Test sandbox ---

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'kova-import-guard-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// --- Rust ---

describe('import-preservation-guard — Rust (use statements)', () => {
  it('rejects removal of `use serde::{Deserialize, Serialize}` when derives still reference them', async () => {
    const file = join(sandbox, 'model.rs');
    const original = `use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Foo {
    pub name: String,
}
`;
    writeFileSync(file, original);

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `
#[derive(Serialize, Deserialize)]
pub struct Foo {
    pub name: String,
}
`;
    const result = await guard(makeWriteContext({ path: 'model.rs', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Serialize');
  });

  it('allows removal of unused `use` import', async () => {
    const file = join(sandbox, 'model.rs');
    const original = `use serde::Serialize;
use std::collections::HashMap;

pub fn add(a: i32, b: i32) -> i32 { a + b }
`;
    writeFileSync(file, original);

    const guard = createImportPreservationGuard({ cwd: sandbox });
    // Remove both unused imports
    const newContent = `pub fn add(a: i32, b: i32) -> i32 { a + b }
`;
    const result = await guard(makeWriteContext({ path: 'model.rs', content: newContent }));
    expect(result).toBeUndefined();
  });

  it('allows adding a new `use` import', async () => {
    const file = join(sandbox, 'model.rs');
    const original = `pub fn foo() {}
`;
    writeFileSync(file, original);

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `use std::collections::HashMap;

pub fn foo() {
    let _m: HashMap<String, i32> = HashMap::new();
}
`;
    const result = await guard(makeWriteContext({ path: 'model.rs', content: newContent }));
    expect(result).toBeUndefined();
  });

  it('rejects edit that removes a used `use` import', async () => {
    const file = join(sandbox, 'model.rs');
    const original = `use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Foo {}
`;
    writeFileSync(file, original);

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeEditContext({
      path: 'model.rs',
      edits: [{ oldText: 'use serde::{Deserialize, Serialize};\n', newText: '' }],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Serialize');
  });
});

// --- TypeScript ---

describe('import-preservation-guard — TypeScript', () => {
  it('rejects removal of named import still referenced in body', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import { readFile } from 'node:fs/promises';

export async function load(p: string) {
  return await readFile(p, 'utf-8');
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `export async function load(p: string) {
  return await readFile(p, 'utf-8');
}
`;
    const result = await guard(makeWriteContext({ path: 'foo.ts', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('readFile');
  });

  it('allows removal of unused named import', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import { readFile, unused } from 'node:fs/promises';

export async function load(p: string) {
  return readFile(p, 'utf-8');
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `import { readFile } from 'node:fs/promises';

export async function load(p: string) {
  return readFile(p, 'utf-8');
}
`;
    const result = await guard(makeWriteContext({ path: 'foo.ts', content: newContent }));
    expect(result).toBeUndefined();
  });

  it('rejects removal of default import still referenced', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import path from 'node:path';

export function build(p: string) {
  return path.join(p, 'x');
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `export function build(p: string) {
  return path.join(p, 'x');
}
`;
    const result = await guard(makeWriteContext({ path: 'foo.ts', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('path');
  });

  it('rejects removal of namespace import still referenced', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import * as fs from 'node:fs';

export function build(p: string) {
  return fs.readFileSync(p);
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `export function build(p: string) {
  return fs.readFileSync(p);
}
`;
    const result = await guard(makeWriteContext({ path: 'foo.ts', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('fs');
  });

  it('respects renamed import (as) — uses local name for reference check', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import { readFile as read } from 'node:fs/promises';

export async function load(p: string) {
  return read(p, 'utf-8');
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `export async function load(p: string) {
  return read(p, 'utf-8');
}
`;
    const result = await guard(makeWriteContext({ path: 'foo.ts', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('read');
  });
});

// --- Python ---

describe('import-preservation-guard — Python', () => {
  it('rejects removal of `from x import Y` when Y is still used', async () => {
    const file = join(sandbox, 'app.py');
    writeFileSync(
      file,
      `from pathlib import Path

def load(p):
    return Path(p).read_text()
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `def load(p):
    return Path(p).read_text()
`;
    const result = await guard(makeWriteContext({ path: 'app.py', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Path');
  });

  it('rejects removal of `import x` when x.foo is still used', async () => {
    const file = join(sandbox, 'app.py');
    writeFileSync(
      file,
      `import os

def cwd():
    return os.getcwd()
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `def cwd():
    return os.getcwd()
`;
    const result = await guard(makeWriteContext({ path: 'app.py', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('os');
  });

  it('allows removal of unused python import', async () => {
    const file = join(sandbox, 'app.py');
    writeFileSync(
      file,
      `import os
import sys

def hello():
    return "hi"
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `def hello():
    return "hi"
`;
    const result = await guard(makeWriteContext({ path: 'app.py', content: newContent }));
    expect(result).toBeUndefined();
  });
});

// --- Go ---

describe('import-preservation-guard — Go', () => {
  it('rejects removal of `import "fmt"` when fmt is still used', async () => {
    const file = join(sandbox, 'main.go');
    writeFileSync(
      file,
      `package main

import "fmt"

func main() {
    fmt.Println("hi")
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `package main

func main() {
    fmt.Println("hi")
}
`;
    const result = await guard(makeWriteContext({ path: 'main.go', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('fmt');
  });

  it('rejects removal of grouped import still referenced', async () => {
    const file = join(sandbox, 'main.go');
    writeFileSync(
      file,
      `package main

import (
    "fmt"
    "os"
)

func main() {
    fmt.Println(os.Args)
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `package main

import (
    "fmt"
)

func main() {
    fmt.Println(os.Args)
}
`;
    const result = await guard(makeWriteContext({ path: 'main.go', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('os');
  });

  it('allows removal of unused go import', async () => {
    const file = join(sandbox, 'main.go');
    writeFileSync(
      file,
      `package main

import (
    "fmt"
    "os"
)

func main() {
    fmt.Println("hi")
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `package main

import (
    "fmt"
)

func main() {
    fmt.Println("hi")
}
`;
    const result = await guard(makeWriteContext({ path: 'main.go', content: newContent }));
    expect(result).toBeUndefined();
  });
});

// --- bypass and robustness ---

describe('import-preservation-guard — bypass and robustness', () => {
  it('allows when bypass flag is set in args (allowDestructive)', async () => {
    const file = join(sandbox, 'model.rs');
    writeFileSync(
      file,
      `use serde::Serialize;

#[derive(Serialize)]
pub struct Foo {}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({
      path: 'model.rs',
      content: `#[derive(Serialize)]
pub struct Foo {}
`,
    });
    (ctx.args as { allowDestructive?: boolean }).allowDestructive = true;
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('allows when guard is constructed with allowDestructive=true', async () => {
    const file = join(sandbox, 'model.rs');
    writeFileSync(
      file,
      `use serde::Serialize;

#[derive(Serialize)]
pub struct Foo {}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox, allowDestructive: true });
    const ctx = makeWriteContext({
      path: 'model.rs',
      content: `#[derive(Serialize)]
pub struct Foo {}
`,
    });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through write to new (non-existent) file', async () => {
    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({
      path: 'new.ts',
      content: `import { x } from 'y';\nexport const z = x;\n`,
    });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through files with unknown extensions', async () => {
    const file = join(sandbox, 'data.txt');
    writeFileSync(file, 'import this is plain text\nhello\n');

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: 'data.txt', content: 'just text\n' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through bash and other non-edit tools', async () => {
    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeToolCallContext('bash', { command: 'ls' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('does not throw on malformed write args', async () => {
    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({ path: '', content: '' });
    const result = await guard(ctx);
    expect(result).toBeUndefined();
  });

  it('rejection message mentions the file and the import name', async () => {
    const file = join(sandbox, 'critical.ts');
    writeFileSync(
      file,
      `import { foo } from 'bar';
export const x = foo();
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({
      path: 'critical.ts',
      content: `export const x = foo();\n`,
    });
    const result = await guard(ctx);
    expect(result?.reason).toContain('critical.ts');
    expect(result?.reason).toContain('foo');
    expect(result?.reason).toMatch(/preserve|preserving|referenced/i);
  });

  it('edit guard simulates edits before checking imports', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import { readFile } from 'node:fs/promises';

export async function load(p: string) {
  return await readFile(p, 'utf-8');
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeEditContext({
      path: 'foo.ts',
      edits: [{ oldText: `import { readFile } from 'node:fs/promises';\n`, newText: '' }],
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('readFile');
  });

  it('handles type-only imports in TypeScript', async () => {
    const file = join(sandbox, 'foo.ts');
    writeFileSync(
      file,
      `import type { Foo } from './foo.js';

export function take(f: Foo) {
  return f;
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const ctx = makeWriteContext({
      path: 'foo.ts',
      content: `export function take(f: Foo) {
  return f;
}
`,
    });
    const result = await guard(ctx);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Foo');
  });

  it('handles Go aliased import', async () => {
    const file = join(sandbox, 'main.go');
    writeFileSync(
      file,
      `package main

import f "fmt"

func main() {
    f.Println("hi")
}
`,
    );

    const guard = createImportPreservationGuard({ cwd: sandbox });
    const newContent = `package main

func main() {
    f.Println("hi")
}
`;
    const result = await guard(makeWriteContext({ path: 'main.go', content: newContent }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('f');
  });
});
