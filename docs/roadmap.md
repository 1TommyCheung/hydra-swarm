# Hydra-Swarm — Roadmap

**Status:** Wave 2 operational since 2026-07-13. Waves 0–2 delivered; the front of
the roadmap is now packaging (Wave 3) and the hardening daemon. This file is a
*delivered changelog + forward plan*, not a design proposal — see
`docs/hydra-reports/` for the per-wave evidence.

## Delivered (Waves 0–2)

Dates are the day the wave's exit criteria were met in this repo.

### Wave 0 — evidence-gated integration loop · 2026-07-12
- Trust boundary (`promote.sh`): schema → git evidence → ownership audit →
  sandboxed verify → promote. Six rejection unit tests + a positive control.
- Claude + Codex subprocess adapters; worktree/branch lifecycle; harness-created
  squash; serialized cherry-pick integration + combined gate.
- **Hypothesis run (0002)** caught a planted semantic conflict at the combined
  gate that each candidate passed alone. See `wave0-completion.md`.
- Deviations recorded during the build: workers write `.hydra-result.json` in
  their own worktree (the adapter bridges it — workers never touch the state
  store), not into the inbox; a NUL glob sentinel bash silently drops; a linked
  worktree's git metadata lives in the git-common-dir *outside* the worktree.

### Wave 1 — intelligence and resilience · 2026-07-13
- GitNexus post-freeze indexes + manifests + freshness gate; `graph-impact.sh`
  as advisory-only risk input. **Deviation:** the harness index is built with
  `gitnexus analyze --skip-agents-md --skip-skills --name` (registers without
  mutating tracked files); `--index-only` was wrong (it also skips registration,
  leaving nothing to query).
- Versioned `resume()` amendment (`amend-task.sh`): v1→v2 with stale-version
  rejection, exercised end-to-end in run 0004. **Deviation:** Kimi/Codex have no
  true session resume, so delivery is cold-restart (the spec anticipated this).
  **Known gap:** the substantive spec edit is a hand edit before the version
  bump, so the amendment *content* is not fully reconstructable from the ledger
  (see the drift note in `architecture.md` §4.6).
- Risk-triggered cross-vendor review policy (`review-policy.yaml`,
  `review-required.sh`), formalized from Wave 0 convention.
- Timeouts, concurrency cap, budget accounting as ledger events (`dispatch.sh`,
  `record-usage.sh` → `agents/usage.jsonl`).
- Standing lead-recovery drill (`recovery-drill.sh`, 3/3).
- **OpenCode (GLM 5.2) adapter** — read-only explorer + long-diff reviewer.
  **Deviation:** the working model id is `zai-coding-plan/glm-5.2` (not
  `zhipu/glm-5.2`); the correct headless invocation is `opencode run --format
  json --auto`.
- Conditional `wave_1` bootstrap (gitnexus analyze), gated on `hydra/WAVE`.

### Wave 2 — all four heads + adaptive orchestration · 2026-07-13
- **Kimi K2.7 adapter** — visual_debugging + contained implementation under a
  macOS `sandbox-exec` confinement. **Deviations:** `kimi -p` already
  auto-approves tools (so `-y` is rejected *and* the OS sandbox is mandatory);
  the sandbox must allow `/dev/null` (git/bash open it) and the herdr socket dir.
- Graphify baseline + **investigation-not-verdict** policy
  (`graphify-baseline.sh`, `graphify-investigate.sh`): EXTRACTED edges open a
  blocking investigation, INFERRED/AMBIGUOUS are review questions only.
  **Deviations:** edges live under `.links` (networkx node-link JSON) with
  `confidence: EXTRACTED|INFERRED|AMBIGUOUS`; the semantic pass needs an LLM key
  (a Kimi coding-plan key works via an in-memory base-URL + `kimi-code-cli`
  User-Agent patch — installed package untouched).
