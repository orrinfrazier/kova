import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = new URL('.', import.meta.url).pathname;

describe('001_pgvector_schema.sql', () => {
  it('exists and is readable', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('enables the vector extension', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+["']?vector["']?/i);
  });

  it('creates the code_embeddings table', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?code_embeddings/i);
  });

  it('code_embeddings has file_path TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/file_path\s+TEXT/i);
  });

  it('code_embeddings has chunk_text TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/chunk_text\s+TEXT/i);
  });

  it('code_embeddings has embedding vector(1536) column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/embedding\s+vector\s*\(\s*1536\s*\)/i);
  });

  it('code_embeddings has repo TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    // repo TEXT appears in code_embeddings block
    expect(sql).toMatch(/repo\s+TEXT/i);
  });

  it('code_embeddings has updated_at TIMESTAMPTZ column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/updated_at\s+TIMESTAMPTZ/i);
  });

  it('code_embeddings has a unique constraint on (repo, file_path, chunk_text)', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/UNIQUE\s*\(\s*repo\s*,\s*file_path\s*,\s*chunk_text\s*\)/i);
  });

  it('creates the episodes table', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?episodes/i);
  });

  it('episodes has issue_number INT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/issue_number\s+INT/i);
  });

  it('episodes has approach TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/approach\s+TEXT/i);
  });

  it('episodes has outcome TEXT with CHECK constraint for success/fail', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/outcome\s+TEXT/i);
    expect(sql).toMatch(/CHECK\s*\(.*outcome.*IN\s*\(\s*'success'\s*,\s*'fail'\s*\)/i);
  });

  it('episodes has files_changed TEXT[] column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/files_changed\s+TEXT\s*\[\s*\]/i);
  });

  it('episodes has embedding vector(1536) column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    // There should be multiple vector(1536) columns across all tables
    const matches = sql.match(/vector\s*\(\s*1536\s*\)/gi);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('episodes has created_at TIMESTAMPTZ column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/created_at\s+TIMESTAMPTZ/i);
  });

  it('creates the patterns table', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?patterns/i);
  });

  it('patterns has pattern_description TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/pattern_description\s+TEXT/i);
  });

  it('patterns has frequency INT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/frequency\s+INT/i);
  });

  it('patterns has success_rate REAL column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/success_rate\s+REAL/i);
  });

  it('all three tables have a primary key', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    const primaryKeyMatches = sql.match(/PRIMARY\s+KEY/gi);
    expect(primaryKeyMatches).not.toBeNull();
    // One per table = at least 3
    expect(primaryKeyMatches?.length).toBeGreaterThanOrEqual(3);
  });

  it('episodes has issue_title TEXT column', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/issue_title\s+TEXT/i);
  });

  it('patterns has a unique constraint on (repo, pattern_description)', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    expect(sql).toMatch(/UNIQUE\s*\(\s*repo\s*,\s*pattern_description\s*\)/i);
  });

  it('all three tables have an index on repo', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '001_pgvector_schema.sql'), 'utf-8');
    const indexOnRepoMatches = sql.match(/CREATE\s+INDEX\s+.*ON\s+\w+\s*\(\s*repo\s*\)/gi);
    expect(indexOnRepoMatches).not.toBeNull();
    expect(indexOnRepoMatches?.length).toBeGreaterThanOrEqual(3);
  });
});
