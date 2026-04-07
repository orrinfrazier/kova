# kova

Autonomous code agent — brainstorm issues, fix them, ship PRs.

*Kova* means "forge" in Finnish. Issues go in, PRs come out.

## What it does

Kova fixes GitHub issues autonomously using a structured pipeline:

```
Assess → Spec → Test → Impl → Quality → Review → Ship
```

Each stage runs a Claude agent via the [Agent SDK](https://docs.anthropic.com/en/docs/agents/agent-sdk). Quality gates run *inside* the agent — failures are self-healing, not session-killing.

## Modes

**Single fix** — fix one issue interactively:
```bash
kova fix 123
```

**Fix loop** — fix all open issues sequentially (for overnight runs):
```bash
kova fix --all
kova fix --all --filter auto-fix
kova fix --all --max 5
```

Each fix runs in an isolated git worktree. PRs are created but never auto-merged.

## Pipeline

| Wave | Model | What it does |
|------|-------|-------------|
| **Assess** | opus | Grade issue (A-F), evaluate feasibility, decide whether to proceed |
| **Spec** | opus | Decompose into testable pieces with acceptance criteria |
| **Test** | sonnet | Write failing tests (TDD red phase) |
| **Impl** | sonnet | Implement minimal code to pass tests (green phase) |
| **Quality** | haiku | Run lint, typecheck, tests, coverage — fix failures inline |
| **Review** | opus | Review for security, correctness, performance — categorize findings |
| **Ship** | — | Commit, push branch, create PR |

Waves are strictly sequential. If review finds issues, impl + quality re-run (max 1 iteration). State is checkpointed after each wave — if a run crashes, resume from last completed wave.

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

## Architecture

```
src/
├── cli/              CLI entry point (commander)
├── ai/               Agent SDK integration
│   ├── wave-executor  query() wrapper per wave
│   ├── models         Model tier resolution
│   └── errors         Error classification, retry logic
├── pipeline/          Fix pipeline orchestration
│   ├── fix            Single issue: Assess → Spec → Test → Impl → Quality → Review → Ship
│   ├── loop           Multi-issue: fetch → prioritize → fix each
│   └── prompts        Wave prompt loader
├── services/          Infrastructure
│   ├── checkpoint     File-based state persistence
│   ├── worktree       Git worktree management
│   ├── github         Issue fetching, PR creation (gh CLI)
│   └── config         repos.yaml loader
├── types/             Zod schemas for config, wave I/O
└── utils/             Logger
```

### Key design decisions

- **Agent SDK `query()` per wave** — each wave is a separate agent conversation with typed input/output. Based on [Shannon](https://github.com/KeygraphHQ/shannon)'s production pattern.
- **Quality gates inside the agent** — the agent runs lint/test/coverage, reads failures, fixes them, retries. No session-killing gate failures.
- **File-based checkpoints** — JSON state saved after each wave. Resume from crash without any infrastructure.
- **Git worktree isolation** — each fix runs in its own worktree. Main branch stays clean.
- **Sequential execution** — one fix at a time. Each fix is aware of repo state + open PRs. No merge conflicts.
- **Structured output** — Zod schemas → JSON Schema draft-07 for Agent SDK validation. Waves output typed JSON, not markdown to parse.

## Roadmap

See [GitHub milestones](https://github.com/orrinfrazier/kova/milestones) for the full plan.

## Development

```bash
npm run check          # Type check
npm run lint           # Biome lint
npm run test           # Run tests
npm run dev            # Watch mode
```

## License

MIT
