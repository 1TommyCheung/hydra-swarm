# Hydra-Swarm — Documentation Set

**Version:** 3.2 · **Date:** 2026-07-13 · **Status:** **Wave 2 operational** (all four heads). Waves 0–2 delivered; the TypeScript harness is the operational default; front of the roadmap is packaging + the hardening daemon.
**Supersedes:** the single-document specs v1–v3. This document set is self-contained; no prior version is a normative dependency.
**Evidence:** per-wave completion reports and the Wave 2 exit snapshot live in `../hydra-reports/`. Day-to-day operation is documented in `operations.md`.

## What this is

**Hydra-Swarm**: a local multi-agent software development system. One lead (the *head* — Claude Code) plans and judges; a deterministic harness owns processes, state, and verification; heterogeneous coding agents (the *swarm* — Claude Code, Codex/GPT‑5.6 Sol, OpenCode/GLM 5.2, Kimi K2.7 Code) implement in isolated Git worktrees; accepted work converges through a controlled integration worktree behind evidence gates. Cut off the head and a new one grows from Git + the state store — lead replacement is a design guarantee, not a recovery hack.

The harness implementation now lives in `hydra-ts/src/*.ts`. Operators continue
to call the stable `hydra/scripts/<name>.sh` entry points; those wrappers execute
the TypeScript implementation by default. Set `HYDRA_HARNESS=bash` for the
frozen Bash reference/rollback implementation. The migration findings, plans,
reviews, and shakedown history are in `../../hydra-ts/migration/`.

## Naming conventions (canonical)

| Artifact | Name |
|---|---|
| System | Hydra-Swarm |
| Tracked repo directory | `hydra/` |
| Default harness implementation | `hydra-ts/src/` (via `hydra/scripts/*.sh`) |
| Lead skill | `.claude/skills/hydra-protocol/` |
| Setup/upgrade skill | `.claude/skills/hydra-setup/` |
| External state root | `~/.local/state/<repo-id>-hydra/` |
| Agent branches | `hydra/<run-id>/<task-id>` |
| Integration branches | `hydra-integration/<run-id>` |
| Wave marker file | `hydra/WAVE` |
| Git tags | `hydra-wave-0`, `hydra-wave-1`, `hydra-wave-2` |
| Committed reports | `docs/hydra-reports/` |
| Future standalone CLI | `hydra` |

Reserved prefix rule: no human or agent creates branches under `hydra/` or `hydra-integration/` outside harness scripts.

## Documents

| File | Contents |
|---|---|
| `architecture.md` | Principles, system model, responsibility separation, evidence hierarchy, lead/harness trust decision |
| `wave0-implementation.md` | Exactly what to build first — components, scripts, acceptance tests |
| `trust-and-permissions.md` | Worker/lead/harness boundaries, ownership enforcement, audit rules, verification sandbox |
| `state-and-worktrees.md` | Git-tracked vs external state vs worktrees; bootstrap lifecycle; portability; recovery bundles |
| `task-result-review-contracts.md` | Task spec, result contract, inbox→promotion, review gates, integration lifecycle, ledger schemas |
| `code-intelligence.md` | GitNexus and Graphify — Wave 1+ only |
| `vendor-adapters.md` | Adapter contract, per-vendor capabilities and quirks, capability ledger |
| `roadmap.md` | Delivered changelog (Waves 0–2), resolved open decisions, Wave 3 + daemon, doc-maintenance checklist |
| `operations.md` | **Runbook** — start/monitor/kill a run, herdr, the lead-kill drill, common failures + fixes, concurrent-run rules |
| `packaging.md` | Wave 3: kit extraction, deployment to new repos, global ledger, upgrade protocol |

## Operating the system? (Wave 2 is live)

Read, in order:

1. `../../.claude/skills/hydra-protocol/SKILL.md` — the lead's run loop
2. `operations.md` — the runbook (start/monitor/kill, herdr, recovery drill, failure modes)
3. `task-result-review-contracts.md` — the task/result/review/integration contracts
4. `vendor-adapters.md` — the four heads, capability ledger, allocation

## Re-installing from scratch or learning how it was built?

`wave0-implementation.md` is the frozen bootstrap record (historical). For a new
repo, the `hydra-setup` skill supersedes it (Wave 3 / `packaging.md`).

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
controlled A/B against a single-branch baseline — see `../hydra-reports/wave2-exit-report.md`.
