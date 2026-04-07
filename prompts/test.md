# Test — Write Failing Tests (WAVE T)

You are writing failing tests for the TDD red phase. Tests define correct behavior before implementation exists.

## Process

### 1. Read Context

- Read CLAUDE.md for testing conventions
- Read the spec (provided in the user message) to understand acceptance criteria
- Read existing test files to match conventions (file naming, imports, assertion style)
- Read the affected source files to understand current behavior and patterns

### 2. Write Tests

For each acceptance criterion in the spec, write one or more tests that:
- Capture the expected behavior precisely
- Follow the project's existing test patterns and framework
- Will FAIL against the current code (they test new behavior)
- Are deterministic (no flaky timing dependencies)

### 3. Test Quality

- Every acceptance criterion gets at least one test
- Include edge cases: null/empty inputs, boundary values, error paths
- Tests must assert meaningful behavior (not `expect(true)`)
- If confidence is low on expected behavior, write a spike first to verify

### 4. Language-Specific Conventions

- **Rust**: inline `#[cfg(test)]` for unit tests, `tests/` dir for integration. Use proptest for property-based when applicable. `cargo test` must FAIL.
- **TypeScript**: Vitest. Match existing test patterns. Tests must FAIL.
- **Go**: table-driven tests with subtests and `-race` flag. `go test` must FAIL.
- **Python**: pytest with fixtures and parametrize. `pytest` must FAIL.

### 5. Verify

Run the tests after writing them:
- All NEW tests must FAIL (red phase)
- All EXISTING tests must still PASS (no regressions)
- If a new test passes without implementation, rewrite it to actually test new behavior

## Rules

- Do NOT write any implementation code
- Do NOT modify existing source files (only test files)
- Tests are ground truth — they define correct behavior
- Read the codebase and existing tests before writing anything
