# Hydra-Swarm

**v0.7.0** · A local multi-agent development harness. A lead (Claude Code)
plans, dispatches, and judges; a deterministic harness owns state, process
launch, and verification. Four vendor heads — **Claude**, **Codex**,
**OpenCode/GLM**, and **Kimi** — implement tasks in isolated Git worktrees.
Every candidate crosses a trust boundary (schema validation → Git evidence →
ownership audit → sandboxed verification) before it is promoted, cross-vendor
reviewed, squashed, and integrated.

The core principle: **deterministic gates decide; probabilistic tools
inform.** Workers are untrusted processes in a CI-like pipeline, not trusted
authors — every claim of success is re-verified against real Git evidence and
a sandboxed verification run before it counts. Merge, push, and deploy remain
human-authorized.

> **Status:** Waves 0–2 complete and dogfooded on this repo's own
> development. Wave 3 (standalone installable packaging) in progress:
> `/hydra-doctor` preflight, head auto-detection, and the compiled
> single-binary runtime are done; kit extraction and `hydra-init` scaffolding
> remain. See [CHANGELOG.md](CHANGELOG.md) for releases and
> `docs/roadmap.md` for the full narrative history.

## Requirements

Run `/hydra-doctor` first — it checks everything below, degrades gracefully
on optional gaps, and can auto-fix the safe package-manager-installable
subset with per-command confirmation:

| Class | Requirement |
|---|---|
| Core | `git`, `jq`; `node` ≥ 22.6 for the source lane (the compiled binary needs no Node) |
| Vendor CLIs | `claude`, `codex`, `opencode`, `kimi` — each optional; a missing one just narrows the available heads |
| Sandbox | [`srt`](https://github.com/anthropic-experimental/sandbox-runtime) (`npm i -g @anthropic-ai/sandbox-runtime`) — required only for Kimi's auto-approving write role |
| Code intelligence | `gitnexus`, `graphify` (optional, advisory) |
| Observability | `herdr` (optional — pane hosting degrades to plain background processes) |

Head availability is also detected automatically: `detect-heads.sh` probes
the four vendor CLIs, enumerates opencode's configured models (GLM family,
Ollama, …) and its active model, and snapshots the result to
`~/.local/state/hydra/heads.json` — consumed by allocation (unavailable heads
are never recommended) and dispatch (a missing `assigned_vendor` fails fast
with the available substitutes named). `run-init` refreshes the snapshot at
the start of every run.

## Runtime

The default runtime is a Bun-compiled single binary (`npm run build:bin` →
`kit/hydra-ts/dist/hydra-cli`, built per machine, never committed). With no
binary present, the unchanged `kit/hydra/scripts/*.sh` entry points fall back
to the TypeScript/Node source lane automatically — a fresh checkout works out
of the box. Workers additionally receive `HYDRA_NODE_BIN` pointing at a
verified Node ≥ 22.6, so login-shell PATH rebuilds inside vendor tool shells
can't strand them on a stale system node.

## The loop

1. `run-init` — create run state (and refresh the head snapshot).
2. Instantiate one task spec per lane, each with a disjoint `writable_paths`
   scope; optionally pin `assigned_vendor` and (for opencode) an
   `opencode_model`.
3. `create-worktree` — isolated Git worktree + branch per task.
4. `dispatch` — route to the assigned head, hosted live in a `herdr` pane.
   Kimi's write role runs inside an `srt` OS sandbox with a per-task network
   allowlist derived from the worktree's own dependency manifests, and a
   preflighted dev environment (toolchain, caches, store dirs) so it never
   dies mid-task on a missing tool.
5. `promote` — **the trust boundary.** Schema → Git evidence → ownership
   audit → sandboxed verify → promote. Only promoted candidates are real; a
   raw worker drop is never trusted directly.
6. Cross-vendor review of each promoted candidate; only `accept` proceeds.
7. `squash` the accepted candidate into one clean commit.
8. `integrate` — serialized, dependency-ordered cherry-pick + combined
   verification gate.
9. Human-authorized merge, push, and deploy.

Operational commands while a task runs: `status` (ledger-authoritative state
+ live progress tail), `cancel-task` (the only supported clean cancel), and
an automatic loop-thinking detector that flags and auto-cancels workers
cycling without real Git progress.

## Live observability

Every dispatch can be hosted in a `herdr` terminal pane with real streamed
progress:

- **Claude, Codex, Kimi** — hosted directly inside the pane (Codex JSONL and
  Kimi NDJSON are live-tailed).
- **OpenCode/GLM** — runs as a decoupled background process with a separate
  observer-only pane (direct pane-hosting breaks its CLI).

## Layout

```text
hydra-swarm/
├── .claude-plugin/plugin.json   plugin manifest (version)
├── CHANGELOG.md                 release history
├── commands/hydra-doctor.md     preflight command, wraps kit/scripts/doctor.sh
├── skills/hydra-swarm/          the lead's operating protocol + references
├── docs/                        architecture, operations, adapters, roadmap
└── kit/
    ├── hydra/                   stable .sh launchers, schemas, policies, templates
    ├── hydra-ts/                the TypeScript implementation (source of truth)
    └── scripts/                 shared preflight (doctor.sh, doctor-fix.sh)
```

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history
- `docs/architecture.md` — trust boundary, verification gates, wave design
- `docs/operations.md` — day-to-day driving reference
- `docs/vendor-adapters.md` — per-vendor dispatch behavior and quirks
- `docs/state-and-worktrees.md` — storage domains, state location
- `docs/trust-and-permissions.md` — why workers are never trusted
- `docs/packaging.md` — install/portability design (Wave 3)
- `docs/roadmap.md` — full narrative history and open decisions

## License

MIT
