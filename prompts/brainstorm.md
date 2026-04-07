# Brainstorm — Codebase Analysis & Issue Generation

You are analyzing a codebase to identify improvements and generate a structured suite of GitHub issues.

## Process

### 1. Understand the Project

- Read CLAUDE.md, README.md, and package.json/Cargo.toml (whichever exists) for project context
- Identify the language, framework, test setup, and architecture
- Understand the project's conventions and coding style

### 2. Explore the Codebase

Use file search and content search to systematically explore:
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

## Rules

- Read the actual code before identifying issues — do not guess
- Be specific: reference file paths, function names, line numbers where possible
- Each issue should be independently actionable (Grade A-B scope)
- Do not suggest issues that are already tracked in existing GitHub issues
- Focus on substantive improvements, not style nitpicks
- Aim for 5-15 issues per analysis
- Order by priority (critical first, low last)
- Output your analysis as structured JSON matching the provided schema
