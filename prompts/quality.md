# Quality — Quality Gates (WAVE Q)

You are running all quality gates on the codebase. Auto-fix mechanical issues where possible. Return a concise summary.

## Gate Execution

Run each gate sequentially. If a gate fails:
1. Read the error output
2. If the error is a missing dependency: install it, retry (max 1 retry for install)
3. If the error is a code issue (lint error, type error): fix the code directly, retry
4. Max 2 retry attempts per gate total
5. If still failing, record the failure and continue to next gate

### Gate 1: Lint

Detect the project linter from config files and run it:
- TypeScript/JavaScript: `npm run lint` if script exists, else `npx eslint . --max-warnings 0`
- Rust: `cargo clippy --all-targets --all-features -- -D warnings`
- Go: `golangci-lint run ./...`
- Python: `ruff check .`

### Gate 2: Typecheck

- TypeScript: `npm run check` if script exists, else `npx tsc --noEmit`
- Rust: `cargo check --all-targets`
- Go: `go vet ./...`
- Python: `mypy --strict` (if mypy config exists)

### Gate 3: Tests

Run the full test suite:
- TypeScript: `npm test` or `npx vitest run`
- Rust: `cargo test`
- Go: `go test -race ./...`
- Python: `pytest`

### Gate 4: Coverage

Check against the configured threshold:
- TypeScript: `npm run test:coverage` or `npx vitest run --coverage`
- Rust: `cargo llvm-cov --summary-only` (fallback: `cargo tarpaulin --summary-only`)
- Go: `go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out`
- Python: `pytest --cov --cov-fail-under=$THRESHOLD`

### Gate 5: Security Audit

- TypeScript: `npm audit --audit-level=high`
- Rust: `cargo audit`
- Go: `govulncheck ./...`
- Python: `pip-audit`

### Gate 6: Secrets Scan

Grep changed files for dangerous patterns:
```
ghp_[a-zA-Z0-9]{36}
AKIA[0-9A-Z]{16}
-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----
sk-ant-[a-zA-Z0-9_-]{48,}
sk-[a-zA-Z0-9]{48,}
password\s*=\s*["'][^"']{8,}
```

### Post-Fix Revalidation

If auto-fixes were applied in any gate, re-run Gate 3 (Tests) to ensure fixes didn't break anything.

## Output

After running all gates, emit a **structured JSON** remediation plan. Do NOT include raw lint output, raw test output, or raw coverage reports — only the structured summary.

Wrap the JSON in `<json>...</json>` tags. The schema:

```json
{
  "gates": [
    {
      "gate": "lint | typecheck | tests | coverage | audit | secrets",
      "status": "passed | failed | skipped",
      "auto_fixable": true/false,
      "fix_applied": true/false,
      "remaining_errors": ["error description if failed, empty if passed"],
      "suggested_action": "none | retry_impl | manual_intervention | accept_known_issue"
    }
  ],
  "all_passing": true/false,
  "coverage_percent": 85,
  "auto_fixes_applied": ["description of each auto-fix applied"],
  "files_modified": ["paths of files modified by auto-fixes"]
}
```

Rules for `suggested_action`:
- `none` — gate passed or was skipped
- `retry_impl` — test failures or type errors likely caused by implementation bugs
- `manual_intervention` — security audit findings, secrets detected, or issues beyond auto-fix
- `accept_known_issue` — pre-existing issues unrelated to current changes

## Rules

- Fix issues inline when possible — do not just report them
- Re-run tests after any auto-fix to catch regressions
- Report concisely — raw output stays in the terminal, not in the summary

## Project Conventions

{{CLAUDE_MD}}

## Style Configuration

{{STYLE_CONFIG}}

## CI Configuration

{{CI_CONFIG}}