- Live capability profiles (`aggregate-usage.sh` writes the `measured` class;
  four canonical seed profiles) + `allocate.sh` (recommend-only, human-gated).
- Observability: **herdr installed mid-wave → Layer-1 became real**. Ledger web
  renderer Layer-2 (`ledger-view.sh`), ledger-vs-live reconciliation emitting
  `observability_anomaly`, pane-hosted dispatch **and** reviewers
  (`review-dispatch.sh`). OTel export config is build-with-note (no collector).
  **Deviation:** the herdr vendor integrations only hook *session* lifecycle
  events, which never fire for one-shot `exec`/`-p` workers, so the harness
  pushes pane state itself (`hydra_herdr_state`).
- Automated routing *recommendations* (`allocate.sh`) — never automatic pins.

### Post-Wave-2 hardening found by operating the system (this session)
- **Two new trust-boundary gates** surfaced by pane-hosting a real run:
  `no_commit` (head == base / empty diff — work left uncommitted, §2.1) and
  `not_completed` (a worker-declared `failed` drop must never promote). Boundary
  suite 6 → 9 cases.
- **Empty-objective bug** (highest-value fix): `build-worker-prompt.sh` read the
  YAML block-scalar objective with a same-line accessor, so every worker prompt
  carried an *empty* objective and only the acceptance criteria. Fixed with
  `hydra_yaml_block`. It masqueraded as three separate vendor failures.
- Dispatch signal-safety: killed dispatches now record `agent_cancelled` and
  reap the whole worker tree (no dangling `running` tasks, no orphaned agents).

## Resolved open decisions (from ledger evidence, 2026-07-13)

1. **External state root** — `~/.local/state/` remains the default; overridable
   via `HYDRA_STATE_ROOT`. *Unchanged; re-affirmed.*
2. **GLM 5.2 promotion to implementer** — **RESOLVED: promoted, availability-
   gated.** GLM took a real write role (`opencode.json` `hydra-implementer`
   profile, `opencode.sh start`). It works when the endpoint is healthy; the
   Z.AI coding endpoint returned transient 500s during run 0015 (the exact
   config succeeds on retry). Route around unavailability via `allocate.sh`.
3. **Kimi write-role policy** — **RESOLVED: write role allowed under a full OS
   sandbox only.** Kimi implements well greenfield/contained (run 0006 debounce,
   0009 hi) but is weak at *revise-existing* refactors (run 0015 v3/v4 no-ops —
   partly the empty-objective bug, partly its seed weakness). Keep it off
   subtle refactors; prefer it for fresh contained modules and visual_debugging.
4. **Scorecard-driven allocation** — **RESOLVED: recommend-only, human-gated.**
   `allocate.sh` recommends, never auto-pins; uses `measured` at n≥8 else seeded
   priors. Current n is still small (Claude 5, Codex 4, Kimi 3), so seeded
   priors drive allocation today — as designed.
5. **Graphify graph: run-scoped vs committed** — **run-scoped external artifact**
   (default kept); stored under `indexes/graphify/<repo-id>/run-<id>/`.
6. **Minimum integration gate commands per project** — *still open*; Wave 0–2
   projects set them per run via `HYDRA_VERIFY_POLICY` / the task `verification:`
   list. A tracked per-project floor is a Wave 3 packaging item.
7. **Retention of external run state / worktrees** — *still open*; nothing is
   auto-pruned yet (15 runs retained). Revisit at packaging.
8. **Local-branch-only vs PR preparation** — *still open, local-branch-only
   holds.* All integration branches stay local; merge/push is human-authorized.
9. **Daemon trigger** — *still open.* The protocol boundary held through Wave 2;
   the daemon is justified by team size > 1 lead or a multi-tenant state store.

## Now: the front of the roadmap

### Wave 3 — packaging (`packaging.md`)
Kit extraction, deployment to a second repo, global ledger, upgrade protocol.
The `hydra-setup` skill supersedes `wave0-implementation.md` for new installs.

