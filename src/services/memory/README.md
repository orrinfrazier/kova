# `src/services/memory/` — local-first memory stores

Per [ADR 002](../../../docs/adr/002-local-first-vector-search.md) and issue
#433, kova standardizes on **sqlite-vec** as the single vector backend. All
episodic memory, distilled playbooks, and review-feedback recall now live in
the local `better-sqlite3` instance — no remote embedding endpoint is
required.

## Stores

| Store                 | DB file                                | Purpose                                                |
| --------------------- | -------------------------------------- | ------------------------------------------------------ |
| `EpisodeStore`        | `{workDir}/.kova/episodes-vec.db`      | Past-issue learnings, queried similarity in the spec wave |
| `PatternStore`        | `{workDir}/.kova/patterns.db`          | (diagnosis × module) failure frequency, queried in assess |
| `ReviewFeedbackStore` | `{workDir}/.kova/review-feedback-vec.db` | Past PR-review comments, queried before review wave    |
| `PlaybookStore`       | `{workDir}/.kova/playbooks-vec.db`     | Distilled procedural playbooks, queried before spec wave |

The non-vector `PatternStore` and the FTS5 `EpisodeFTSStore` continue to live
under `src/services/`; #433 only migrated the embedding paths.

## ABI pin

sqlite-vec is loaded as a SQLite extension into the `better-sqlite3` instance.
The bundled SQLite ABI must match what sqlite-vec was built against. The
current pin is:

- **`better-sqlite3@12.x`** (bundled SQLite ≥ 3.46)
- **`sqlite-vec@0.1.x`** (built against SQLite ≥ 3.41)

`MEMORY_DB_VERSION` in [`sqlite-vec.ts`](./sqlite-vec.ts) is the single source
of truth. If you bump `better-sqlite3` to a new major:

1. Re-check the sqlite-vec compatibility matrix.
2. Run `npm test src/services/memory/` against the new version.
3. Update `MEMORY_DB_VERSION` to reflect the new pin.

If the extension fails to load, `loadSqliteVec(db)` throws a descriptive
error. There is **no in-memory JavaScript fallback** — ADR 002 explicitly
rejects it.

## Embedding model

kova has no in-process embedding model and ADR 002 rejects remote embedding
services. The store ships its own deterministic embedding: a SimHash-style
hash projection of normalized text tokens into a fixed-dim Float32 vector
(`localEmbed`). This is:

- **Deterministic** — same input → same bytes, across machines.
- **No network** — runs entirely in-process.
- **Cheap** — sub-millisecond per call.
- **Honest about its limits** — captures token-set similarity, not semantic
  meaning. Near-duplicates cluster well; paraphrases do not. Per the issue:
  "manual eyeball OK at this stage."

If a later issue wires a real embedding model, swap `localEmbed` here — every
store calls into that single function.

## Migration from the FTS sidecar

On first construction, `EpisodeStore` looks for the legacy
`{workDir}/.kova/episode-fts.db` (the FTS5 episode index from #302). If
present, every row is copied into the new sqlite-vec store. The migration is
idempotent — re-running it skips already-present `(repo, issue_number)`
pairs via the UNIQUE constraint.

## Public surface

The user-facing functions in `episode-rest.ts`, `playbook-rest.ts`, and
`review-feedback-rest.ts` keep their original names and signatures (with a
new optional `workDir` parameter) so call sites upstream did not need a
mechanical rename. The `*-rest.ts` filenames are retained for the duration
of #433 → #434; #434's mass rename of `src/services/` will fold these files
in.
