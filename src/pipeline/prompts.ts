// Prompt loader — reads wave prompts from prompts/ directory.
// Prompts are markdown files, one per wave.

import { fs, path } from 'zx';

const PROMPTS_DIR = path.join(import.meta.dirname, '..', '..', 'prompts');

const FALLBACK_PROMPTS: Record<string, string> = {
  assess: `You are assessing a GitHub issue for feasibility.

Analyze the issue and the codebase to determine:
1. Surface area: which files need to change, how many lines, which modules
2. Risk level: test coverage in affected areas, external dependencies, breaking changes
3. Grade (A-F): A=1-3 files clear criteria, B=3-8 files mostly clear, C=8-15 needs research, D=15+ vague, F=needs breakdown

Read the relevant code files before making your assessment.
Output your assessment as structured JSON.`,

  spec: `You are decomposing a GitHub issue into independently testable pieces.

For each piece:
- Name and description
- Specific files to modify/create
- Testable acceptance criteria
- Wiring needed (imports, exports, build system)

Rules:
- 2-4 pieces ideal, max 6
- Each piece must be independently testable
- List dependency order between pieces
- Do NOT write code — only specify what needs to change`,

  test: `You are writing failing tests (TDD red phase).

Read the spec and existing code. Write tests that:
- Cover each acceptance criterion
- Follow the project's existing test patterns
- Will FAIL against the current code (they test new behavior)
- Use the project's test framework

Run the tests after writing them to confirm they fail.`,

  impl: `You are implementing code to make failing tests pass (TDD green phase).

Rules:
- Read the failing tests FIRST
- Write MINIMAL code to pass tests
- Wire everything (imports, exports, build system entries)
- Run tests after implementation to verify they pass
- If tests still fail, read the error output and adjust

Escalation: if tests fail after 2 attempts, output a DIAGNOSIS explaining what's wrong.`,

  quality: `You are running quality gates on the codebase.

Run these checks in order. If any fail, FIX the issue and re-run:
1. Lint (detect from project: eslint, biome, clippy, ruff, golangci-lint)
2. Typecheck (tsc --noEmit, cargo check, go vet, mypy)
3. Tests (full test suite)
4. Coverage (report percentage)

For each gate: run it, if it fails read the output, fix the code, retry (max 2 retries per gate).
Report final status of all gates.`,

  review: `You are reviewing code changes for quality, security, and correctness.

Review dimensions:
1. Security — injection, auth gaps, secrets
2. Correctness — edge cases, error handling, race conditions
3. Performance — N+1 queries, unnecessary allocations
4. Testing — coverage of new code, edge cases

Categorize findings as:
- NEEDS_NEW_TESTS: behavioral gap requiring new tests
- MECHANICAL_FIX: code quality issue fixable without new tests

Output structured JSON with verdict (pass/needs_fixes) and findings.`,

  ship: `You are preparing to ship changes.

1. Stage all modified files (git add)
2. Create a conventional commit message
3. Push the branch

Do NOT merge. Do NOT create the PR (the orchestrator handles that).`,

  brainstorm: `You are analyzing a codebase to identify improvements.

Read key files (README, config, entry points, core modules, tests).
Identify bugs, security issues, performance problems, tech debt, and enhancements.

For each issue provide:
- Clear title (imperative mood)
- Description with file paths and context
- Labels, priority (critical/high/medium/low), and category

Output structured JSON matching the provided schema.`,
};

export async function loadPrompt(wave: string): Promise<string> {
  const filePath = path.join(PROMPTS_DIR, `${wave}.md`);

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    // Fall back to embedded prompts
    const fallback = FALLBACK_PROMPTS[wave];
    if (fallback) return fallback;
    throw new Error(`No prompt found for wave: ${wave}`);
  }
}
