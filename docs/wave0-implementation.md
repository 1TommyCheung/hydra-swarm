# Hydra-Swarm — Wave 0 Implementation

> **FROZEN — historical record. Completed 2026-07-12.** This is the account of
> how the system was bootstrapped; it is **not maintained** and must not be
> rewritten (rewriting destroys provenance — the same logic as not letting a
> worker rewrite its branch history). For operating the live system see
> `operations.md`; for re-installing into a new repo the `hydra-setup` skill
> supersedes this file (Wave 3 / `packaging.md`). As-built deviations from this
> plan are recorded in `roadmap.md` (delivered changelog) and the per-doc
> drift-audit sections.

**Scope:** Claude Code lead · Claude + Codex workers · core evidence-gated integration loop.
**Explicitly out:** GitNexus, Graphify, capability profiles, OpenCode/Kimi adapters, monitors (herdr), OTel, automatic budget accounting (a manual run cap suffices), automated cross-vendor review policy (in Wave 0, Codex reviews Claude and vice versa by convention).

## 1. What Wave 0 proves

> A lead-orchestrated, worktree-isolated, evidence-gated integration process produces more reliable combined code than agents operating directly on one branch.

Acceptance = one end-to-end run (2 writers, review, integration, combined verification) where every gate decision traces to promoted evidence and no worker ever wrote authoritative state.

## 2. Components to build

### 2.1 Tracked skeleton (Domain 1)

```text
AGENTS.md                              # from trust-and-permissions.md §10
CLAUDE.md                              # lead instructions: drive scripts, never hand-execute state
.claude/agents/                        # read-only subagent roles only (explorer, reviewer)
.claude/hooks/                         # ownership PreToolUse hook (defense in depth)
skills/hydra-swarm/                    # lead-only skill: procedure, ledger read protocol
hydra/
├── schemas/{run,task,result,review}.schema.json
├── templates/{run,task}.example.yaml
├── scripts/
│   ├── create-worktree.sh    # Domain 3 path, branch, bootstrap, PORT injection, network phases
│   ├── dispatch.sh           # adapter selection, timeout wrap, background jobs, session capture
│   ├── promote.sh            # THE TRUST BOUNDARY: schema → git → ownership → verify → promote
│   ├── verify.sh             # sandboxed verification (called by promote.sh and integrate.sh)
│   ├── audit-ownership.sh    # full rule set from trust-and-permissions.md §5
│   ├── squash.sh             # harness-created integration squash; records source_commits
│   └── integrate.sh          # cherry-pick loop with per-candidate verify + ledger events
├── adapters/{claude.sh, codex.sh}
└── policies/{ownership.yaml, permissions.yaml, verification.yaml}
```

### 2.2 External state layout (Domain 2)

Create per `state-and-worktrees.md` §1. `promote.sh` is the only writer of `authoritative/`; the lead calls scripts, never edits state files (architecture.md §4.8, Wave 0 trust decision).

### 2.3 Dispatch paths

- **Codex workers:** `codex exec` subprocess in the assigned worktree via `adapters/codex.sh`.
- **Claude workers (write-capable):** headless `claude -p` subprocess in the assigned worktree via `adapters/claude.sh` — the subprocess path, because the native-subagent isolation contract is not yet verified.
- **Claude native subagents:** read-only roles only (exploration, review) in Wave 0.
- Both adapters: capture session id from structured output into `sessions/`; wrap in `timeout`; exit code and timeout recorded as ledger events before parsing anything.

## 3. Build order

**Step 1 — Skeleton.** Open Claude Code in the repo with this doc set. Build §2.1 files. Nothing else. Every script must be runnable standalone (the lead is a caller, not a component).

**Step 2 — Boundary tests before any agent runs.** Prove `promote.sh` rejects: a drop with a nonexistent SHA; a drop claiming "passed" when re-run fails; a diff touching a non-writable path; an untracked file outside ownership; a symlink escaping the worktree; a stale `spec_version`. These six rejection tests are the trust boundary's unit tests — write them first.

**Step 3 — Two single-worker dry runs.** One Claude (subprocess), one Codex, trivial tasks in separate worktrees. Acceptance: both produce byte-identical promoted-result *shapes*; ledger shows the full event sequence; the "transcript vanishes" test passes (kill the lead session; a fresh session reconstructs run state from the state store and Git alone).

**Step 4 — The hypothesis run.** Two writers in parallel worktrees on genuinely coupled tasks (shared contract), cross-review (Codex reviews Claude's candidate and vice versa), harness squash, integration worktree, ordered cherry-pick with per-candidate verification, combined gate, final report. Deliberately include one task designed to create a semantic (non-textual) conflict — the run must *catch* it at combined verification, not merge it silently.

**Step 5 — Report + retro.** Final report per `task-result-review-contracts.md` §6. Record: gate catches, false rejections, claim-vs-observed divergences, wall time, manual cap consumed. This becomes the baseline the hypothesis is judged against.

## 4. Wave 0 exit criteria

1. Six boundary rejection tests pass.
2. End-to-end run completes with every task state transition present in the ledger.
3. No file under `authoritative/` was written by anything but `promote.sh` / harness scripts (verify by audit of script logs or fs timestamps).
4. Lead-kill recovery succeeds mid-run.
5. The planted semantic conflict is caught at the combined gate.
6. A human can reconstruct *why* each candidate was accepted from promoted evidence alone.

Then, and only then: `roadmap.md` → Wave 1.
