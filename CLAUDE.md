# CLAUDE.md

Autonomous code agent. Fixes GitHub issues via pipeline: Assess → Spec → Test → Impl → Quality → Review → Ship.

## Commands

```bash
npm run check          # Type check (tsc --noEmit)
npm run lint           # Biome lint
npm run lint:fix       # Biome auto-fix
npm run test           # Vitest
npm run build          # Compile TypeScript
```

## Architecture

- **Runtime:** Claude Agent SDK `query()` — one call per pipeline wave
- **CLI:** Commander.js — `kova fix <issue>`, `kova fix --all`
- **State:** File-based JSON checkpoints in `.kova/state.json` per worktree
- **Isolation:** Git worktrees for each fix
- **GitHub:** `gh` CLI for issues and PRs
- **Config:** `repos.yaml` with Zod validation

## Key patterns

- Waves are strictly sequential (no parallel waves)
- Quality gates run INSIDE the agent (self-healing, not session-killing)
- Each wave writes artifacts to the worktree filesystem
- Structured output via Zod → JSON Schema draft-07
- Error classification: retryable (billing, rate limit) vs non-retryable (auth, config)
- Prompts: `prompts/{wave}.md` with fallback to embedded defaults

## Code style

- TypeScript strict mode, ESM, Node 20+
- Biome for lint/format (single quotes, semicolons, trailing commas)
- `zx` for shell commands, `zod` for schemas
- No `any` — use `unknown` with type guards
- Explicit return types on exports
