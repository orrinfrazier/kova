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

- **Runtime:** Pluggable `AgentRuntimeFactory` (issues #309/#318/#407). Default is the pi-mono `Agent` (`defaultAgentRuntimeFactory`). The `claude -p` CLI subprocess runtime (`claudeCliRuntimeFactory`) is opt-in via `kova ... --runtime claude-cli` or `repos.yaml runtime: claude-cli`. One factory call per pipeline wave; selection is per-fix and consistent across S/T/I/Q/R.
- **CLI:** Commander.js — `kova fix <issue>`, `kova fix --all`
- **State:** File-based JSON checkpoints in `.kova/state.json` per worktree
- **Isolation:** Git worktrees (default for private repos) or Docker sandbox (default for public/OSS repos — every wave runs via `docker exec` in a `/workspace`-mounted container, see `src/sandbox/dispatch.ts`)
- **GitHub:** `gh` CLI for issues and PRs
- **Config:** `repos.yaml` with Zod validation

## Runtime selection (#407)

- Flag: `kova fix|auto|brainstorm|supervised --runtime <pi|claude-cli>`
- Field: `repos.yaml runtime: 'pi' | 'claude-cli'` (defaults to `'pi'`)
- Precedence: CLI flag > per-repo `runtime:` > `'pi'`
- **In-process `AgentTool[]` implementations are pi-mono-only.** Any custom `tools[]` passed to `spawnWaveAgent` (or registered via `getWaveTools`) executes only on the pi-mono runtime. The `claude-cli` subprocess sees only its built-in allowlist + the MCP server map kova forwards via `--mcp-config`. If you depend on a custom in-process tool, stay on `runtime: pi` or surface that tool via MCP. See `src/ai/runtime/claude-cli-runtime.ts` (top-of-file note) and `src/ai/runtime/resolver.ts` for the seam.

## Consensus pool routing (#261)

- Flags on `kova fix`: `--consensus [--pool <spec>] [--consensus-waves <waves>]`
- `--pool` defaults to `'diverse'` (anthropic+openai+google); accepts `'diverse'` or a comma-separated `provider:model` list (2-5 members per `WaveConsensusConfigSchema`). Tier strings (`small|medium|large`) are also accepted as pool members.
- `--consensus-waves` defaults to `assess,spec,review`; accepts any subset of `assess|spec|test|impl|quality|review`.
- Effect: the named waves dispatch through `spawnConsensusWave` (3-way reviewer pool + adjudicator) instead of `dispatchSpawnWave` / `dispatchExecuteWave`. The adjudicator stays at the schema default (`'large'`, typically opus). Cost is ~Nx on the chosen waves where N = pool size.
- Plumbing seam: `src/pipeline/consensus-flags.ts` (parsers + applier), `src/cli/index.ts` (flag declarations), `src/pipeline/fix.ts` (`FixOptions.consensusPool` + `FixOptions.consensusWaves` defense-in-depth), `src/pipeline/engines/{assess,spec}.ts` + `src/pipeline/loops.ts:dispatchReviewWave` (the `isConsensusPool` dispatch branch).
- Telemetry: `WaveResult.consensus` (#262) carries pool ids, adjudicator id, agreement classification, rejected count, and degraded flag. Disagreement audit log lands at `.kova/consensus_disagreements.jsonl`.

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
