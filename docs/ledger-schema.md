# Hydra-Swarm — Ledger Schema

The authoritative record of a run is an append-only JSONL ledger at
`runs/run-<id>/authoritative/ledger/events.jsonl` under the state root
(`${XDG_STATE_HOME:-~/.local/state}/<repo-id>-hydra`). One JSON object per
line, written only by the harness (`ledgerAppend` in
`kit/hydra-ts/src/lib.ts`). Readers (`run-log`, `ledger-view`, `status`) treat
every value as data — never executed, always escaped on render — and must
tolerate unknown events and fields (forward compatibility). Malformed lines
are counted as ledger anomalies by `run-log`, never silently dropped.

## Envelope

Every event carries:

| Field | Meaning |
|---|---|
| `time` | ISO-8601 UTC timestamp written at append time. |
| `event` | Event name (see below). |
| `run_id` | The run this event belongs to. |

Task-scoped events additionally carry `task_id`. Identifiers that end up in
filesystem paths follow two distinct grammars (both defined in
`kit/hydra-ts/src/task-id.ts`):

- `task_id` uses the canonical **task-id grammar**: 1-64 characters of
  lowercase `[a-z0-9-]` with no leading/trailing hyphen
  (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, length ≤ 64).
- `run_id` and `review_id` use the bounded **safe-id grammar**:
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

Each is a single path segment: no dots (no `..` traversal), no separators,
no whitespace, hard 64-character bound. Writers validate before append;
readers never construct a path from an id that fails its grammar.

## Core lifecycle events

| Event | Key fields | Emitted by |
|---|---|---|
| `run_started` | `base_commit` | `run-init` |
| `heads_detected` | `available`, `count` | `run-init` |
| `task_started` | `task_id`, `vendor`, `agent_run_id`, `dispatch_instance_id`, `delivery`, `spec_version`, `attempt_ordinal` | `dispatch` |
| `agent_exited` | `task_id`, `exit_code`, `reason?`, `agent_run_id`, `dispatch_instance_id` | `dispatch` |
| `agent_timed_out` / `agent_cancelled` | `task_id`, `reason?`, dispatch ids | `dispatch` / `cancel-task` |
| `agent_loop_suspected` / `agent_loop_confirmed` / `agent_loop_cleared` | `task_id`, details | loop detector |
| `task_spec_amended` | `task_id`, `from`, `to`, `delivery`, `reason` | `amend-task` |
| `result_rejected` | `task_id`, `reason`, `detail` | `promote` |
| `result_promoted` | `task_id`, `head`, `divergence` | `promote` |
| `review_verdict` | `task_id`, `verdict`, `reviewer`, `risk`, `reviewed_head`, `seq`, `content_sha256` | `record-review` |
| `review_rejected` | `task_id`, `reason`, `detail` | `record-review` (invalid verdict) |
| `squash_created` | `task_id`, `integration_commit` | `squash` |
| `candidate_integrated` | `task_id`, `head` | `integrate` |
| `worktree_reaped` | `task_id`, `path` | `gc` |

This table covers the lifecycle that `run-log` renders; it is not exhaustive —
other subsystems append their own events (e.g. `agent_usage`,
`observability_anomaly`, `herdr_pane_started`, `concurrency_wait`), which
appear in the flat timeline.

## Review provenance events

| Event | Key fields | Emitted by |
|---|---|---|
| `review_started` | `review_id`, `task_id`, `vendor` | `review-dispatch` |
| `review_completed` | `review_id`, `task_id`, `vendor`, `exit_code` | `review-dispatch` |

Semantics (issue #32):

- **`task_id` is required and explicit.** `review-dispatch` refuses to run
  without `--task <task_id>` and validates it against the canonical task-id
  grammar (1-64 chars of `[a-z0-9-]`, no leading/trailing hyphen) *before*
  any dispatch or ledger write. Both lifecycle events carry it.
  Task identity is **never inferred from `review_id` naming** — a review id is
  an opaque session label (it names the `sessions/<review_id>.<vendor>.*`
  artifacts) and may be entirely unrelated to any task id.
- **Three distinct states.** A reviewer process that finished
  (`review_completed`) is process telemetry; an authoritative verdict
  (`review_verdict`, backed by the append-only review store at
  `authoritative/reviews/<task>/<seq>-<reviewed_head>.json` — the highest
  valid generation wins over conflicting ledger telemetry; a generation is
  valid only if its document's own `task_id` exists and equals the task
  directory it sits in, so a misfiled or identity-less file is skipped in
  favour of the next valid generation — including a
  durable file-only generation whose `review_verdict` append was lost) is the
  *only* acceptance gate; and acceptance holds **only** when the recorded
  verdict is exactly `accept`. A successful
  vendor exit (`exit_code: "0"`) or free-text review output is not a verdict
  and can never satisfy acceptance. `revise` / `reject` / `blocked` verdicts
  are recorded-but-not-accepted.
- **Legacy events.** Ledgers written before `task_id` was required contain
  `review_started` / `review_completed` events with no `task_id`. Readers keep
  them in the flat event timeline only — they must never be guessed onto a
  task row, even when a `review_id` happens to spell a task id.

In the `run-log` per-task Review column this renders as: `reviewer completed
(...)` lines for each task-keyed completion (ledger order), then either
`accepted — verdict accept (...)`, `verdict <v> (...) — not accepted`, or
`verdict pending — a completed review is not a verdict`; the explicit
`(none recorded)` gap appears only when a task has neither completions nor a
verdict. The structured `--json` form mirrors this as
`tasks[].review = { completions: [...], verdict: {...} | null, accepted: boolean }`.
