# kova fix-success benchmark

Opt-in end-to-end benchmark borrowed from aider's `benchmark/` pattern.
Runs the real `fix()` against curated fixture issue+repo pairs in
isolation and scores pass/fail + cost + per-wave timing.

`fix.e2e.test.ts` validates the plumbing with a mocked Agent — that's
useful for catching regressions in the orchestrator but it can't tell
you whether a prompt or model change made real fixes better. This
harness fills that gap.

## Layout

```
bench/
  README.md                this file
  types.ts                 shared types + zod manifest schema
  loader.ts                fixture discovery + manifest validation
  runner.ts                per-fixture run loop (copy seed → fixApply → acceptance)
  scorer.ts                JSONL append + summary aggregation
  fixApply.ts              real-fix wiring (lazy-imported by the CLI)
  index.ts                 CLI entrypoint (`npm run bench`)
  fixtures/
    01-trim-input/
      fixture.json         manifest (id, title, issue, acceptance command, timeout)
      repo/                seed repo (bug state — acceptance fails on this)
    02-add-divide/
    03-fix-off-by-one/
  __tests__/               harness self-tests (vitest, runs as part of `npm test`)
  results/                 JSONL output per run (gitignored by convention)
```

## Running

```bash
# Run all fixtures with real fix() (requires ANTHROPIC_API_KEY)
npm run bench

# Dry run — uses a no-op fixApply, exercises the harness only
npm run bench:dry

# Run a single fixture
npm run bench -- --fixture 01-trim-input

# Keep tmp workdirs after the run (for debugging)
npm run bench -- --keep

# Override fixtures root / output path
npm run bench -- --fixtures /path/to/other/bench --out /tmp/result.jsonl
```

The harness writes one JSON line per fixture to
`bench/results/run-<timestamp>.jsonl` and prints a summary to stdout.

## Default `RepoConfig`

Fixture seed repos do **not** ship a `repos.yaml`. The harness builds a
defaulted in-memory `RepoConfig` via `buildDefaultBenchConfig(workdir)`
(see `bench/fixApply.ts`) — it fills in `rules`, `model`, and
`isolation` defaults from `RepoConfigSchema` without touching the
filesystem. No `~/.kova/repos.yaml` is required.

Because the default config does not configure any local provider, the
real `fix()` path falls back to the Anthropic API. Required env vars:

- **`ANTHROPIC_API_KEY`** — required for `npm run bench` (the real-fix
  path). Not required for `npm run bench:dry` (uses a no-op fixApply).
- **`GH_TOKEN` / `GITHUB_TOKEN`** — NOT required. The harness never
  hits the GitHub API — fixtures are local files.

To pin the bench to a local model provider (e.g. Ollama), pass a
`configOverride` to `createRealFixApply(repoName, override)` from a
custom entrypoint — the default CLI does not currently expose this
flag, see `bench/index.ts`.

## Isolation contract

- Each fixture run mints a fresh temp directory under `os.tmpdir()`
  (or `--tmp-root <dir>` if you want to put it elsewhere).
- The seed `repo/` is **copied** into the temp dir. The seed itself is
  never mutated.
- `fixApply` runs against the temp dir, never against the host kova
  worktree.
- The acceptance command runs inside the temp dir.
- The temp dir is removed at the end of the run unless `--keep` is
  passed.

The harness never invokes git, push, or any GitHub API — fixtures are
local files, not real repos.

## JSONL schema

One line per fixture result. `schemaVersion: 1` is on every record so
later consumers can detect breaking changes.

```json
{
  "schemaVersion": 1,
  "fixtureId": "01-trim-input",
  "passed": true,
  "durationMs": 12345,
  "cost": 0.42,
  "waves": [
    { "name": "assess", "durationMs": 1500, "cost": 0.05 },
    { "name": "impl", "durationMs": 8000, "cost": 0.32 }
  ],
  "acceptanceStdout": "PASS\n",
  "acceptanceStderr": ""
}
```

## Adding a fixture

1. Pick a stable id (`NN-short-slug`).
2. `mkdir bench/fixtures/<id>/repo`.
3. Seed `repo/` with code in the bug state.
4. Add an `acceptance` command (typically `node test.js` for tiny JS
   fixtures) that exits 0 only when the fix is correct.
5. Write `fixture.json` describing the issue (title + body) and the
   acceptance command. Validate the JSON against `FixtureManifestSchema`
   by running the loader self-tests: `vitest run bench/__tests__/loader`.
6. Verify the seed FAILS the acceptance and a hand-written golden fix
   PASSES it before committing.

Keep fixtures small — every additional fixture costs N model calls
per benchmark run. Three is the floor (per the issue's acceptance
criteria); the harness scales to more if you want.
