# Post-v0.6.8.3 plan — Run D onward

**Status:** planning handoff, written 2026-07-21 against the **v0.6.8.3
baseline** (tag `v0.6.8.3`; code baseline `82d85e6` at time of writing; the
tag's delivered code scope is recorded in `docs/roadmap.md` § "Revise-loop
fidelity + truth of record (v0.6.8.3)"). Nothing below has started, and none
of the designs sketched here are approved — each run still needs its own
task specs, operator sign-off, and the normal evidence-gated pipeline.

> **Naming note (read this first).** "Run D", "Run E", etc. are the
> operator's **roadmap labels** for a planned sequence of work packages.
> They are *not* promises about numeric Hydra run IDs — Run D may execute
> as Hydra run 0066 or 0071 or as two numeric runs; the letters only fix
> the *order and grouping* of the work. Ledger evidence always refers to
> numeric run IDs; this document only refers to letters.

## Release recovery boundary (recorded 2026-07-21)

This section is durable historical context: it stays accurate after the
release retry succeeds, because it records what happened on the *first*
attempt and the gate Run D waited behind.

- The `v0.6.8.3` tag's **first release-workflow attempt passed the Linux
  and macOS native verification gates but failed the Windows gate, and
  therefore published no GitHub release.** As of this document's writing,
  v0.6.8.3 is a tagged code baseline, not a published release — statements
  elsewhere that describe the v0.6.8.3 scope describe merged code, not a
  completed release.
- **Run 0065** (the numeric corrective/planning run that produced this
  document) contains the **central Windows compiled-path correction** for
  that failure.
- **Run D must start only after a fresh tag workflow passes all three
  native OS gates (Linux, macOS, Windows) and publishes the GitHub
  release.** Release recovery is the hard predecessor of everything in this
  plan; the lettered sequence below assumes it is complete.

Referenced issues (all links are to this repo's tracker):

| Issue | Title (abbreviated) | State | Planned home |
|---|---|---|---|
| [#22](https://github.com/1TommyCheung/hydra-swarm/issues/22) | `integrate.sh` targets the run's frozen `base_commit`, breaking sequential/dependent tasks | open | **Run D** |
| [#28](https://github.com/1TommyCheung/hydra-swarm/issues/28) | Review lane: Kimi never converges on source-grounded briefs; timeout discards all work | open | **Run E** (two phases) |
| [#33](https://github.com/1TommyCheung/hydra-swarm/issues/33) | Codex/OpenCode adapters: real amend-task session resume | open | **Run F (recommended)** |
| [#25](https://github.com/1TommyCheung/hydra-swarm/issues/25) | OpenCode cooldown: operator-approved provider/model swap | open | Later |
| [#24](https://github.com/1TommyCheung/hydra-swarm/issues/24) | Research: durable, structured, vendor-agnostic agent session logs | open | Later (research/design first) |

---

## Runs A–C — completed context (do not reopen)

Runs A–C were the operator's labels for the pre-release fix campaign whose
code scope is now the v0.6.8.3 baseline (executed across Hydra runs
0057–0062; full delivered record in `docs/roadmap.md`, tracked per-run audit
logs in `docs/hydra-dev-logs/`). The operator's historical mapping, exactly:

- **Run A:** [#29](https://github.com/1TommyCheung/hydra-swarm/issues/29)
  (Claude API-error truth; closed), then
  [#31](https://github.com/1TommyCheung/hydra-swarm/issues/31) (unique
  dispatch-attempt identity; closed).
- **Run B:** the two **parallel #30 hardening lanes**
  ([#30](https://github.com/1TommyCheung/hydra-swarm/issues/30), closed) —
  the bounded-renderer lane and the durable-review-store lane.
- **Run C:** [#26](https://github.com/1TommyCheung/hydra-swarm/issues/26)
  completion plus [#32](https://github.com/1TommyCheung/hydra-swarm/issues/32)
  append-only review provenance (both closed), integrated after Run B.

Alongside the lettered runs, three further pieces landed as **separately
named release-completion work — not assigned to any letter**: the six-target
native binary release matrix, real Kimi same-vendor session resume
(completing [#20](https://github.com/1TommyCheung/hydra-swarm/issues/20),
with the vendor-owned `delivery_downgraded` resume semantics), and the
status/launcher time-stability fixes.

All of the above is **merged and done as code**. This plan does not reopen,
re-scope, or re-verify any of it; where a later run touches the same code
(e.g. #33 extends the release-completion resume semantics), the delivered
contracts are treated as fixed constraints, not as material to renegotiate.
The one open remainder of the campaign is the release publication itself —
see the release recovery boundary above.

---

## Run D — incremental integration within a run ([#22](https://github.com/1TommyCheung/hydra-swarm/issues/22))

### Problem being solved

`integrate.ts` always creates the integration worktree/branch from the run's
frozen `run.yaml` `base_commit`. For a run of *sequential, dependent* tasks
(task 2 deliberately based on task 1's already-integrated result), every
integration after the first fails with a generic `TEXTUAL CONFLICT … stopped`
even though the change applies cleanly onto the actual current target. This
was observed in run 0052 **as recorded in issue #22 and the operator's
account** (run 0052 has no tracked log under `docs/hydra-dev-logs/`; the
issue is the citable record): the manual cherry-pick onto current `master`
succeeded, confirming the diff was fine and only the target selection was
wrong.

### Scope

1. **Incremental targeting:** when `hydra-integration/<runId>` already exists
   from a prior integration in the same run, integrate onto its **tip**
   instead of recreating the branch from the frozen `base_commit`.
2. **Explicit override:** an `--onto <commit>` flag for the operator to name
   a target when the automatic choice is wrong or the branch state is
   ambiguous. The override must be recorded in the ledger event, not silent.
3. **Diagnosable failures:** the conflict message must distinguish
   "base/target mismatch — your change likely applies cleanly onto the real
   target" from a genuine semantic/textual conflict, since the two demand
   opposite operator responses.

### Safety invariants (must hold before and after)

- The **combined verification gate** still runs against the final
  integration tip — incremental targeting must never let a task skip the
  gate because "an earlier tip already passed."
- Integration **never auto-advances onto `master`** or any default branch;
  local-branch-only integration and human-authorized merge/push remain the
  standing policy, unchanged.
- Every integration ledger event records the **actual commit integrated
  onto** (not the frozen `base_commit`), so the run remains reconstructable.
- **`hydra gc`'s proof chain survives.** `gc` reaps worktrees only when the
  recorded integration SHA is reachable from the default branch and the
  proof pairs to the current tip through the squash-record evidence chain.
  Changing what `integrate` targets must not orphan that pairing — this is
  the single most likely place for a subtle regression (see Risks).
- Cherry-pick content, squash construction, and the trust boundary
  (`promote`) are untouched — #22 is explicitly *not* a trust-boundary
  issue; only target selection changes.

### Tests

- New fixture: a run with **two sequential dependent tasks** where task 2's
  diff only applies after task 1 is integrated — fails on the current code,
  passes with incremental targeting (the shape issue #22 records from
  run 0052, reproduced as a fixture).
- Regression: the existing independent-tasks-shared-base shape still
  integrates and still runs the combined gate.
- `--onto` override: accepted, validated (must be a real commit; refuse
  garbage), and stamped into the ledger event.
- Failure-message test: a genuine conflict and a base-mismatch produce
  distinguishable messages.
- `hydra gc` end-to-end against an incrementally-integrated run: reaping
  still requires the full evidence chain; no false reap, no false keep.
- Full existing suites (`npm test` in `kit/hydra-ts`, promote boundary
  suite, black-box compiled suite) stay green.

### Integration strategy

Single lane, single implementer, cross-vendor review required (integration
targeting is squarely inside the evidence chain, so this is a
risk-triggered-review change per `review-policy.yaml` conventions). Land as
one reviewed squash; verify with a real supervised sequential-task shakedown
run before closing the issue.

### Stop conditions

- If a correct fix turns out to require changing `run.yaml` `base_commit`
  semantics, promote/trust-boundary behavior, or the squash-record format,
  **stop and split** — that is a bigger design than #22 authorizes.
- If `gc`'s evidence pairing cannot be kept sound under incremental
  targeting without redesigning the squash-record chain, stop, document, and
  bring the design back to the operator.

### Dependencies, gates, risks, out of scope

- **Dependencies:** the **release recovery boundary above** — Run D starts
  only after a fresh tag workflow passes all three native OS gates and
  publishes the v0.6.8.3 release. Beyond that, none — Run D is first in the
  lettered sequence precisely because it unblocks the sequential-task run
  shape that Runs E/F will likely use.
- **Acceptance gates:** the new sequential fixture passes; `gc` end-to-end
  passes; combined gate demonstrably runs on the final tip; the issue-#22
  failure shape reproduced then fixed; cross-vendor review verdict recorded.
- **Risks:** silently breaking `gc`'s reachability proof (worst case:
  deleting a worktree whose work never landed); ledger events that no longer
  reflect the true integration target; conflating "branch exists from a
  *previous generation* of the run" with "branch exists from this run's
  earlier task."
- **Out of scope:** auto-merge to `master`, PR-mode integration, any change
  to promote/verify, retrying conflicts automatically, multi-run shared
  integration branches.

---

## Run E — review-lane convergence and timeout truth ([#28](https://github.com/1TommyCheung/hydra-swarm/issues/28))

Issue #28 bundles two different kinds of work. Run E deliberately splits
them, **terminal semantics first**, because phase E1 changes what the ledger
records and phase E2's experiments are only measurable once timeouts stop
destroying their own evidence.

The motivating evidence throughout this section is the run-0056 incident
**as recorded in issue #28's forensic analysis** (run 0056 has no tracked
log under `docs/hydra-dev-logs/`; the issue's tables are the citable
record): two Kimi review attempts at 15- and 45-minute caps produced 531 and
734 bytes with zero verdict content, while Codex completed the identical
brief in ~9 minutes with a 16.5 KB verdict.

### Phase E1 — terminal-state and partial-artifact foundations (first)

**Scope:**

1. A distinct, machine-readable **`review_timed_out` terminal ledger state**
   for a reviewer killed at the cap — replacing today's `exit_code:"?"`
   with-no-artifact. Mirrors the `agent_usage_limited` precedent from
   v0.6.8.1.
2. **Partial-artifact capture on timeout:** whatever the reviewer produced
   (streamed output, on-disk notes) is recorded alongside the timeout event
   instead of discarded. Per issue #28, ~50 minutes of Kimi reading in the
   run-0056 incident yielded zero retained bytes — that must become
   structurally impossible.
3. **Raise the review timeout default** (`HYDRA_REVIEW_TIMEOUT_MIN`,
   currently 15) and/or scale it by brief size. Issue #28's measurements
   (Codex ~9 minutes on a brief Kimi couldn't finish in 45) show 15 is too
   low for any source-grounded review. (Matches the standing operational
   note: raise the review timeout; timeouts discard all work.)
4. Optionally, prompt reviewers for an **incremental verdict** the tail can
   capture, so a kill still yields a partial verdict rather than narration.

**Acceptance gates:** a deliberately-timed-out review produces a
`review_timed_out` event plus a non-empty captured artifact; `run-log`
renders the state distinctly; no change to verdict authority (a partial
artifact is *evidence for the operator*, never an authoritative verdict).

**Risks:** treating a captured partial as a real verdict (must be clearly
labeled non-authoritative); interactions with the append-only review store
from #32 (a timeout must not publish a generation).

**Out of scope for E1:** any routing or prompt-strategy change; anything
that alters who reviews what.

### Phase E2 — reading-strategy brief and capability-aware routing (second)

**Scope:**

1. **Reading-strategy preamble** in the review brief for vendors without
   code-graph tooling: batched line-ranged extraction (multiple ranges per
   shell call), a no-re-read rule, a **hard synthesis checkpoint** ("after
   at most ~6 files, write the verdict table before any further reading" —
   the single highest-value line against the never-converges failure), and
   bounded symbol/line-range file lists when the lead already knows them.
2. **Capability-aware heads:** extend `detect-heads` to record per-vendor
   code-intelligence availability (e.g. gitnexus MCP configured) in
   `heads.json`; let `allocate` *prefer* code-graph-capable heads for
   multi-file cross-referencing review; have `review-dispatch` **warn** when
   a source-grounded brief is routed to a vendor without it.
3. **Never auto-substitute** — standing policy. Warn and let the operator
   re-pin; nothing reroutes on its own.

**Acceptance gates:** heads.json carries the capability field; the warning
fires on the issue-#28 shape (source-grounded brief → no-code-graph vendor);
a re-run of a Kimi source-grounded review with the new brief either
converges to a verdict or times out *with* a captured partial (E1) —
measured, not asserted.

**Risks:** the reading-strategy brief is a prompt intervention with no hard
guarantee (measure it; don't claim it); over-weighting the capability flag
in `allocate` beyond "prefer" into de-facto auto-substitution.

**Out of scope for Run E:** configuring MCP for Kimi itself (an environment
change, not a harness change — worth doing, but it is operator machine
setup); any automatic vendor substitution; general dispatch-lane (worker)
prompt changes.

**Dependencies:** E2 depends on E1 (measurement needs surviving artifacts).
Run E benefits from Run D if executed as sequential dependent tasks in one
run, but does not strictly require it.

---

## Run F (recommended) — Codex/OpenCode session resume ([#33](https://github.com/1TommyCheung/hydra-swarm/issues/33))

Follow-up split from #20. Kimi's same-vendor resume is **done** — it landed
as v0.6.8.3 release-completion work completing #20 — and is explicitly
excluded here. Run F gives Codex and OpenCode real `amend-task` session
resume; until then both correctly downgrade loudly via `delivery_downgraded`
(`adapter_resume_unsupported`).

### Structure: two adapter lanes + a shared contract

- **Lane 1 — Codex adapter resume:** implement real same-vendor session
  resume in `adapter-codex`, flip its compiled-adapter `resume` capability
  flag, focused adapter tests, plus an end-to-end amend-task resume
  exercise.
- **Lane 2 — OpenCode adapter resume:** the same for `adapter-opencode`
  (note OpenCode sessions ride `opencode run`'s session model; the warm-
  server idea in `docs/roadmap.md` § Later enhancements is *not* part of
  this).
- **Shared-contract integration guidance (binding on both lanes):**
  - Effective delivery stays decided by **adapter capability + captured
    session vendor** — the vendor-owned resume-semantics contract delivered
    as v0.6.8.3 release-completion work. A vendor change or an
    untrustworthy/absent prior session still cold-restarts, loudly, via the
    existing `delivery_downgraded` reasons (`no_prior_session`,
    `session_vendor_unknown`, `session_vendor_mismatch`).
  - The **file-first revision-evidence contract from #26 stays intact**: a
    resumed session still receives the materialized
    `.hydra-context/revision-evidence/` bundle; resume is a delivery
    optimization, never a substitute for the evidence bundle.
  - Both lanes converge on the same capability-flag/session-capture
    interfaces; if the two vendors' session models force divergent
    contracts, stop and reconcile the shared contract first rather than
    shipping two ad-hoc shapes.

### Dependencies, gates, risks, out of scope

- **Dependencies:** none hard beyond the release recovery boundary that
  gates the whole lettered sequence; recommended **after** Run E so
  review-lane fixes aren't competing for the same adapters mid-change, and
  because two parallel lanes + shared contract is exactly the shape Run D's
  incremental integration makes pleasant.
- **Acceptance gates:** per-vendor focused tests; one real end-to-end
  amend-task resume exercise per vendor (v1 dispatch → amend → v2 resumed
  in-session, verified from the ledger and session capture, not vendor
  claims); downgrade paths re-verified unchanged; Kimi untouched.
- **Risks:** vendor CLIs' resume semantics are less documented than Kimi's
  `-S` and may silently cold-restart while claiming resume — the exercise
  must verify continuity from evidence (e.g. the session referencing
  v1-only context), not exit codes; session-capture identity mistakes could
  resume the *wrong* session, which is worse than cold restart.
- **Out of scope:** Kimi (complete under #20); cross-vendor resume (a
  vendor change always cold-restarts, by design); the OpenCode warm-server
  enhancement; any change to amendment versioning or stale-version
  rejection.

---

## Later — operator-approved OpenCode provider/model swap ([#25](https://github.com/1TommyCheung/hydra-swarm/issues/25))

Queued behind Runs D–F. `enforceVendorCooldown` currently refuses any
OpenCode dispatch when *any* cooldown matches the vendor, even though
OpenCode alone routes equivalent models through multiple independent
provider credential/quota pools (`zai-coding-plan` vs `openrouter` —
separate accounts and rate-limit pools, with unused OpenRouter credit, per
the live checks recorded in issue #25).

**The change is operator-approved switching — there is no automatic reroute,
and that is the design, not a limitation:**

- On a non-`openrouter` OpenCode provider cooldown with a configured,
  non-cooled OpenRouter route available, surface a **real operator decision
  point** (re-pin to the equivalent OpenRouter route / pick a different
  OpenRouter model / wait) instead of dying silently.
- **Non-interactive dispatch fails closed exactly as today.** No operator
  attached → the existing cooldown death, unchanged.
- Whatever the operator picks must land as an **explicit `opencode_model`
  pin written into the task spec** before dispatch proceeds (mirroring how
  `amend-task` re-pins `assigned_vendor`); hydra performs only the
  mechanical re-dispatch after a human sets the pin.
- **Out of scope (from the issue, restated as binding):** any automatic
  reroute or retry; extending this to Claude/Codex/Kimi (single-provider
  today); balance-based auto-selection ("prefer whichever has more credit"
  is an auto-decision, which is exactly what's banned).

**Dependencies:** none on D–F technically; sequenced later because it is an
ergonomics improvement, not a correctness fix. **Gate:** the decision point
demonstrably blocks until a human chooses; the pin is visible in the task
spec and ledger. **Risk:** the prompt path must not become an auto-path
under any flag combination.

---

## Later — session-log governance research ([#24](https://github.com/1TommyCheung/hydra-swarm/issues/24))

**This is a research-and-design exercise, not an implementation task.** It
must produce a design (and sized task specs) *before* any code is written —
the same shape as the usage-limit-detection scoping (parallel vendor
research + synthesis review). The run-0056 incident as recorded in issue #28
is the concrete motivating case: that incident was analyzable only by
hand-parsing Kimi's native NDJSON.

Questions the research pass must answer:

1. **Schema:** is there a workable common structured record per significant
   agent action — something like `{timestamp, actor, action_type,
   rationale, evidence_refs}` — that all four vendors' native transcript
   shapes (OpenCode NDJSON events, Codex/Kimi rendered-`.md`-plus-`.raw`,
   Claude's buffered exit-time JSON) can be normalized into without losing
   what made the raw files audit-useful?
2. **Agent-emitted structure:** can agents be prompted to emit a parallel
   structured decision log during a run (beyond the final
   `.hydra-result.json`) *reliably* — or does a harness-dictated structural
   requirement need independent verification to be trusted at all (the
   amendment_check class of problem)? This is an open research question;
   the answer may legitimately be "no."
3. **Retention/archival:** `gc` reaps worktrees but never prunes
   `runs/run-<id>/` session data, which grows unboundedly. Design a
   retention policy: compress/move older run sessions to a colder archive
   after N days, keep a lightweight structured index even after raw
   transcripts age out, and decide what accountability requires to persist
   longer than debugging does.

**Gate for the research itself:** a written design with a
schema proposal, a feasibility verdict on agent-emitted logs (with
evidence, not opinion), a retention policy proposal, and a decomposition
into implementable Hydra task specs — reviewed cross-vendor before any
implementation is scheduled. **Out of scope:** writing any normalizer,
schema enforcement, or archiver before that design is approved.

---

## Sequence and dependency summary

```
Release recovery (fresh tag workflow: Linux+macOS+Windows gates pass,
GitHub release published)  ──hard gate──▶  everything below

Run D (#22)  ──unblocks sequential-task runs──▶  Run E, Run F execute nicer
Run E1 (#28 terminal semantics)  ──measurement prerequisite──▶  Run E2 (#28 brief/routing)
Run F (#33)  — recommended after E; two lanes + shared contract
Later: #25 (operator-approved swap) · #24 (research/design before any code)
```

Nothing here is dispatched, designed-final, or approved. Each run starts
from this brief, gets its own task specs against the then-current tip, and
earns its way through the same trust boundary as everything before it.
