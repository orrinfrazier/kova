import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SecretFinding, scanForSecrets } from './secrets-scan.js';

describe('scanForSecrets', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `kova-secrets-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns clean result when no secrets found', async () => {
    await writeFile(join(workDir, 'clean.ts'), 'export const x = 42;\n');

    const result = await scanForSecrets(workDir, ['clean.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('detects GitHub PAT (ghp_)', async () => {
    await writeFile(join(workDir, 'config.ts'), 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n');

    const result = await scanForSecrets(workDir, ['config.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'config.ts',
      line: 1,
      type: 'GitHub PAT',
    });
  });

  it('detects Anthropic API key (sk-ant-)', async () => {
    await writeFile(join(workDir, 'env.ts'), 'const key = "sk-ant-api03-abcdefghijklmnopqrst";\n');

    const result = await scanForSecrets(workDir, ['env.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'env.ts',
      type: 'Anthropic API key',
    });
  });

  it('detects AWS access key (AKIA)', async () => {
    await writeFile(join(workDir, 'aws.ts'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const result = await scanForSecrets(workDir, ['aws.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'aws.ts',
      type: 'AWS access key',
    });
  });

  it('detects private keys', async () => {
    await writeFile(
      join(workDir, 'key.pem'),
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCA...\n-----END RSA PRIVATE KEY-----\n',
    );

    const result = await scanForSecrets(workDir, ['key.pem']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'key.pem',
      type: 'Private key',
    });
  });

  it('detects OpenAI API key (sk-)', async () => {
    await writeFile(join(workDir, 'openai.ts'), 'const key = "sk-proj-abcdefghijklmnopqrstuvwx";\n');

    const result = await scanForSecrets(workDir, ['openai.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'openai.ts',
      type: 'OpenAI API key',
    });
  });

  it('detects multiple secrets across files', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n');
    await writeFile(join(workDir, 'b.ts'), 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n');

    const result = await scanForSecrets(workDir, ['a.ts', 'b.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(2);

    const files = result.findings.map((f: SecretFinding) => f.file);
    expect(files).toContain('a.ts');
    expect(files).toContain('b.ts');
  });

  it('detects multiple secrets in same file', async () => {
    await writeFile(
      join(workDir, 'multi.ts'),
      [
        'const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";',
        'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
        '',
      ].join('\n'),
    );

    const result = await scanForSecrets(workDir, ['multi.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.line).toBe(1);
    expect(result.findings[1]?.line).toBe(2);
  });

  it('reports correct line numbers', async () => {
    await writeFile(
      join(workDir, 'lines.ts'),
      ['import { foo } from "bar";', '', '// some comment', 'const key = "AKIAIOSFODNN7EXAMPLE";', ''].join('\n'),
    );

    const result = await scanForSecrets(workDir, ['lines.ts']);

    expect(result.findings[0]?.line).toBe(4);
  });

  it('scans only specified files, not all files in workDir', async () => {
    await writeFile(join(workDir, 'secret.ts'), 'const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n');
    await writeFile(join(workDir, 'clean.ts'), 'export const x = 1;\n');

    const result = await scanForSecrets(workDir, ['clean.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('handles files in subdirectories', async () => {
    await mkdir(join(workDir, 'src', 'config'), { recursive: true });
    await writeFile(join(workDir, 'src', 'config', 'auth.ts'), 'const key = "sk-ant-api03-abcdefghijklmnopqrst";\n');

    const result = await scanForSecrets(workDir, ['src/config/auth.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings[0]).toMatchObject({
      file: 'src/config/auth.ts',
      type: 'Anthropic API key',
    });
  });

  it('ignores test pattern references (regex literals, comments)', async () => {
    await writeFile(
      join(workDir, 'scan.ts'),
      [
        '// Detects patterns like ghp_[A-Za-z0-9]{36}',
        'const pattern = /ghp_[A-Za-z0-9]{36}/;',
        'const name = "AKIA_PATTERN";',
        '',
      ].join('\n'),
    );

    const result = await scanForSecrets(workDir, ['scan.ts']);

    // Regex patterns and short non-matching strings should not trigger
    expect(result.clean).toBe(true);
  });

  it('returns empty findings for empty file list', async () => {
    const result = await scanForSecrets(workDir, []);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('skips files that do not exist', async () => {
    const result = await scanForSecrets(workDir, ['nonexistent.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('provides a formatted report string', async () => {
    await writeFile(join(workDir, 'leak.ts'), 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n');

    const result = await scanForSecrets(workDir, ['leak.ts']);

    expect(result.report).toContain('leak.ts:1');
    expect(result.report).toContain('GitHub PAT');
  });

  // --- Issue #285: widen patterns to match quality.md Gate 6 ---

  it('detects password literal assignment (single quotes)', async () => {
    await writeFile(join(workDir, 'pw.ts'), "const config = { password: 'hunter2pass' };\n");

    const result = await scanForSecrets(workDir, ['pw.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'pw.ts',
      type: 'Password literal',
    });
  });

  it('detects password literal assignment (double quotes)', async () => {
    await writeFile(join(workDir, 'pw.ts'), 'const password = "hunter2pass";\n');

    const result = await scanForSecrets(workDir, ['pw.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('Password literal');
  });

  it('detects password literal with surrounding whitespace', async () => {
    await writeFile(join(workDir, 'pw.ts'), 'password   =   "longenoughpassword"\n');

    const result = await scanForSecrets(workDir, ['pw.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings[0]?.type).toBe('Password literal');
  });

  it('does NOT flag short password literals (under 8 chars)', async () => {
    await writeFile(join(workDir, 'pw.ts'), 'const password = "short";\n');

    const result = await scanForSecrets(workDir, ['pw.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('does NOT flag password assignment to a variable reference', async () => {
    await writeFile(join(workDir, 'pw.ts'), 'const password = process.env.PW;\n');

    const result = await scanForSecrets(workDir, ['pw.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('detects legacy OpenAI sk- key (48+ chars)', async () => {
    // 48 alphanumeric chars after sk-
    await writeFile(
      join(workDir, 'openai.ts'),
      'const key = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMn";\n',
    );

    const result = await scanForSecrets(workDir, ['openai.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('OpenAI legacy key');
  });

  it('does NOT double-report sk-ant- keys as legacy OpenAI', async () => {
    // sk-ant-... key with 48+ chars after sk-ant-
    await writeFile(
      join(workDir, 'env.ts'),
      'const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl";\n',
    );

    const result = await scanForSecrets(workDir, ['env.ts']);

    expect(result.clean).toBe(false);
    // Should be ONLY 1 finding (Anthropic), not 2 (Anthropic + legacy OpenAI)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('Anthropic API key');
  });

  it('does NOT double-report sk-proj- keys as legacy OpenAI', async () => {
    await writeFile(
      join(workDir, 'openai.ts'),
      'const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp";\n',
    );

    const result = await scanForSecrets(workDir, ['openai.ts']);

    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('OpenAI API key');
  });

  it('does NOT flag short sk- prefixes (under 48 chars)', async () => {
    await writeFile(join(workDir, 'short.ts'), 'const key = "sk-abc123";\n');

    const result = await scanForSecrets(workDir, ['short.ts']);

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('does NOT flag regex literals that define the new patterns', async () => {
    await writeFile(
      join(workDir, 'scan.ts'),
      [
        '// Detects sk-[a-zA-Z0-9]{48,} as legacy OpenAI keys',
        'const openaiLegacy = /sk-[a-zA-Z0-9]{48,}/;',
        '// Password assignment regex: password = "[^"]{8,}"',
        'const pwPattern = /password\\s*=\\s*["\'][^"\']{8,}/;',
        '',
      ].join('\n'),
    );

    const result = await scanForSecrets(workDir, ['scan.ts']);

    expect(result.clean).toBe(true);
  });
});
