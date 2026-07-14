# Hydra-Swarm

A local multi-agent development harness. A lead (Claude Code) plans, dispatches,
and judges; a deterministic harness owns state, process launch, and
verification. Four vendors — **Claude**, **Codex**, **OpenCode/GLM**, and
**Kimi** — implement tasks in isolated Git worktrees. Every candidate crosses a
trust boundary (schema validation → Git evidence → ownership audit → sandboxed
verification) before it is promoted, cross-vendor reviewed, squashed, and
integrated.

> **Status:** Wave 2 (core loop, four vendor adapters, code intelligence,
> live capability profiles) is operational and dogfooded on its own
> development. Wave 3 (packaging this as a standalone, installable plugin) is
> in progress — the `hydra doctor` preflight command is built and tested; kit
> extraction, `hydra-init`, per-project policy scaffolding, and the global
> capability ledger are still in flight. See `docs/roadmap.md` for the
> detailed changelog.

## What this is for

Give the lead a task too large or too parallel for one agent to comfortably
hold. It decomposes the work, dispatches disjoint-scope lanes to whichever
vendor fits each lane best, and never trusts a worker's own claim of success —
every result is re-verified against real Git evidence and a sandboxed
verification run before it counts.

## Requirements

Run `/hydra-doctor` before anything else. It checks, non-negotiably:

| Class | Requirement |
|---|---|
| Shell | bash ≥ 4 (macOS ships 3.2 — install via Homebrew) |
| Core | `jq`, `node` ≥ 22.6, `git` |
| Vendor CLIs | `claude`, `codex`, `opencode`, `kimi` (each optional individually — a missing one just narrows which vendors are available) |
| Code intelligence | `gitnexus`, `graphify` (optional, advisory) |
| Observability | `herdr` (optional — pane hosting degrades to a plain background process without it) |
| Sandbox | [`srt`](https://github.com/anthropic-experimental/sandbox-runtime) (`npm install -g @anthropic-ai/sandbox-runtime`) — required for Kimi's auto-approving write role specifically; every other vendor is unaffected without it |
| Timeout | `timeout`/`gtimeout` preferred; a portable fallback is built in |

`hydra doctor` exits non-zero only on a fatal gap (shell version, missing core
tools, or a broken sandbox) — everything else degrades gracefully and is
reported as a warning, not a blocker.

## The loop

1. `run-init` — create run state.
2. Instantiate one task spec per lane, each with a disjoint `writable_paths`
   scope.
3. `create-worktree` — isolated Git worktree + branch per task.
4. `dispatch` — route to a vendor (`claude | codex | opencode | kimi`),
   optionally hosted live in a `herdr` pane for observability.
5. `promote` — **the trust boundary.** Schema → Git evidence → ownership audit
   → sandboxed verify → promote. Only promoted candidates are real; a raw
   worker drop is never trusted directly.
6. Cross-vendor review of each promoted candidate; only `accept` proceeds.
7. `squash` the accepted candidate into one clean commit.
8. `integrate` — serialized, dependency-ordered cherry-pick + combined
   verification gate.
9. Human-authorized merge, push, and deploy — the harness never does these
   itself.

## Live observability

Every vendor's dispatch can be hosted in a `herdr` terminal pane and streams
real progress live, not just a static banner:

- **Claude, Codex, Kimi** — hosted directly inside the pane.
- **OpenCode/GLM** — runs as a decoupled background process with a separate
  observer-only pane (direct pane-hosting was found to break its CLI call).

## Layout

```text
hydra-swarm/
├── .claude-plugin/plugin.json   plugin manifest
├── commands/hydra-doctor.md     preflight check, wraps kit/scripts/doctor.sh
├── skills/hydra-swarm/          the lead's operating protocol
├── docs/                        architecture, operations, vendor adapters, packaging
└── kit/
    ├── hydra/                   scripts, adapters, schemas, templates (bash)
    ├── hydra-ts/                the same, ported to TypeScript (default runtime)
    └── scripts/                 shared preflight scripts (e.g. doctor.sh)
```

## Documentation

- `docs/architecture.md` — trust boundary, verification gates, wave design
- `docs/operations.md` — day-to-day driving reference
- `docs/vendor-adapters.md` — per-vendor dispatch behavior and quirks
- `docs/packaging.md` — this plugin's own install/portability design
- `docs/roadmap.md` — changelog and open decisions
