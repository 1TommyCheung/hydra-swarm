# Hydra-Swarm — Documentation Set

> **Dev notes:** vendor design/review/spike artifacts referenced below (`bun-migration-*`, `*-design-*`, `*-review-*`, `license-research-*`, `doc-audit-*`) live in the machine-local, gitignored `docs/dev-notes/` — production users do not need them; recover from git history pre-split if absent.


**Date:** 2026-07-20 · **Status:** **v0.6.8.1** — Waves 0–2 delivered; the compiled Bun binary is the operational default with GitHub Releases distribution (`fetch-bin.sh`), head auto-detection is live, and `hydra gc` + `hydra run-log` own the worktree-lifecycle close (Node/`ts` is the automatic fallback when no binary is provisioned yet). 0.6.8.1 hardened live observability (no blank panes, workspace-pinned panes, usage-limit cooldown, real Kimi resume, `amendment_check` gates). Front of the roadmap: the two prioritized moat-sharpeners (adversarial verification vault, PR-mode trust check — `roadmap.md`), then kit extraction + the hardening daemon.
**Supersedes:** the single-document specs v1–v3. This document set is self-contained; no prior version is a normative dependency.
**Evidence:** per-wave completion reports and the Wave 2 exit snapshot lived in the pre-extraction tree (`../hydra-reports/`); they were not carried into this standalone repo. Day-to-day operation is documented in `operations.md`.

## What this is

**Hydra-Swarm**: a local multi-agent software development system. One lead (the *head* — Claude Code) plans and judges; a deterministic harness owns processes, state, and verification; heterogeneous coding agents (the *swarm* — Claude Code, Codex/GPT‑5.6 Sol, OpenCode/GLM 5.2, Kimi K2.7 Code) implement in isolated Git worktrees; accepted work converges through a controlled integration worktree behind evidence gates. Cut off the head and a new one grows from Git + the state store — lead replacement is a design guarantee, not a recovery hack.

The harness implementation lives in `kit/hydra-ts/src/*.ts`. Operators call the
stable `kit/hydra/scripts/<name>.sh` entry points; those are small launchers.
By default (unset `HYDRA_HARNESS`) they prefer the compiled Bun binary
(`bin`), falling back to the TypeScript/Node lane (`ts`) automatically when no
binary is provisioned yet — a fresh checkout with nothing pre-built still
works out of the box. The Bash implementation lane (the `kit/hydra/adapters/*.sh`
shell adapters and the script Bash bodies) was retired in run 0045
(`docs/bash-lane-retirement-plan.md`): `HYDRA_HARNESS=bash` and
`HYDRA_ADAPTER_RUNTIME=bash` now fail loudly rather than coercing to `ts`. An
explicit `HYDRA_HARNESS=bin` with an unusable `HYDRA_BIN` is a hard error, not
a silent fallback — that only applies to the implicit default. Point
`HYDRA_BIN` at a pinned compiled binary
(currently `~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64`)
to force a specific rollback artifact. The Bun single-binary migration
(Stage 1–4: router, asset embedding, cross-platform proof, two rounds of
adversarial review) is summarized in `roadmap.md`; the stage-by-stage
findings live in `docs/bun-migration-*.md`.

## Naming conventions (canonical)

| Artifact | Name |
|---|---|
| System | Hydra-Swarm |
| Tracked repo directory | `kit/hydra/` |
| Default harness implementation | `kit/hydra-ts/src/` (via `kit/hydra/scripts/*.sh`) |
| Lead skill | `skills/hydra-swarm/` |
| Setup/upgrade skill | `hydra-setup` — planned in Wave 3, not built yet |
| External state root | `~/.local/state/<repo-id>-hydra/` |
| Agent branches | `hydra/<run-id>/<task-id>` |
| Integration branches | `hydra-integration/<run-id>` |
| Wave marker file | `kit/hydra/WAVE` |
| Git tags | `hydra-wave-0`, `hydra-wave-1`, `hydra-wave-2` |
| Committed run audit logs | `docs/hydra-dev-logs/` (`run-log` output) |
| Standalone CLI | `hydra` (compiled binary; `hydra version` reports the built-from version) |

Reserved prefix rule: no human or agent creates branches under `hydra/` or `hydra-integration/` outside harness scripts.

## Documents

| File | Contents |
|---|---|
| `overview.html` | Landing-page overview (open in a browser) |
| `architecture-diagram.html` | Visual pipeline diagram (open in a browser) |
| `architecture.md` | Principles, system model, responsibility separation, evidence hierarchy, lead/harness trust decision |
| `trust-and-permissions.md` | Worker/lead/harness boundaries, ownership enforcement, audit rules, verification sandbox |
| `state-and-worktrees.md` | Git-tracked vs external state vs worktrees; bootstrap lifecycle; portability; recovery bundles |
| `task-result-review-contracts.md` | Task spec, result contract, inbox→promotion, review gates, integration lifecycle, ledger schemas |
| `code-intelligence.md` | GitNexus and Graphify — Wave 1+ only |
| `vendor-adapters.md` | Adapter contract, per-vendor capabilities and quirks, capability ledger |
| `operations.md` | **Runbook** — start/monitor/kill a run, herdr, the lead-kill drill, common failures + fixes, worktree retention (gc + run-log) |
| `packaging.md` | Kit extraction, binary distribution, deployment to new repos, global ledger, upgrade protocol |
| `roadmap.md` | Delivered changelog (Waves 0–2 + post-Wave-2 hardening), resolved open decisions, Wave 3 + daemon, doc-maintenance checklist |
| `kimi-network-allowlist-case-study.md` | Field-incident writeup: deriving the srt network allowlist from worktree manifests |
| `hydra-dev-logs/` | Per-run lifecycle audit documents (`run-log` output) — committed |

## Operating the system? (Wave 2 is live)

Read, in order:

1. `skills/hydra-swarm/SKILL.md` — the lead's run loop
2. `operations.md` — the runbook (start/monitor/kill, herdr, recovery drill, failure modes)
3. `task-result-review-contracts.md` — the task/result/review/integration contracts
4. `vendor-adapters.md` — the four heads, capability ledger, allocation

## Re-installing from scratch or learning how it was built?

The frozen bootstrap record (`wave0-implementation.md`) was a pre-split
artifact and now lives in the machine-local `docs/dev-notes/` (recover from
git history pre-split if absent). For a new repo, the planned `hydra-setup`
skill will supersede it (Wave 3 / `packaging.md`).

## Central hypothesis — verdict

> A lead-orchestrated, worktree-isolated, evidence-gated integration process produces more reliable combined code than agents operating directly on one branch.

**Verdict (2026-07-13): supported, demonstrated — not yet a statistical claim.**
In the hypothesis run (0002), two candidates each passed their own tests and
cross-vendor review, integrated with no textual conflict, yet the **combined
verification gate caught a semantic conflict** (a producer returning dollars, a
consumer expecting cents) that on a single shared branch would have merged
silently. That is the failure the whole process exists to catch, and it caught
it. Supporting evidence across 15 runs: **zero** agent-reported "passed" claims
were accepted without harness re-verification; the trust boundary rejected 6
distinct classes of bad candidate; measured claim-vs-verified divergence stayed
low (Claude 0.20/n=5, Codex 0.00/n=4, Kimi 0.00/n=3). The honest limit: this is
one planted-conflict demonstration plus small-n operational data, not a
controlled A/B against a single-branch baseline — the Wave 2 exit report lived in the pre-extraction tree (`../hydra-reports/wave2-exit-report.md`) and was not carried into this standalone repo.
