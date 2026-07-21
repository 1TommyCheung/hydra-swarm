# Hydra-Swarm

**v0.6.8.3** · A local multi-agent development harness. A lead (Claude Code)
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
> development. Since Wave 2: head auto-detection, the compiled single-binary
> runtime with GitHub Releases distribution (`fetch-bin.sh`), and the `hydra
> gc` + `hydra run-log` worktree-lifecycle pair are done. 0.6.8.3 hardened
> the revise loop and the truth of record: file-first revision evidence,
> append-only review provenance, unique dispatch-attempt identity, Claude
> API-error truth, and bounded prompt/review-store hardening (see
> [CHANGELOG.md](CHANGELOG.md) for the 0.6.x releases). The remaining
> packaging work (kit extraction, `hydra-init` scaffolding, global ledger,
> bundle export/import) is still design-only — see `docs/roadmap.md`.

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

The default runtime is a Bun-compiled single binary — never committed to
git. Get one either way:

- **Download a verified release**: `bash kit/hydra/scripts/fetch-bin.sh`
  fetches the binary matching this plugin's version from GitHub Releases,
  verifies the manifest SHA-256 and the binary's self-reported version, and
  installs to `~/.local/share/hydra-bin/v<version>/`. Releases carry six
  native artifacts (darwin-arm64/x64, linux-x64/arm64, and native Windows
  windows-arm64/x64 `.exe`), each release natively verified on Linux, macOS,
  and Windows before publish (v0.6.8.3). The `fetch-bin.sh` installer itself
  remains Unix-only (darwin/linux): on Windows, run it under WSL or download
  the native `.exe` + manifest from the release page directly.
- **Build locally**: `npm run build:bin` in `kit/hydra-ts`.

Resolution order: `HYDRA_BIN` → checkout `dist/` → version-keyed download
cache → automatic fallback to the TypeScript/Node source lane, so a fresh
checkout works out of the box with no binary at all. `hydra version` and
`/hydra-doctor` both detect a stale binary (version drift vs the plugin
manifest). Workers additionally receive `HYDRA_NODE_BIN` pointing at a
verified Node ≥ 22.6, so login-shell PATH rebuilds inside vendor tool shells
can't strand them on a stale system node.

At run close, `hydra run-log <run-id>` renders a per-run audit document to
`docs/hydra-dev-logs/run-<id>.md` (document, then delete) and `hydra gc
--apply --keep-last 3` reaps worktrees+branches the ledger proves integrated
— the two together keep worktrees from growing forever. See
`docs/operations.md` § Worktree retention policy.

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
10. Run close — `run-log` (audit document) then `gc --apply --keep-last 3`
    (ledger-proven worktree reaping).

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
- `docs/architecture-diagram.html` — visual architecture diagram (open in a browser)
- `docs/architecture.md` — trust boundary, verification gates, wave design
- `docs/dispatch-modes.md` — every dispatch mode in detail (worker, review, amend, promote, squash/integrate, operational)
- `docs/operations.md` — day-to-day driving reference
- `docs/vendor-adapters.md` — per-vendor dispatch behavior and quirks
- `docs/state-and-worktrees.md` — storage domains, state location
- `docs/trust-and-permissions.md` — why workers are never trusted
- `docs/packaging.md` — install/portability design (Wave 3)
- `docs/roadmap.md` — full narrative history and open decisions

## License

MIT