### Hardening milestone — harness daemon
Replace the Wave 0 privileged-lead protocol boundary with a real capability
boundary: a local daemon owning the state directory under separated privileges,
exposing narrow operations only:

```text
create-run · register-task · record-dispatch · promote-result
record-verification · record-review · close-run
```

The lead gets read-only promoted views and cannot write ledger files. Because
every mutation already flows through script interfaces (`run-init`, `promote`,
`squash`, `integrate`, `record-review`, `record-usage`, `amend-task`), this
migration changes the *owner* of the scripts, not their callers.

### Later enhancements
- Standalone `hydra` CLI (moves the caller; scripts/schemas/state survive).
- OpenCode **warm server** (`opencode serve` + `--attach`) for TUI-free, cold-
  start-free reviewer/implementer runs (vendor-adapters §4).
- MCP-based adapters; Agent-SDK adapters for programmatic permission callbacks.
- herdr as the default Layer-1 monitor for every run; a live OTel collector.
- Amendment *content* recorded to the ledger so `resume()` is fully
  reconstructable (closes the §4.6 drift gap).
- Verification against a clean checkout of `head_commit` rather than the dirty
  worktree, so untracked files cannot influence the gate (closes the drift the
  `no_commit` gate only partially covers).
- Ownership-audit case-collision check (trust §5) — currently omitted.
- Design references to track, not adopt wholesale: **gnap**, **wit**,
  **swarm-protocol**, **MartinLoop** (run-receipt benchmark for exit reports).

## Success criteria (cumulative) — status at Wave 2 exit

| # | Criterion | Status |
|---|---|---|
| 1 | Wave 0 exit criteria | ✅ `wave0-completion.md` |
| 2 | Replacement lead resumes from Git + state store alone | ✅ standing drill 3/3 + Codex-led reconstruction (run 0006) |
| 3 | No agent-reported verification is ever the sole basis for acceptance | ✅ harness re-runs `verify.sh` every promotion |
| 4 | Spec amendments reconstructable; results match latest version | ⚠️ version + stale-reject ✅; amendment *content* not yet ledgered (later enhancement) |
| 5 | Ownership violations caught at the audit even when hooks bypassed | ✅ boundary tests 3/4; +`no_commit`/`not_completed` gates |
| 6 | Graph evidence never independently blocks or approves | ✅ GitNexus advisory + Graphify investigation-not-verdict |
| 7 | Per-vendor `claim_vs_verified_divergence` measured | ✅ Claude 0.20 (n=5), Codex 0.00 (n=4), Kimi 0.00 (n=3) — small n |
| 8 | A Codex-led run succeeds | ✅ Codex reconstructed run 0006 and drove the next step from the ledger |

## Doc-maintenance checklist (run at each wave exit)

The system's rule is *evidence over claims*; the docs obey it too. At each wave
exit, before tagging:

- [ ] **README** — bump version/status; state the hypothesis verdict with the
      run id + measured numbers it rests on.
- [ ] **roadmap** — move the wave from planned → delivered with a date and
      *deviations + why*; resolve or re-date open decisions from ledger evidence.
- [ ] **vendor-adapters** — re-verify both matrices against current vendor docs;
      bump `last_verified`; annotate seeded priors with `measured` (n, rate) or
      retire them.
- [ ] **wave<N>-implementation** — freeze as historical; do not rewrite (destroys
      provenance).
- [ ] **normative docs** (architecture, trust, state, contracts, code-
      intelligence) — drift audit: reconcile each claim against
      `hydra/scripts/` reality; fix the code or amend the doc, never leave them
      silently disagreeing. Prefer running the audit *as a hydra review* (a
      whole-repo docs-vs-code analysis, findings gated by a human).
- [ ] **exit report** — snapshot exit criteria + ledger proof + measured stats +
      hypothesis verdict + known limitations into `docs/hydra-reports/`.
- [ ] **operations** — update the runbook for any new failure modes or env vars.
