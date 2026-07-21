# Hydra-Swarm — Dispatch Modes

The authoritative, per-mode reference (v0.6.8.3). Each mode below is described
the same way: what it is for, the exact command, what the harness does, what
state it writes, what the worker/vendor sees, how it is observed, how it
terminates, and how it fails. The runbook flow lives in `operations.md`; the
contracts in `task-result-review-contracts.md`.

Every `kit/hydra/scripts/<name>.sh` entry point is a thin launcher: it sources
`lib.sh` and execs the TypeScript harness (`kit/hydra-ts/src/<name>.ts` via
`cli.ts`) or the compiled Bun binary, per `HYDRA_HARNESS` (see
`operations.md` § Harness runtime selection). All behavior described here is
the TypeScript harness; the Bash implementation lane is retired.

State paths below are relative to the run directory
`${HYDRA_STATE_ROOT:-${XDG_STATE_HOME:-~/.local/state}/<repo-id>-hydra}/runs/run-<id>/`.

---

## 1. Full worker dispatch — `dispatch.sh`

**Purpose.** Worktree-isolated implementation: run the task's assigned vendor
as an untrusted worker against its own Git worktree and branch, and bridge its
result into the untrusted inbox for later promotion.

**Command.**

```bash
bash kit/hydra/scripts/dispatch.sh <run_id> <task_id> [--background]
```

Foreground by default (blocks until the worker exits, then prints the
`agent_run_id`). `--background` does **not** detach anything: it only makes
the command stop awaiting the worker before printing the `agent_run_id` —
the dispatch supervisor process stays resident in the caller's shell until
the worker finishes. To actually detach, the caller backgrounds the whole
command itself (`nohup … & disown`) — the recommended pattern; see
`skills/hydra-swarm/references/background-dispatch.md`.

**Harness steps, in order.**

1. Read the instantiated spec `tasks/<task>.yaml` (`assigned_vendor`,
   `worktree`, `timeout_minutes` default 45, `spec_version` default 1).
2. **Head availability gate** — a missing vendor CLI fails fast, naming the
   heads that are available and the best eligible substitute. Never
   auto-substitutes; humans re-pin.
3. **Usage-limit cooldown gate** — a vendor with an active machine-global
   cooldown (`~/.local/state/hydra/vendor-cooldowns.json`) refuses to start;
   the error names the reset time.
4. Resolve the adapter runtime (`ts` default; `compiled` inside the binary;
   `bash` rejected) and the worktree (must already exist —
   `create-worktree.sh` first).
