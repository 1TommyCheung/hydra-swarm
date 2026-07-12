# Hydra-Swarm — Roadmap

## Wave 1 — Intelligence and resilience (after Wave 0 exit criteria)

- GitNexus with harness-generated post-freeze indexes, manifests, freshness gates (`code-intelligence.md` §2)
- Versioned `resume()` amendment protocol exercised end-to-end
- Cross-vendor review policy formalized (risk-triggered, not convention)
- Timeouts, concurrency caps, and budget accounting as ledger events
- Lead recovery drill as a standing test (kill lead mid-run; fresh session resumes)
- **OpenCode (GLM 5.2) adapter** — exploration + long-diff review roles first
- Conditional `wave_1` bootstrap steps activated

## Wave 2 — Adaptive orchestration

- **Kimi (kimi/k2.7-code) adapter** — visual_debugging + contained implementation under full sandbox
- Graphify baseline with the investigation-not-verdict policy
- Capability profiles live: usage aggregation, allocation recommendations (human-gated pins)
- Observability: **herdr** as Layer-1 live monitor (Linux-native, detach/SSH, socket API; harness pushes pane state from ledger events — never output-scraping as truth); minimal ledger web renderer as Layer-2 authoritative view; Claude workers export OTel to a local collector. Normative rule: live state is advisory; Git + ledger win; disagreement is itself an anomaly event. Non-goal: any UI that owns dispatch/worktrees/task lifecycle (Conductor, Vibe Kanban, cmux-team).
- Automated routing recommendations (never automatic pin changes)

## Hardening milestone — harness daemon (post-Wave 2 or when threat model demands)

Replace the Wave 0 privileged-lead protocol boundary with a real capability boundary: a local daemon owning the state directory under separated privileges, exposing narrow operations only:

```text
create-run · register-task · record-dispatch · promote-result
record-verification · record-review · close-run
```

The lead gets read-only promoted views and cannot write ledger files. Because every state mutation already flows through script interfaces, this migration changes the owner of the scripts, not their callers.

## Later enhancements

- Standalone `hydra` CLI (moves the caller; scripts/schemas/state layout survive)
- MCP-based adapters; Claude/Kimi Agent SDK adapters for programmatic permission callbacks
- Dependency-aware task scheduling; adaptive reviewer routing by diff size/language
- PR creation after human approval; CI/remote workers; signed result attestations; policy engine
- Warm-server pooling (OpenCode `serve`, `kimi server`)
- Design references to track, not adopt wholesale: **gnap** (git-as-task-board protocol), **wit** (Tree-sitter symbol-level locks), **swarm-protocol** (MCP claim/heartbeat/handoff), **MartinLoop** (run receipts benchmark for the final report)

## Success criteria (cumulative)

1. Wave 0 exit criteria (see `wave0-implementation.md` §4).
2. Replacement lead resumes an interrupted run from Git + state store alone (Wave 1 standing drill).
3. No agent-reported verification is ever the sole basis for acceptance.
4. Spec amendments fully reconstructable; accepted results match the latest spec version.
5. Ownership violations caught at the audit even when tool hooks were bypassed by shell writes.
6. Graph evidence never independently blocks or approves integration.
7. Per-vendor `claim_vs_verified_divergence` measured by end of Wave 1.
8. A Codex-led run succeeds (post-Wave-1 target; not a Wave 0–1 acceptance criterion).

## Open decisions

1. External state root: `~/.local/state/` (default) vs `<git-common-dir>/hydra/` (local-repo-associated; neither travels with a clone — multi-machine uses exported run bundles).
2. GLM 5.2 promotion to implementer after N clean explorer/reviewer runs.
3. Kimi write-role policy if Kimi Code gains print-mode allowlists.
4. Scorecard-driven allocation: recommend-only (current) vs auto (human-gated pins until revisited).
5. Graphify graph: run-scoped external artifact (default) vs committed.
6. Minimum integration gate commands per project.
7. Retention period for external run state and worktrees.
8. Local-branch-only (current) vs PR preparation after approval.
9. Daemon trigger: which threat-model change or team-size threshold justifies the hardening milestone.
