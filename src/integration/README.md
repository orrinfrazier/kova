# Local-model integration test suite

Integration tests that exercise kova's local-model code path against a real
Ollama instance running `gemma4:26b`. Codifies the six bugs surfaced during
the 2026-04-08 gemma4:26b testing session as regression cases.

Issue: [#251](https://github.com/orrinfrazier/kova/issues/251)

## When the suite runs

The entire suite is **skipped by default**. The gate is purely env-based —
no Ollama probe, no network call — so CI runs remain deterministic and the
top-level `npm run test` passes on machines without Ollama installed.

```bash
# Default (CI): skipped, npm run test passes
npm run test

# Local: run the integration suite against a live Ollama
KOVA_RUN_LOCAL_MODEL_TESTS=1 npm run test:integration:local
# or equivalently:
npm run test:integration:local
```

The npm script `test:integration:local` sets `KOVA_RUN_LOCAL_MODEL_TESTS=1`
inline before invoking vitest, so it is the one-shot local entrypoint.

## Prerequisites

When `KOVA_RUN_LOCAL_MODEL_TESTS=1` is set, the suite expects:

- Ollama running at `KOVA_OLLAMA_URL` (default `http://localhost:11434`)
- `gemma4:26b` (or a `gemma4:*` tag) pulled locally:

  ```bash
  ollama pull gemma4:26b
  ```

## Bugs covered (regression matrix)

| Bug                                    | Issue | Suite section                                  |
|----------------------------------------|-------|------------------------------------------------|
| #1 Provider prefix lost on re-resolve  | #239  | "Ollama model wiring → regression for #239"    |
| #2 Spec merge not persisted            | #240  | covered by `pipeline/fix.ts` unit suite *      |
| #3 No fallback disable                 | #242  | "fallback-disable contract"                    |
| #4 No spec retry on parse failure      | #243  | covered by `pipeline/fix.ts` unit suite *      |
| #5 Ollama models never registered      | #241  | "Ollama model wiring → regression for #241"    |
| #6 Wave timeouts too short             | #244  | covered by `ai/wave-executor.ts` unit suite *  |

\* Bugs #2/#4/#6 are exercised at unit-test level; this integration suite
covers the model-wiring + fallback + extractor halves that need REAL pi-ai
shapes (not mocks) to catch regressions.

## Extraction methods validated

Per `parseStructuredOutputWithMethod` in `src/ai/wave-executor.ts`:

| Method                    | Trigger pattern                       |
|---------------------------|---------------------------------------|
| `json-tag`                | `<json>...</json>`                    |
| `json-tag-repaired`       | `<json>` with trailing-comma / repair |
| `markdown-fence`          | `` ```json ... ``` ``                 |
| `markdown-fence-repaired` | fence with single quotes / repair     |
| `direct-parse`            | bare JSON object                      |
| `direct-parse-repaired`   | bare JSON with brace-balance repair   |

Each method has at least one positive assertion in the suite; the repaired
variants codify the fuzzy-repair fixes from issue #245.

## Documented remaining failure modes

These are the rough edges observed in prior gemma4:26b runs that this suite
**does not** yet attempt to fix — they exist as future work:

- `gemma4:26b` Q4_K_M struggles with deeply nested structured JSON
  (`pieces[*].acceptance_criteria`). Spec wave success was ~50% in prior runs.
- Destructive edit pattern: gemma occasionally deletes unrelated imports /
  enum variants during impl wave. Partially mitigated by
  `src/ai/destructive-edit-guard.ts` but still observed under context pressure.
- Context exhaustion: large Rust workspaces blow past the 32K default
  context window before impl finishes.
- Conversation-repair (issue #246) is not yet implemented; once landed,
  this suite should add coverage for that extraction path.

When these failure modes are addressed, add the corresponding regression
test case to `local-model.integration.test.ts` and update the matrix above.

## Adding a new regression case

1. Reproduce the bug locally against `gemma4:26b` via Ollama.
2. Add an `it()` block under the appropriate `describe` in
   `local-model.integration.test.ts`. Comment which issue number it covers.
3. Update the "Bugs covered" table above.
4. Verify the suite still passes locally:
   `npm run test:integration:local`.
5. Verify the suite still skips cleanly in default mode:
   `npm run test` (no `KOVA_RUN_LOCAL_MODEL_TESTS=1`).
