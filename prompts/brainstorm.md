# Brainstorm — Codebase Analysis & Issue Generation

You are analyzing a codebase to identify improvements and generate a structured suite of GitHub issues.

## Process

### 1. Understand the Project

- Read README.md and package.json/Cargo.toml (whichever exists) for project context
- Identify the language, framework, test setup, and architecture
- Understand the project's conventions and coding style

### 2. Explore the Codebase

**If codegraph MCP tools are available** (`mcp__codegraph__context`, `mcp__codegraph__trace`, `mcp__codegraph__callers`, `mcp__codegraph__callees`, `mcp__codegraph__impact`, `mcp__codegraph__explore`), call them FIRST to map the codebase structure — `mcp__codegraph__explore` for entry-point discovery, `mcp__codegraph__callers`/`mcp__codegraph__callees` for hot-path analysis, `mcp__codegraph__impact` to spot high-fan-out symbols that warrant brainstorm attention. This is ~70% fewer tool calls than re-deriving structure with grep/find.

Fall back to file search and content search when codegraph is unavailable (graceful degradation). Either way, systematically explore:
- Entry points (main, index, CLI)
- Core business logic modules
- API endpoints and handlers
- Database/storage layer
- Test files and coverage gaps
- Configuration and environment handling
- Error handling patterns
- Security-sensitive code (auth, input validation, secrets)

### 3. Identify Improvements

Look for issues across these categories:

**Bugs** — Incorrect behavior, edge cases, race conditions, error handling gaps
**Security** — Injection risks, auth gaps, secrets exposure, missing validation, unsafe dependencies
**Performance** — N+1 queries, unnecessary allocations, missing caching, slow paths
**Tech Debt** — Code duplication, dead code, outdated patterns, missing types, poor abstractions
**Enhancement** — Missing features implied by the codebase, incomplete implementations, UX improvements

### 4. Prioritize

For each issue, assess priority:
- **critical**: Security vulnerabilities, data loss risks, production crashes
- **high**: Bugs affecting users, significant performance issues, blocking tech debt
- **medium**: Code quality improvements, moderate performance gains, useful features
- **low**: Style issues, minor optimizations, nice-to-have features

### 5. Write Issues

For each issue, produce:
- **title**: Clear, actionable title (imperative mood, e.g., "Add input validation to user endpoints")
- **body**: Description with context — what's wrong, where it is, why it matters, suggested approach
- **labels**: Relevant labels (e.g., `bug`, `security`, `performance`, `tech-debt`, `enhancement`)
- **priority**: `critical`, `high`, `medium`, or `low`
- **category**: `bug`, `security`, `performance`, `tech-debt`, or `enhancement`
- **dependencies** (optional): Titles of other issues that should be fixed first

### 6. Report Coverage

You MUST also populate the top-level `coverage` array on the result. This is the
scope ledger — the user gates issue creation on it, so missing entries are
visible signals that the pass was incomplete.

For each top-level source subdirectory (e.g. `src/ai`, `src/cli`, `src/pipeline`,
`src/services`, `src/utils`, `src/types`, or the language equivalent: `crates/*`
for Rust workspaces, `packages/*` for pnpm monorepos, the package root for
single-package projects), add one entry to `coverage`:

```
{ "unit": "src/ai", "status": "covered" }
{ "unit": "src/utils", "status": "skipped", "reason": "no findings — logging helpers only" }
```

Rules:
- Every top-level unit MUST appear exactly once.
- `status: "covered"` means you read enough of that unit to form a judgment about
  whether issues exist there (whether or not you ended up filing any).
- `status: "skipped"` means you did NOT examine that unit; provide a one-line
  `reason` (e.g. focus area mismatch, generated code, vendored deps).
- Do not invent units that don't exist. List what you actually saw on disk.

## Focus Areas

If the user message specifies focus areas, you MUST only generate issues within those areas. Ignore all other categories entirely. For example, if focus areas are "security, performance", only produce issues categorized as `security` or `performance`.

If no focus areas are specified, generate issues across all categories.

## Cross-Repo Awareness

If the user message includes a list of issues from related repos, you MUST avoid suggesting duplicates. An issue is a duplicate if it targets the same underlying problem, even if the wording differs. When in doubt, err on the side of skipping — it is better to miss one issue than to create a cross-repo duplicate.

## Rules

- Read the actual code before identifying issues — do not guess
- Be specific: reference file paths, function names, line numbers where possible
- Each issue should be independently actionable (Grade A-B scope)
- Do not suggest issues that are already tracked in existing GitHub issues or in related repos
- Focus on substantive improvements, not style nitpicks
- Aim for 5-15 issues per analysis (fewer if focus areas narrow the scope)
- Order by priority (critical first, low last)
- Output your analysis as structured JSON matching the provided schema

## Project Conventions

{{CLAUDE_MD}}
