// sqlite-vec wrapper: extension load + deterministic local embedding +
// vec0 blob serialization.
//
// Per ADR 002 (docs/adr/002-local-first-vector-search.md), kova standardizes on
// sqlite-vec as the single vector backend. This module is the entry point — it
// loads the native extension into a better-sqlite3 instance, provides a
// deterministic embedding function so the pipeline can produce vectors without
// any network call, and exposes the blob serialization vec0 virtual tables
// expect.
//
// Why a deterministic local "embedding"?
// kova has no in-process embedding model and the ADR explicitly rejects remote
// embedding services. SimHash-style hash projection over normalized text
// tokens yields a deterministic, no-network fixed-dim vector that captures
// rough token-set similarity — enough for the qualitative recall described in
// the issue ("manual eyeball OK"). The function is honest about its limits:
// near-duplicates cluster, but it is no substitute for a real embedding model.
//
// SHAPE ASSUMPTION: the bundled sqlite-vec npm package supplies a loadable
// `.dylib` / `.so` / `.dll` matching the SQLite ABI shipped with
// better-sqlite3@12.x. If you bump better-sqlite3 to a new major, re-check
// the sqlite-vec compatibility matrix in this module's README.

import type { Database as DbHandle } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Embedding dimensionality. Chosen modestly small (384) to keep on-disk size
 * manageable while still giving the SimHash projection enough room to
 * distinguish substantively different inputs. All callers MUST use this
 * constant — it is the schema-pinned dim for every vec0 virtual table.
 */
export const EMBED_DIM = 384;

/**
 * Documented pin between the local memory stores and the host SQLite ABI.
 * sqlite-vec loads as a SQLite extension, so a better-sqlite3 major-version
 * bump can break extension load. Today: better-sqlite3 12.x is the only
 * supported major. Change this constant + README when bumping.
 */
export const MEMORY_DB_VERSION = 'better-sqlite3@12.x / sqlite-vec@0.1.x';

/**
 * Load the sqlite-vec extension into the given better-sqlite3 instance.
 * Throws a descriptive error if the native binary cannot be loaded — the ADR
 * rejects an in-memory fallback, so callers must surface this loudly.
 */
export function loadSqliteVec(db: DbHandle): void {
  try {
    sqliteVec.load(db as unknown as Parameters<typeof sqliteVec.load>[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load sqlite-vec extension: ${msg}. This is required for kova's local-first memory store (ADR 002 — no fallback). Pin: ${MEMORY_DB_VERSION}.`,
    );
  }
}

/**
 * Produce a deterministic Float32Array embedding for `text` by SimHash-style
 * projection. The output is L2-normalized so cosine similarity reduces to a
 * dot product on the vec0 side. The same input always yields identical bytes.
 */
export function localEmbed(text: string): Float32Array {
  const out = new Float32Array(EMBED_DIM);
  const normalized = text.toLowerCase();
  // Tokenize — keep it simple: split on non-word characters, drop empties.
  const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length > 0);

  if (tokens.length === 0) {
    // Empty input still produces a valid vector (all zeros + a tiny epsilon
    // on the first dim so the norm is non-zero and the vector is well-defined).
    out[0] = 1;
    return out;
  }

  // For each token, project to a pseudo-random direction in EMBED_DIM space
  // by hashing the token + a per-dim salt, mapping to {-1, +1}. Sum
  // contributions across tokens — this is the classic SimHash construction
  // adapted to dense float output.
  for (const token of tokens) {
    const seedA = fnv1a32(token);
    const seedB = fnv1a32(`${token}::salt`);
    for (let i = 0; i < EMBED_DIM; i++) {
      // Mix the token seed with the dimension index. Use a cheap LCG step so
      // every (token, dim) pair has its own bit independent of the others.
      const bit = mix(seedA, seedB ^ (i * 0x9e3779b1)) & 1;
      out[i] = (out[i] ?? 0) + (bit === 1 ? 1 : -1);
    }
  }

  // L2-normalize.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const v = out[i] ?? 0;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i++) {
      out[i] = (out[i] ?? 0) / norm;
    }
  } else {
    out[0] = 1;
  }
  return out;
}

/**
 * Serialize a Float32Array as the little-endian raw-bytes blob that vec0
 * virtual tables consume.
 */
export function serializeVec(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/* ================================================================== */
/*  Internal hash primitives                                            */
/* ================================================================== */

/**
 * 32-bit FNV-1a hash. Fast, no allocations, stable across platforms.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Multiply by FNV prime modulo 2^32 — use Math.imul for correct 32-bit semantics.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cheap two-input mixer producing a 32-bit output. Used per (token, dim) to
 * derive an independent bit. Not cryptographic — only needs to be sufficient
 * for SimHash decorrelation.
 */
function mix(a: number, b: number): number {
  let x = (a ^ (b + 0x9e3779b9 + (a << 6) + (a >>> 2))) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