5. **Claim a unique attempt namespace** (v0.6.8.3, issue #31): attempt 1 is
   `<run>-<task>-v<spec_version>`, retries append `-a2`, `-a3`, …. The
   ordinal is derived from the maximum evidenced by ledger, inbox, session
   artifacts, and promoted results, then claimed by exclusive
   `mkdir inbox/<agent_run_id>` — atomic across processes; gaps never reused.
6. Determine delivery: `HYDRA_DELIVERY=resume` uses the captured prior
   session only when the adapter really supports resume (Claude, Kimi) and
   the session vendor matches; otherwise cold-start with a loud
   `delivery_downgraded` event (`no_prior_session`, `session_vendor_unknown`,
   `session_vendor_mismatch`, `adapter_resume_unsupported`).
7. Write `task_started` (with `agent_run_id`, `spec_version`,
   `attempt_ordinal`, `dispatch_instance_id`, `delivery`), followed by
   `delivery_downgraded` when applicable.
8. For amended tasks with recorded verdicts: **materialize revision
   evidence** into `.hydra-context/revision-evidence/` (see mode 3), then
   build the worker prompt (spec, ownership boundary, `HYDRA_NODE_BIN` PATH
   fix, compact evidence-manifest metadata, mandatory `amendment_check`
   block when present).
9. Acquire a concurrency slot (`.slots/`, cap `HYDRA_MAX_CONCURRENCY`,
   default `min(16, cores-2)`); waiting emits `concurrency_wait`. Note the
   ordering: `task_started` and evidence materialization happen **before**
   slot acquisition, so a queued task is already `running` in the ledger
   while it waits — `status.sh` flags the ledger-vs-process gap as advisory
   disagreement during this window.
10. Spawn the vendor adapter.

**Vendor asymmetry at spawn.**

| Vendor | Confinement | Invocation shape |
|---|---|---|
| Kimi | **`srt` OS sandbox mandatory** (dies without it — Kimi auto-approves its own tools). Writes confined to worktree + git-common-dir; per-task network allowlist derived from the worktree's own manifests ∪ baseline ∪ spec `network_domains`; preflighted dev environment. | `kimi -p … --output-format stream-json` under `srt` |
| Codex | `workspace-write` sandbox, git-common-dir added as writable root | `codex exec --json -C <worktree> -s workspace-write …` |
| Claude | **No OS sandbox** (`--permission-mode bypassPermissions`); bounded by structure + the post-hoc ownership audit | `claude -p … --output-format json --add-dir <worktree>` |
| OpenCode/GLM | Decoupled background process (pane-hosting breaks its CLI); usage-limit detector active | `opencode run --format json --auto --model <model> …` |

**State written.** Ledger: `task_started`, optional `delivery_downgraded`,
`revision_evidence_*`, `concurrency_wait`, `herdr_pane_started`, and exactly
one terminal event (`agent_exited` / `agent_timed_out` / `agent_cancelled` /
`agent_usage_limited`); nonterminal `agent_loop_suspected/confirmed/cleared`.
Files: `inbox/<agent_run_id>/result.json` (bridged from the worker's
`.hydra-result.json`; derived from git evidence when the worker omitted it),
session captures under `sessions/` (`.cli.jsonl`/`.cli.json`, `.stderr`,
`.events.jsonl`, `.exit` sentinel, `.pid`, `.outcome.json` adapter-outcome
sidecar, pane files), `sessions/supervisor/<agent_run_id>.dispatch.pid`.

**What the worker sees.** Its worktree: the prompt, the read-only
`.hydra-task.yaml` spec copy, the (revise rounds) `.hydra-context/` evidence
bundle, and `HYDRA_NODE_BIN`. The state store is never handed to any worker;
for Codex and Kimi that separation is OS-enforced by their sandboxes, while
for Claude (no OS sandbox) it is structural — the store is simply not
provided — backed by the post-hoc ownership audit
(`trust-and-permissions.md` §2/§11). No worker environment carries push
credentials.

**Observation.** A `herdr` pane per worker (`hydra:<run>:<task>:<vendor>`,
workspace-pinned, ratio `HYDRA_HERDR_PANE_RATIO`): Codex JSONL and Kimi
NDJSON live-tailed, Claude heartbeats, OpenCode gets an observer-only monitor
pane. `HYDRA_HERDR_PANES=0` forces headless hosting. One-shot state:
`status.sh` (mode 6) — the ledger is authoritative, panes are never read as
truth.

**Termination.**
- *Success path:* worker exits → adapter-outcome sidecar consulted →
  `agent_exited` with the real `exit_code`. A structured Claude API error
  (v0.6.8.3, issue #29) synthesizes a failed drop and terminal failure — a
  vendor 429 additionally records `agent_usage_limited` + a machine-global
  cooldown — instead of a fake success.
- *Stall timeout:* `timeout_minutes` with no activity-signature change →
  `agent_timed_out reason=stalled`, worker tree killed, pane closed.
- *Hard cap:* `HYDRA_HARD_CAP_MIN` (default `timeout_minutes × 6`) →
  `agent_timed_out reason=hard_cap`.
- *Cancel:* SIGTERM (from `cancel-task.sh` or the operator) → clean
  `agent_cancelled`, worker tree reaped, pane closed.
- *Loop detector:* `agent_loop_suspected` → confirmation window →
  `agent_loop_confirmed` + auto-cancel via the same clean path
  (`HYDRA_LOOP_DETECTOR=0` disables; Claude excluded — no streaming capture).

**Failure modes.** Hard `die` before any spawn: missing spec/worktree/adapter,
unavailable head, vendor cooldown, retired runtime values. After spawn:
`agent_exited` with `reason=worker_disappeared` (exit 127 → status `failed`),
`adapter_outcome_malformed` / `adapter_outcome_vendor_mismatch` /
`claude_api_error` / `adapter_terminal_failure`. A killed dispatch is safe:
the signal trap records `agent_cancelled` — no dangling `running` task.

---

## 2. Review dispatch — `review-dispatch.sh` (read-only vendor lane)

**Purpose.** The general read-only consultation lane — not just candidate
review. Any "ask another vendor" interaction routes here so it is
pane-hosted, ledger-recorded, and session-captured; raw vendor CLI calls are
forbidden (SKILL.md).

**Command.**

```bash
bash kit/hydra/scripts/review-dispatch.sh <run_id> <review_id> <vendor> <prompt_file> --task <task_id> [--image PATH]
```

`--task` is **required** (v0.6.8.3, issue #32) and strictly parsed before any
state mutation: exactly four positionals, exactly one `--task`, no unknown or
duplicate flags. Task identity is never inferred from the review id's naming;
for a consultation not tied to a real task, pass a dedicated consultation
task id.

**Harness steps.** Validate ids → append `review_started` (`review_id`,
`task_id`, `vendor`) → run the vendor against the **repo root** (no worktree
is created): `codex exec --json -s read-only`, `claude -p …
--output-format json --add-dir <repo>`, `kimi -p … --output-format
stream-json --add-dir <repo>`, `opencode run --agent hydra-reviewer
--format json --auto` → extract the final assistant message → append
`review_completed` (+ `exit_code`).

**Confinement is asymmetric — read-only is the contract, not (for most
vendors) an enforcement.** Only Codex runs under an enforced read-only
sandbox (`-s read-only`). Claude, Kimi, and OpenCode run unconfined: no OS
sandbox scopes them, so at the OS level they could reach arbitrary paths —
including the state store — and OpenCode's `--auto` auto-approves its tools.
Network is available to every reviewer (the vendor APIs require it). The
read-only expectation for non-Codex vendors is enforced by prompt contract
plus the fact that a review has no promotion path — nothing a reviewer
writes can become authoritative.

**State written.** Ledger: `review_started`, `herdr_pane_started`,
`review_completed` — process telemetry only, **never a verdict**. Files:
`sessions/<review_id>.<vendor>.md` (extracted answer, path printed),
`.raw` (full session), `.exit`, `.pid`, `.pane-progress.txt`. No inbox, no
promotion, no worktree.

**What the vendor sees.** The prompt file plus the repo root (and `--image`
dir for visual review). No worktree is created and there is no promotion
path; per the confinement note above, only Codex is OS-restricted to
read-only.

**Observation.** Pane-hosted for **every** vendor — including OpenCode —
directly in the same herdr pane (the decoupled monitor-pane split is a
full-worker-dispatch behavior only), with the same live tails/heartbeat.

**Termination.** Vendor exit. The review timeout
(`HYDRA_REVIEW_TIMEOUT_MIN`, default 15 minutes) applies to the
**pane-hosted path only** (a polling loop that kills the reviewer's process
tree when the sentinel hasn't appeared); the inline no-pane fallback runs
the vendor synchronously with **no timeout** and blocks until it exits.
Raise the timeout for deep analysis briefs — a timeout kill discards the
verdict, though whatever raw output streamed before the kill remains in
`sessions/<review_id>.<vendor>.raw` (and the extracted `.md` may hold a
partial answer).

**Failure modes.** Argument/id validation dies before dispatch; a timed-out
or crashed reviewer leaves `review_completed` with a nonzero/`?` exit code
and no recorded verdict. A finished reviewer — even a clean exit 0 with
approval-sounding text — gates nothing: acceptance requires `record-review`
(below).

**Recording the verdict.** A candidate verdict becomes real only via:

```bash
bash kit/hydra/scripts/record-review.sh <run_id> <task_id> <verdict.json>
```

which validates the verdict and publishes an append-only generation at
`authoritative/reviews/<task>/<seq>-<reviewed_head>.json` (fsynced,
no-replace; the highest valid generation is authoritative; full history is
retained), then appends `review_verdict` (`seq`, `content_sha256`). Rejects:
`schema_invalid`, `task_id_mismatch`, `invalid_reviewed_head`.

**Routing guidance (measured, run 0057 / issue #28).** Route deep
source-grounded *analysis* reviews to **Codex** — in the measured comparison
Codex returned a complete 16.5 KB verdict in ~9 minutes where Kimi timed out
twice (a timeout discards all reviewer work; Kimi lacks code-graph access on
long briefs). Kimi remains a good *implementer*; OpenCode/GLM suits long-diff
second opinions when its endpoint is healthy; cross-vendor stays the rule —
never have a vendor review its own candidate.

---

## 3. Amendment / revise round — `amend-task.sh`

**Purpose.** Versioned spec supersession: the only sanctioned way to
course-correct a task — after a `revise` verdict, a scope change, or new
information. Instructions are ledger events; there is no mid-turn whispering.

**Command.**

```bash
bash kit/hydra/scripts/amend-task.sh <run_id> <task_id> <reason|@file> [resume|restart] [amendment_check|@file]
```

Delivery defaults to `restart`. `amendment_check` is an optional list of
single-line shell assertions (newlines rejected).

**Harness steps.** Verify spec + recorded worktree exist *before* mutating →
bump `spec_version` v→v+1, write `supersedes`, `amendment_reason`,
`delivered_via`, optional `amendment_check` (atomic temp+rename). A
hand-edited `amendment_reason` that differs from the CLI/`@file` argument is
**warned about and then overwritten** — the CLI reason always wins; the
warning names what was lost, so pass the full text via `@file` rather than
editing the spec by hand → refresh the worktree's read-only
`.hydra-task.yaml` so the
sandboxed worker actually sees the amendment → append `task_spec_amended`
(from/to versions, delivery, reason) → **re-dispatch via mode 1** with
`HYDRA_DELIVERY` set.

**State written.** The amended `tasks/<task>.yaml`; `task_spec_amended`; then
everything mode 1 writes for the new attempt (fresh attempt namespace —
`-a2`, `-a3`, …).

**What the worker sees (v0.6.8.3, issue #26).** The amended spec and — when
verdicts are recorded — the file-first evidence bundle
`.hydra-context/revision-evidence/` (`manifest.json`, `latest-verdict.json`,
`unresolved-findings.json`, `evidence.md`; read-only, git-excluded,
sha256-verified, provenance-checked against `review_verdict` events,
hard-budgeted with explicit truncation metadata). The prompt carries only
compact manifest metadata plus, when `amendment_check` is set, a mandatory
verification block the worker must satisfy (with command output) before
declaring `completed`. Verdict history is never inlined into the prompt.

**Observation / termination / failure.** As mode 1, plus:
`revision_evidence_materialized` / `skipped` / `failed` in the ledger; a
bundle required by a `revise` verdict is mandatory (dispatch fails rather
than sending the worker in blind); results claiming a superseded
`spec_version` are rejected at promotion (`stale_spec`). Resume vs restart
follows the vendor-owned semantics in mode 1 step 7. There is no
`HYDRA_MAX_AMENDMENT_ROUNDS`-style cap: rounds end when the operator says so.

---

## 4. Promotion — `promote.sh` (the trust boundary)

**Purpose.** The trust boundary itself: turn an untrusted inbox drop into an
authoritative promoted result, or reject it with a recorded reason. Only
promoted candidates are real.

**Command.**

```bash
bash kit/hydra/scripts/promote.sh <run_id> <task_id> <path-to-inbox-result.json>
```

Exit codes: `0` promoted, `5` rejected (reason in the ledger), `2`
internal/usage error.

**Harness steps and reject codes, in order.** Appends `result_dropped`, then:

| # | Gate | Reject code |
|---|---|---|
| 1 | `result.schema.json` validation | `schema_invalid` |
| 2 | Spec-version freshness | `stale_spec` |
| 3 | Worker-declared `completed` status | `not_completed` |
| 4 | Git evidence: worktree exists, head/base objects exist, head descends from base, branch tip == claimed head, tree committed | `git_evidence` |
| 5 | Non-empty work: head ≠ base, non-empty diff | `no_commit` |
| 6 | Ownership audit against `writable_paths` (adds/deletes/renames both paths/untracked/symlink-escape/submodules; path hygiene) | `ownership_violation` |
| 7 | Sandboxed verification: tracked-policy commands re-run in the candidate worktree, scrubbed env, `NO_NETWORK=1`, per-command timeout | `verification_failed` |

**State written.** On rejection: `result_rejected` (reason + detail); the
worktree is always preserved for forensics. On success:
`authoritative/verification/<task>.json` (observed outcomes),
`authoritative/results/<task>.json` (worker claims + harness observations +
divergence flags), `result_promoted`. Divergence is flagged only when a claim
*contradicts* the harness observation on the same command.

**Observation.** Synchronous and fast; the printed promoted path and the
ledger events are the record. **Termination:** single-shot. **Failure
modes:** the seven reject codes above; a `verify()` crash persists a
diagnostic record and the rejection carries the cause.

---

## 5. Squash + integration — `squash.sh`, `integrate.sh`

**Purpose.** Harness-owned history: collapse an accepted candidate into one
integration-ready commit (workers never rewrite their own history), then
converge candidates serially behind a combined verification gate.

**Commands.**

```bash
bash kit/hydra/scripts/squash.sh <run_id> <task_id>            # per accepted candidate
bash kit/hydra/scripts/integrate.sh <run_id> <task-in-dependency-order>...
```

**What these commands gate on.** `squash` deterministically requires a
**promoted result** (dies on a non-promoted candidate); `integrate`
deterministically requires each task's **squash record**. Neither consults
the review store or `review_verdict` events: the "only a recorded `accept`
proceeds" rule is **lead protocol** (SKILL.md step 6/7), enforced by the
operator's discipline and auditable after the fact from the append-only
review store — not a code-level gate inside these two commands.

**Squash steps.** Requires a promoted result (dies on a non-promoted
candidate). Uses `git commit-tree` to apply the whole base→head diff as one
commit — touches no branch or worktree; the original candidate branch is
preserved for forensics. Writes
`authoritative/results/<task>.squash.json` (`candidate_head`,
`integration_commit`, `source_commits[]`) and appends `squash_created`.
Prints the integration commit SHA.

**Integrate steps.** Creates the integration worktree
(`run-<id>-integration`, branch `hydra-integration/<run>`) from the run's
recorded `base_commit`; appends `integration_started`. Then, serially, in the
operator-supplied dependency order (never alphabetical): cherry-pick each
squash commit → per-candidate smoke verify (`HYDRA_SMOKE_POLICY`, default =
verify policy) → `candidate_integrated`. After all candidates: the
**combined verification gate** (`HYDRA_VERIFY_POLICY`), writing
`authoritative/verification/combined.json` and `combined_verification`.
Prints the final integration HEAD.

**Observation.** Foreground commands; progress is the ledger event stream.

**Termination / failure modes.** Distinct exit codes: `6` — textual conflict
(cherry-pick aborted, `integration_conflict conflict=textual`; stop and
assign resolution); `7` — smoke or combined verification failure
(`integration_candidate_verify_failed` / `combined_verification
status=failed` — "individually clean, jointly broken", the exact failure the
system exists to catch); `5` — malformed squash record. Merge/push of the
integration branch stays human-authorized.

---

## 6. Operational modes — `status.sh`, `cancel-task.sh`, `run-log`, `gc`

### `status.sh` — one-shot task status (read-only)

```bash
bash kit/hydra/scripts/status.sh <run_id> <task_id> [--lines N] [--json]
```

Resolves the **current attempt** (greatest validated ordinal, isolated by
`dispatch_instance_id` — a stale attempt's events can't masquerade), then
reports: ledger-derived state (`running`/`completed`/`failed`/`cancelled`/
`timed_out`/`usage_limited`/`unknown`), `agent_run_id`, vendor, elapsed vs
`timeout_minutes` and `hard_cap_minutes`, advisory dispatch-pid liveness,
ledger-vs-process disagreement warnings, `loop_suspicion`, a progress tail
(default 20 lines), and the last 5 ledger events. `completed` means the
process ended — check `exit_code` for success. Writes nothing.

### `cancel-task.sh` — the only supported clean cancel

```bash
bash kit/hydra/scripts/cancel-task.sh <run_id> <task_id> [--wait-seconds N]
```

Resolves the *dispatch* process (pidfile, or validated process discovery for
a still-queued task; dies if ambiguous), sends SIGTERM, polls the ledger for
the dispatcher's own terminal event, escalates to SIGKILL (identity
re-validated first) only as a last resort. Never writes the ledger itself —
the dispatcher's trap records `agent_cancelled`. Outcomes: `already_terminal`
/ `terminated` / `terminated_after_kill`; a dispatcher that died without a
terminal event raises an ORPHAN error rather than fabricating one. Never
`kill -9` a dispatch directly.

### `run-log` — the per-run audit document

```bash
bash kit/hydra/scripts/run-log.sh <run_id> [--out DIR] [--json]
```

Renders the run's full lifecycle from ledger + authoritative state to
`docs/hydra-dev-logs/run-<id>.md` (`--out`/`HYDRA_DEV_LOG_DIR` override):
per-task dispatch attempts, promote outcomes with rejection reasons, reviews
(distinguishing **reviewer completed** / **verdict recorded** / **verdict
pending**, from the append-only store — never from process telemetry),
squash/integration, reaps, usage, explicit "(none recorded)" gaps, and a
ledger-anomaly section. Injection-safe (strict id validation, canonical
paths, symlink refusal, control-byte neutralization). Run it **before** gc:
document, then delete.

### `gc` — ledger-proven worktree reaping

```bash
bash kit/hydra/scripts/gc.sh [--apply] [--keep-last N] [--default-branch REF] [--json]
```

Dry-run by default; `--apply` required to mutate. Reaps a worktree+branch
only when the ledger **proves** integration: authoritative result + recorded
integration SHA reachable from the default branch, proof paired to the
current candidate head through the same squash-record evidence chain, clean
tree beyond known junk, path validated against `git worktree list`,
revalidation before each destructive op, atomic compare-and-delete
(`git update-ref -d <ref> <expected-sha>`). Every removal appends
`worktree_reaped` (or `worktree_reap_partial` with rerun recovery). Fails
closed: PR-squash-merged worktrees are unprovable by design and stay for
manual removal; the default branch is never guessed. `--keep-last 3` at run
close covers amend/re-entry flows.
