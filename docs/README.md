# Hydra-Swarm — Documentation Set

**Version:** 3.1 · **Date:** 2026-07-12 · **Status:** Architectural baseline accepted; Wave 0 ready to implement
**Supersedes:** the single-document specs v1–v3. This document set is self-contained; no prior version is a normative dependency.

## What this is

**Hydra-Swarm**: a local multi-agent software development system. One lead (the *head* — Claude Code) plans and judges; a deterministic harness owns processes, state, and verification; heterogeneous coding agents (the *swarm* — Claude Code, Codex/GPT‑5.6 Sol, OpenCode/GLM 5.2, Kimi K2.7 Code) implement in isolated Git worktrees; accepted work converges through a controlled integration worktree behind evidence gates. Cut off the head and a new one grows from Git + the state store — lead replacement is a design guarantee, not a recovery hack.

## Naming conventions (canonical)

| Artifact | Name |
|---|---|
| System | Hydra-Swarm |
| Tracked repo directory | `hydra/` |
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
| `roadmap.md` | Waves 1–2, later hardening (harness daemon), open decisions |
| `packaging.md` | Wave 3: kit extraction, deployment to new repos, global ledger, upgrade protocol |

## Implementing Wave 0?

Read, in order:

1. `architecture.md`
2. `wave0-implementation.md`
3. `trust-and-permissions.md`
4. `task-result-review-contracts.md`

**Do not implement Wave 1 or Wave 2 functionality.** In particular: no GitNexus, no Graphify, no capability profiles, no OpenCode/Kimi adapters, no monitors, no OTel. Wave 0 is Claude + Codex workers and the core evidence-gated integration loop only.

## Central hypothesis (what Wave 0 must prove)

> A lead-orchestrated, worktree-isolated, evidence-gated integration process produces more reliable combined code than agents operating directly on one branch.

Every Wave 0 scoping decision serves testing this hypothesis with the smallest credible build.
