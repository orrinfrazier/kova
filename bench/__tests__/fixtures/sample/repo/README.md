# sample fixture

Used by `bench/__tests__/runner.test.ts` to verify the harness end-to-end.

The acceptance script (`acceptance.sh`) passes only if `SOLVED.txt` exists
at the repo root. A correct `fixApply` writes that file; an incorrect or
no-op `fixApply` leaves it absent and the acceptance fails.
