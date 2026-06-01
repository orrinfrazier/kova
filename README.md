# kova

Autonomous code agent — brainstorm issues, fix them, ship PRs. Issues go in, PRs come out.

## What it does

Kova fixes GitHub issues autonomously using a structured pipeline:

```
Assess → Spec → Test → Impl → Quality → Review → Ship
```

Each stage runs as a **separate sub-agent** via [pi-mono](https://github.com/badlogic/pi-mono) (multi-provider LLM runtime). Every wave gets a fresh context, typed JSON handoffs, and its own model — opus for reasoning, sonnet for code gen, local models for free retries. Quality gates run *inside* the agent — failures are self-healing, not session-killing.

## Modes

**Single fix** — fix one issue interactively:
```bash
kova fix 123
```

**Auto mode** — fix all open issues sequentially (for overnight runs):
```bash
kova auto
kova auto --filter auto-fix
kova auto --max 5 --budget 20
```

**Fix loop** — fix all open issues without auto-mode wrapping:
```bash
kova fix --all
kova fix --all --filter auto-fix
```

Each fix runs in an isolated git worktree. PRs are created but never auto-merged.

## Pipeline

| Wave | Default Model | What it does |
|------|--------------|-------------|
| **Assess** | opus | Grade issue (A-F), evaluate feasibility, decide whether to proceed |
| **Spec** | opus | Decompose into testable pieces with acceptance criteria |
| **Test** | sonnet / local | Write failing tests (TDD red phase) |
| **Impl** | sonnet / local | Implement minimal code to pass tests (green phase) |
| **Quality** | haiku | Run lint, typecheck, tests, coverage — fix failures inline |
| **Review** | opus | Review for security, correctness, performance — categorize findings |
| **Ship** | — | Commit, push branch, create PR |

Every wave is a **separate agent invocation** with its own model, tools, and context. No wave sees another wave's conversation history — only typed JSON handoffs.

### Two loops

- **T↔I loop** (fast, "make it work") — impl runs, orchestrator runs tests via bash, if fail → respawn impl with test output. Max 3 retries. Orchestrator controls the loop, not the agent.
- **R→I→T loop** (slower, "make it right") — review categorizes findings as NEEDS_NEW_TESTS (ratcheting eval) or MECHANICAL_FIX (refactoring). Re-enter impl+test, then re-review with fresh agent. Max 2 iterations.

State is checkpointed via typed handoff files after each wave — if a run crashes, resume from last completed wave.

## Setup

```bash
# Clone
git clone https://github.com/orrinfrazier/kova.git
cd kova

# Install
npm install

# Build
npm run build

# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Fix an issue
cd /path/to/your/repo
kova fix 123
```

## Configuration

### Per-repo config (repos.yaml)

```yaml
repos:
  my-project:
    path: ~/dev/my-project
    rules:
      coverage: 80
      max_issues_per_run: 10
      focus: ["security", "performance"]
    model:
      assess: large    # opus
      spec: large      # opus
      test: medium     # sonnet
      impl: medium     # sonnet
      quality: small   # haiku
      review: large    # opus
    isolation: worktree
    auto:
      source: open_issues
      filter: auto-fix
      max_per_run: 10
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `KOVA_SMALL_MODEL` | Override small model (default: haiku) |
| `KOVA_MEDIUM_MODEL` | Override medium model (default: sonnet) |
| `KOVA_LARGE_MODEL` | Override large model (default: opus) |
| `KOVA_LOG_LEVEL` | Log level: debug, info, warn, error |

### MCP servers

Kova spawns stdio-based MCP servers per run and exposes their tools to specific waves. Each wave gets a fixed default server set (see `WAVE_MCP_DEFAULTS` in `src/ai/mcp.ts`); per-wave overrides can be set in `repos.yaml`. Missing servers are dropped silently — pipeline degrades gracefully.

| Wave | Default servers | Why |
|------|-----------------|-----|
| assess, spec, review, brainstorm | `repo-intel`, `codegraph` | Reasoning waves benefit from cheap, structured code navigation |
| impl | `repo-intel`, `shadcn` | Implementation needs code search + UI component generation |
| test, quality | — | Execution waves run checks; no MCP tools needed |

#### codegraph (reasoning waves)

[codegraph](https://github.com/cgtools/codegraph) (MIT, 100% local) exposes read-only structural tools — `context`, `trace`, `explore`, `callers`, `callees`, `impact`, etc. — via `codegraph serve --mcp`. Reasoning-wave prompts (assess/spec/review/brainstorm) are steered to call codegraph's structural tools FIRST and fall back to grep/find only when codegraph cannot answer the question (~70% fewer tool calls in practice).

Configure in `repos.yaml`:

```yaml
repos:
  my-project:
    path: ~/dev/my-project
    mcp:
      servers:
        codegraph:
          command: codegraph
          args: ["serve", "--mcp", "--repo", "."]
        # repo-intel and shadcn typically live in ~/.claude/settings.json
        # and are auto-loaded — only override here if you need a custom command.
```

If `codegraph` is not present in `mcp.servers` (or the binary is missing), startup logs a warning and continues — the reasoning waves still run, just without the cheap structural shortcut. No per-wave config change is needed to enable or disable it.

## Architecture

```
src/
├── cli/              CLI entry point (commander)
├── ai/               Pi-mono agent integration
│   ├── wave-executor  Spawns fresh agent per wave
│   ├── models         Model tier resolution (multi-provider)
│   └── errors         Error classification, retry logic
├── pipeline/          Fix pipeline orchestration
│   ├── fix            Orchestrator: Assess → Spec → T↔I loop → Quality → R→I→T loop → Ship
│   ├── loops          T↔I and R→I→T loop controllers
│   ├── auto           Autonomous mode (fetch → prioritize → fix loop)
│   ├── loop           Multi-issue sequential execution
│   ├── cost-report    Cost tracking and run reports
│   ├── prompts        Wave prompt loader
│   └── context        Handoff context builder per wave
├── services/          Infrastructure
│   ├── checkpoint     File-based state persistence
│   ├── worktree       Git worktree management
│   ├── github         Issue fetching, PR creation (gh CLI)
│   ├── prioritize     Issue scoring and dependency ordering
│   ├── language-detect Project language and tooling detection
│   └── config         repos.yaml loader
├── types/             Zod schemas for config, wave I/O, handoffs
├── prompts/           Wave prompt files (assess.md, spec.md, etc.)
└── utils/             Logger
```

### Key design decisions

- **Pi-mono runtime** — [pi-mono](https://github.com/badlogic/pi-mono) provides the agent loop, tool calling, and multi-provider LLM API (Anthropic, OpenAI, Google, Mistral, Bedrock). Not locked to one provider.
- **Always sub-agent** — every wave is a separate agent invocation. No inline mode. Fresh context, focused prompt, restricted tools. Review can't be biased by impl's reasoning.
- **Typed handoffs** — waves communicate via `WaveHandoff<T>` JSON files (Zod-validated). No conversation history passed between waves. Handoff files are both the communication protocol and the resume checkpoint.
- **Orchestrator is code, not LLM** — the TypeScript orchestrator controls loops, runs tests via bash, decides retries. Agents are stateless workers that receive a prompt and return structured output.
- **Quality gates inside the agent** — the agent runs lint/test/coverage, reads failures, fixes them, retries. No session-killing gate failures.
- **Git worktree isolation** — each fix runs in its own worktree. Main branch stays clean.
- **Docker sandbox isolation** — for OSS / untrusted repositories, `isolation: docker` runs every AI wave (assess, spec, test, impl, quality, review) inside a per-issue Docker container bind-mounted at `/workspace`. The host filesystem is not accessible to the agent. Resource limits (`--cpus`, `--memory`, configurable `timeout`) and optional `restrict_network: true` (`--network none`) further constrain the container. Auto-defaults to `docker` for public hosts (github.com, gitlab.com, etc.); explicit `isolation: worktree` keeps everything on the host for private/trusted repos.
- **Sequential auto mode** — one fix at a time. Each fix is aware of repo state + open PRs. No merge conflicts.
- **Multi-model per wave** — opus for reasoning (assess, spec, review), sonnet/local for code gen (test, impl), haiku for mechanical work (quality). Local models via Ollama for free retries.

## Roadmap

| Milestone | What | Status |
|-----------|------|--------|
| **v0.1** Fix Pipeline | `kova fix` produces a real PR | Done |
| **v0.2** Auto Mode | `kova auto` overnight fix loop | In progress |
| **v0.25** Pi-Mono Migration | Swap Agent SDK → pi-mono multi-provider runtime | |
| **v0.275** Sub-Agent Architecture | Typed handoffs, loop controllers, per-wave agent spawner | |
| **v0.3** Brainstorm | Interactive issue generation, supervised mode | |
| **v0.4** Multi-Repo | repos.yaml, per-repo config, cross-repo awareness | |
| **v0.5** Local AI | Ollama integration, free impl/test retries | |
| **v0.6** Vector DB & Learning | pgvector, episodic memory, cross-cycle learning | |
| **v0.7** Docker Sandbox | Full isolation for untrusted repos | |
| **v0.8** Multi-AI Providers | OpenAI, Gemini, router (simplified by pi-mono) | |
| **v0.9** MCP & Tools | repo-intel, custom tools, Playwright | |
| **v0.10** GitHub Integration | Webhooks, merge, PR feedback, Action | |
| **v0.11** Observability | Structured logging, history, metrics | |
| **v0.12** Prompt Engineering | Custom prompts, versioning, A/B testing | |
| **v0.13** Concurrency | Parallel fixes, conflict resolution | |

See [GitHub milestones](https://github.com/orrinfrazier/kova/milestones) for issue-level detail.

## Development

```bash
npm run check          # Type check
npm run lint           # Biome lint
npm run test           # Run tests
npm run dev            # Watch mode
```

## License

MIT
