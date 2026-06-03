// Tests for the sqlite-vec wrapper: extension load, deterministic local
// embedding, vector serialization, and ABI version constant.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, loadSqliteVec, localEmbed, MEMORY_DB_VERSION, serializeVec } from './sqlite-vec.js';

describe('sqlite-vec wrapper', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kova-sqlite-vec-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  describe('loadSqliteVec', () => {
    it('loads the sqlite-vec extension into a better-sqlite3 instance', () => {
      const db = new Database(join(tmp, 't.db'));
      try {
        loadSqliteVec(db);
        const row = db.prepare('SELECT vec_version() as v').get() as { v: string };
        expect(row.v).toMatch(/^v\d+\.\d+/);
      } finally {
        db.close();
      }
    });

    it('allows creating a vec0 virtual table after load', () => {
      const db = new Database(join(tmp, 't.db'));
      try {
        loadSqliteVec(db);
        db.exec(`CREATE VIRTUAL TABLE t USING vec0(embedding float[${EMBED_DIM}])`);
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t'`).all();
        expect(tables.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });

  describe('localEmbed', () => {
    it('produces a Float32Array of the configured EMBED_DIM length', () => {
      const v = localEmbed('hello world');
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(EMBED_DIM);
    });

    it('is deterministic — same input yields identical vectors', () => {
      const a = localEmbed('the quick brown fox');
      const b = localEmbed('the quick brown fox');
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('produces approximately unit-length vectors', () => {
      const v = localEmbed('a meaningful sentence about typescript');
      let norm = 0;
      for (let i = 0; i < v.length; i++) {
        const val = v[i] ?? 0;
        norm += val * val;
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeGreaterThan(0.99);
      expect(norm).toBeLessThan(1.01);
    });

    it('produces different vectors for substantively different inputs', () => {
      const a = localEmbed('database connection pooling');
      const b = localEmbed('react component state management');
      let dot = 0;
      for (let i = 0; i < a.length; i++) {
        dot += (a[i] ?? 0) * (b[i] ?? 0);
      }
      // Should not be near-identical (cos sim < 0.9 — basic non-collision check)
      expect(Math.abs(dot)).toBeLessThan(0.9);
    });

    it('handles empty input without throwing', () => {
      const v = localEmbed('');
      expect(v.length).toBe(EMBED_DIM);
    });
  });

  describe('serializeVec', () => {
    it('produces a Buffer of EMBED_DIM * 4 bytes (float32)', () => {
      const v = localEmbed('foo');
      const buf = serializeVec(v);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(EMBED_DIM * 4);
    });

    it('round-trips through vec0 — insert then nearest-neighbor returns same row', () => {
      const db = new Database(join(tmp, 't.db'));
      try {
        loadSqliteVec(db);
        db.exec(`CREATE VIRTUAL TABLE items USING vec0(embedding float[${EMBED_DIM}])`);

        const v1 = localEmbed('cats and dogs');
        const v2 = localEmbed('react hooks state');

        db.prepare('INSERT INTO items (rowid, embedding) VALUES (?, ?)').run(BigInt(1), serializeVec(v1));
        db.prepare('INSERT INTO items (rowid, embedding) VALUES (?, ?)').run(BigInt(2), serializeVec(v2));

        // Query with v1 — rowid 1 should be the nearest.
        const rows = db
          .prepare<[Buffer], { rowid: number; distance: number }>(
            'SELECT rowid, distance FROM items WHERE embedding MATCH ? AND k = 2 ORDER BY distance',
          )
          .all(serializeVec(v1));

        expect(Number(rows[0]?.rowid)).toBe(1);
        expect(rows[0]?.distance).toBeLessThan(rows[1]?.distance ?? Number.POSITIVE_INFINITY);
      } finally {
        db.close();
      }
    });
  });

  describe('MEMORY_DB_VERSION', () => {
    it('is a non-empty string pinning the better-sqlite3 major version', () => {
      expect(typeof MEMORY_DB_VERSION).toBe('string');
      expect(MEMORY_DB_VERSION.length).toBeGreaterThan(0);
      // Documented in README; must mention better-sqlite3 major.
      expect(MEMORY_DB_VERSION).toMatch(/12/);
    });
  });
});
