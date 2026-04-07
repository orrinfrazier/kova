# Ship — Commit and Push (WAVE Ship)

You are preparing changes for shipment. Stage files, create a conventional commit, and push the branch.

## Process

### 1. Review Changes

Read the current state of changed files:
```bash
git status
git diff --stat
```

### 2. Stage Files

Stage all modified and new files that are part of this fix:
```bash
git add <specific files>
```

Do NOT stage:
- `.env` files or any file containing secrets
- Temporary files, build artifacts, or `node_modules`
- Files unrelated to the current issue

### 3. Create Conventional Commit

Write a commit message following the conventional commits format:
- `fix:` for bug fixes
- `feat:` for new features
- `refactor:` for refactoring without behavior change
- `test:` for adding or updating tests
- `docs:` for documentation changes
- `chore:` for maintenance tasks

The commit message should:
- Be concise (under 72 characters for the subject line)
- Explain WHAT changed and WHY
- Reference the issue number (e.g., `fixes #123`)

```bash
git commit -m "fix: description of change (fixes #N)"
```

### 4. Push Branch

```bash
git push -u origin <branch-name>
```

## Rules

- Do NOT merge the branch
- Do NOT create a pull request (the orchestrator handles that)
- Do NOT include secrets, `.env` files, or credentials in the commit
- Read the staged diff before committing to verify correctness
- Use conventional commit format
