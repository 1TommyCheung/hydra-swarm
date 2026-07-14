# Loop-thinking detector: build-ready design

## Decision summary

Implement the detector as a shared TypeScript component called by both worker
polling paths in `kit/hydra-ts/src/dispatch.ts`. It runs automatically after a
worker has acquired its concurrency slot. It incrementally reads only the
vendor's raw streaming capture, samples a content-sensitive Git worktree
fingerprint every 30 seconds, and applies the two rules defined below.

The first release is advisory. On a match it appends one nonterminal
`agent_loop_suspected` ledger event and exposes that warning through
`status.ts`. It does **not** terminate the worker. A lead who agrees with the
warning uses `cancelTask(runId, taskId, options)` or
`kit/hydra/scripts/cancel-task.sh`; the detector must not copy process discovery,
PID validation, signalling, escalation, or terminal-event logic.

This differs deliberately from the earlier speculative designs. The current
harness already has:

- a normal polling loop and a pane polling loop in `dispatch.ts`;
- a unique `dispatch_instance_id` on every event written by one dispatch;
- `sessions/supervisor/<agentRunId>.dispatch.pid` and pane worker-disappearance
  handling (`agent_exited`, exit code `127`, reason `worker_disappeared`);
- streaming `.cli.jsonl` for Codex/Kimi, streaming `.events.jsonl` for
  OpenCode, `.stderr` for all vendors, and only final `.cli.json` for Claude;
- current-attempt ledger scoping in `status.ts`; and
- a safe external cancellation boundary in `cancel-task.ts`.

The detector should use those pieces rather than introduce another daemon,
PID protocol, or kill-tree implementation.

## Goals and non-goals

The detector should identify a live agent that is producing raw events while
its worktree is unchanged and either:

1. repeatedly performs the same explicitly failing action; or
2. repeats a short semantic event cycle for an unusually long period.

It is a heuristic, not proof of non-progress. Its first release must prefer a
missed loop over cancelling legitimate work. It is not responsible for silent
hangs, dead pane workers, wall-clock limits, or cancellation; those are already
handled by inactivity/hard-cap accounting, worker-liveness checks, and
`cancelTask()` respectively.

## Proposed implementation shape

Add these implementation files in the follow-up task:

```text
kit/hydra-ts/src/current-attempt.ts     shared current-attempt ledger helper
kit/hydra-ts/src/loop-detector.ts       parsers, sampler, and pure state machine
kit/hydra-ts/test/loop-detector.test.ts parser/sampler/state-machine tests
```

Modify:

```text
kit/hydra-ts/src/dispatch.ts            construct and poll one detector per dispatch
kit/hydra-ts/src/status.ts              surface active suspicion
kit/hydra-ts/src/cancel-task.ts         import the shared attempt helper only
kit/hydra-ts/test/dispatch.test.ts       polling-path integration tests
kit/hydra-ts/test/status.test.ts         attempt scoping and rendering tests
```

`loop-detector.ts` should export a `LoopDetector` with no timers of its own:

```ts
interface LoopDetectorDependencies {
  clock: { now(): number };
  capture: IncrementalCaptureReader;
  gitFingerprint(): GitFingerprintResult;
  readLedger(): LedgerEntry[];
  appendLedger(event: string, ...kvs: string[]): void;
}

interface LoopDetector {
  poll(): void; // cheap on every dispatch tick; Git is rate-limited internally
}
```

Construct it immediately before worker launch, after slot acquisition. That
lets it baseline a pre-existing capture file and the worktree before the worker
can create new evidence. Call `poll()` after each normal dispatch tick in both
`runWorkerPlain()` and `runWorkerInHerdrPane()`. Do not duplicate detector logic
inside those loops. A final poll is unnecessary after a terminal condition: a
warning arriving after completion has no operational value.

Pass the already-validated absolute `resolvedWorktree` from `dispatch()` to the
detector. The current `WorkerContext.worktree` retains the task-spec spelling,
which may be relative to `cwd`; Git sampling must not rely on the process's
ambient working directory.

The detector keeps rolling state in memory. The warning itself is durable in
the ledger. A dispatcher restart or a duplicate `task_started` intentionally
starts a new warm-up period; carrying heuristic state across dispatch instances
would risk applying old evidence to a new worker.

## Attempt identity and ledger scoping

The detector must use the exact boundary rule already implemented by
`status.ts`, not a time comparison and not “all events for this task”:

1. read the task's current `spec_version` and derive
   `<runId>-<taskId>-v<specVersion>`;
2. filter ledger entries by `task_id`;
3. scan backward for the newest `task_started` whose `agent_run_id` equals that
   derived ID; and
4. use only that entry and entries after it.

Extract the existing `currentAttemptEvents()` implementation essentially
unchanged into `current-attempt.ts`, then use it from `status.ts`,
`cancel-task.ts`, and the detector. `cancel-task.ts` currently has an equivalent
`currentAttemptSnapshot()`; it should build its terminal lookup on the shared
window rather than retain a third copy.

Immediately before writing a suspicion, re-read the ledger and require all of
the following:

- the current-attempt window exists;
- its latest terminal event is absent;
- its boundary `task_started.dispatch_instance_id` equals this detector's
  `dispatchInstanceId`; and
- the detector is still attached to the current `agentRunId`.

The normal `dispatch.ts` ledger appender supplies `dispatch_instance_id` to the
new event. This closes races with completion and with another dispatch of the
same spec version.

## Input signals

### 1. Raw capture, by vendor

Use only the primary streaming event file as semantic evidence:

| Vendor | Primary file | Semantic support |
|---|---|---|
| Codex | `sessions/<agentRunId>.cli.jsonl` | actions, messages, and explicit action outcomes when present |
| Kimi | `sessions/<agentRunId>.cli.jsonl` | assistant/tool-call records and tool results |
| OpenCode | `sessions/<agentRunId>.events.jsonl` | `part.type == "tool"` and text records |
| Claude or an unknown non-streaming vendor | none | disabled; rely on existing inactivity and hard cap |

Do not read `pane-progress.txt` or pane text: they are derived displays. Do not
reuse `plainActivity()` or `herdrActivity()` as semantic input. The former
counts every top-level session artifact, while the latter counts only
`.cli.jsonl` and `.stderr`; neither represents vendor-independent meaningful
progress. `.stderr` is corroborating diagnostics only and can never trigger a
warning by itself.

The incremental reader stores `{device, inode, offset, boundaryHash}` and only
parses newline-terminated records. A partial final line remains pending. If the
file shrinks, its inode changes, or the bytes around the saved boundary no
longer match (including a same-size rewrite), clear the rolling event evidence,
reset the offset, and warm up again. Do not count the whole replacement file as
fresh activity. Ignore malformed complete JSON records semantically, although
their bytes may contribute to raw-output metrics. This prevents truncation,
rotation, malformed output, or stale files from manufacturing a loop.

Use the detector clock's observation time. Current vendor records do not share
a reliable timestamp schema, so vendor timestamps must not define windows.

### 2. Normalized semantic signatures

Canonical JSON means recursively sorted object keys with JSON scalars
preserved. Remove transport-only fields such as event/session IDs, timestamps,
usage counters, and tool-call correlation IDs from the signature, but retain a
correlation ID separately to join starts to outcomes. Replace the absolute
worktree prefix with `<worktree>` and normalize line-ending and insignificant
whitespace. Do not erase numbers or substantive arguments. Store only SHA-256
hashes in memory snapshots and ledger events, never prompts, commands,
arguments, or tool output.

Vendor extractors should be schema-tolerant and return no semantic record for
an unknown shape:

- **Codex:** an `item.started` `command_execution` signature includes the
  normalized command; an `mcp_tool_call` includes `server`, `tool`, and
  canonical arguments/input when present. Correlate a matching completed item
  by item ID. An outcome is an explicit failure only for a nonzero exit code or
  a `failed`/`error` status. A `file_change` event is not proof of progress;
  only the Git fingerprint confirms that the file actually changed.
- **Kimi:** for an assistant record with `tool_calls`, create one action per
  `function.{name,arguments}` and retain each tool-call ID for correlation.
  Match a `role: "tool"` record by `tool_call_id`. It is an explicit failure
  only when a structured `is_error`, `error`, or `status: failed|error` field
  says so. An opaque string tool result is not classified as failure. Plain
  assistant content contributes an exact, whitespace-normalized message hash
  to cycle detection but not to the strong failing-action rule.
- **OpenCode:** for `part.type == "tool"`, sign `part.tool` plus canonical input
  or arguments from `part.state`; use the part/call ID for correlation. Treat
  only explicit `part.state.status == error|failed` or an explicit error field
  as failure. Text parts contribute message hashes only.
- **Claude:** current `adapter-claude.ts` writes `.cli.json` and `.stderr` after
  the CLI returns, so there is no live semantic stream. Report detector support
  as `unavailable_non_streaming`; never infer a loop merely from an unchanged
  worktree.

A failure fingerprint is SHA-256 over the action signature, explicit failure
status/exit code, and at most the first 512 normalized bytes of an explicit
error value. This distinguishes one persistent failure from the same action
failing for unrelated reasons.

### 3. Content-sensitive Git progress

Sample Git at construction and every 30 seconds thereafter using
`GIT_OPTIONAL_LOCKS=0`. Thirty seconds keeps a 10-minute window accurate to 5%
while avoiding a Git process on the existing two-second dispatch tick.

The fingerprint is SHA-256 over a length-delimited encoding of:

```text
git -C <absolute-worktree> rev-parse HEAD
git -C <absolute-worktree> diff --no-ext-diff --binary HEAD --
git -C <absolute-worktree> status --porcelain=v2 -z --untracked-files=all
content hash for every path from git ls-files --others --exclude-standard -z
```

Hash untracked regular-file bytes and symlink target text in path order.
Unreadable or special files contribute a typed marker rather than disappearing.
The combined diff catches staged and unstaged tracked content, while explicit
untracked hashing catches same-path content rewrites that plain `git status`
would still show only as `? path`. Commit timestamps and file mtimes are not
progress signals.

Record `lastGitChangeAt` only when two successful fingerprints differ. If any
Git command or file read fails, set Git evidence to unknown and suppress loop
detection until a successful baseline plus a complete qualifying window exists.
“Could not inspect progress” must never be treated as “no progress.”

## Exact detection rules

Defaults are constants in `loop-detector.ts` for the first implementation. Do
not add environment knobs until real capture data has been evaluated; hidden
per-run tuning would make warnings hard to interpret.

| Parameter | Default |
|---|---:|
| dispatch poll cadence | existing `pollIntervalMs` (normally 2 seconds) |
| Git sample cadence | 30 seconds |
| strong-rule window | 10 minutes |
| strong-rule actionable suffix | 12 calls |
| strong dominant action | at least 8 of the 12 calls |
| strong action diversity ceiling | at most 3 unique action signatures |
| strong matching explicit failures | at least 6 |
| active-output floor | 20 meaningful records or 8 KiB of newly appended primary capture |
| cycle-rule window | 15 minutes |
| cycle meaningful-event floor | 24 records and 32 KiB of newly appended primary capture |
| cycle period | 1–4 semantic signatures |
| cycle repetitions | at least 5 consecutive repetitions at the suffix |

### Rule A: repeated explicit failure

Emit `kind=repeated_failure` when, within the same 10-minute interval:

1. Git evidence was continuously available and the fingerprint did not change;
2. the primary capture met the active-output floor;
3. there are at least 12 actionable calls, and one signature occupies at least
   8 positions in the last 12 while the suffix has no more than 3 signatures;
4. at least 6 occurrences of that dominant action have outcomes with the same
   explicit failure fingerprint; and
5. the attempt/dispatch identity checks still pass.

Eight of twelve allows a small amount of legitimate inspection between retries.
Six identical explicit failures rules out transient failures and avoids
guessing from prose. Ten minutes is long enough for normal “test, inspect,
edit” debugging to change the Git fingerprint, but short enough to save most of
a default 45-minute task when a retry is truly stuck. Repeated successful test
runs do not match this strong rule.

### Rule B: repeated semantic cycle

Emit `kind=repeated_event_cycle` when Git has not changed for 15 minutes, the
higher cycle output floor is met, and the semantic suffix is a period of 1–4
signatures repeated at least 5 consecutive times. The cycle must include at
least one actionable call; repeated assistant text alone is insufficient.

This catches action/message/action loops whose outcome schema cannot be
classified. Its longer window and larger output floor compensate for the lack
of explicit failure evidence. Exact hashes intentionally favor false negatives:
near-duplicate reasoning may be missed, but ordinary varied investigation will
not be labelled circular.

### Episodes, clearing, and stderr

Emit only one suspicion per `{dispatch_instance_id, kind, dominant-or-cycle
hash}` episode. Mark the episode cleared after either a Git fingerprint change
or three consecutive 30-second Git samples on which its pattern no longer
matches. Append `agent_loop_cleared` with the episode ID and reason
`git_progress` or `pattern_changed`. A terminal event implicitly ends every
episode and needs no clear event.

For diagnostics, normalize ANSI escapes and exact worktree prefixes in the last
50 nonempty stderr lines. If one line hash occurs at least 40 times, add
`stderr_repeat_hash` and `stderr_repeat_count` to an otherwise-qualified
suspicion. Do not use timestamps/PID stripping or fuzzy normalization, and do
not let stderr satisfy either rule; repeated warnings and progress redraws are
common false positives.

## Ledger and status contract

Append a compact event through `ctx.appendLedger`, for example:

```json
{
  "time": "2026-07-14T10:20:00Z",
  "event": "agent_loop_suspected",
  "run_id": "0013",
  "task_id": "loop-detector",
  "vendor": "codex",
  "agent_run_id": "0013-loop-detector-v1",
  "dispatch_instance_id": "8f25c0d97da21f34",
  "detector_version": "1",
  "episode_id": "sha256:...",
  "kind": "repeated_failure",
  "window_sec": "600",
  "git_stagnant_sec": "623",
  "raw_bytes": "18422",
  "meaningful_events": "31",
  "repeat_count": "9",
  "failure_count": "7",
  "dominant_action_hash": "sha256:...",
  "failure_hash": "sha256:..."
}
```

All metrics use the observation clock. No raw model text or arguments enter the
authoritative ledger.

Extend `StatusResult` with a nullable `loop_suspicion`. Derive it only from the
already-scoped current-attempt events. The most recent suspicion is active only
if no later matching `agent_loop_cleared` or terminal event exists. Human output
should place `warning: possible agent loop ...` near `state: running`; JSON
should return the structured event metrics. A stale warning from an earlier
`spec_version`, an earlier duplicate `task_started`, or another dispatch
instance must not appear.

## Why the detector runs in dispatch

The existing dispatch loops already know exactly when a worker has started and
ended, have the injected clock, own the ledger appender that supplies
`dispatch_instance_id`, and cover both plain and pane modes. An integrated
component therefore provides automatic detection for every dispatch without a
new scheduler or state-file ownership protocol.

A status-like one-shot command is useful for inspection but is the wrong
primary detector. Raw records lack a common trustworthy timestamp, and Git has
no historical dirty-tree snapshots, so one execution cannot prove that a
worktree was unchanged for 10 or 15 minutes. Making repeated one-shots correct
would require a new periodic service, durable sampler state, locking, stale
owner recovery, and dispatch-identity races. It would also require the lead to
remember to run it, defeating automatic notice.

The tradeoff is a small amount of extra work in the dispatcher and a brief
synchronous Git-command pause every 30 seconds. Keep capture parsing
incremental and Git rate-limited; if later measurements show Git sampling
affects worker-exit latency, move only `gitFingerprint()` behind an asynchronous
injected runner, not the detector into a separate daemon.

## Action on detection

Version 1 must not auto-cancel. Cancellation is currently a deliberate external
operation, and a heuristic cannot establish that repeated reads, test commands,
or a long planning phase are valueless. Advisory-first behavior also lets real
captures calibrate the thresholds without turning false positives into lost
work.

The lead workflow is:

```text
status.sh <runId> <taskId>
# inspect warning and progress tail
cancel-task.sh <runId> <taskId>       # only if the lead agrees
```

`cancelTask()` validates the current attempt and dispatcher identity, sends
SIGTERM, waits for the real terminal ledger event produced by dispatch, and
revalidates before any SIGKILL. The warning preceding `agent_cancelled` in the
same current-attempt window preserves the reason for the human decision. The
detector must never signal a PID or fabricate a terminal event.

Calling `cancelTask()` from inside `dispatch.ts` is specifically prohibited:
the target it resolves is that same dispatcher, so the detector would signal
its own process while awaiting its own terminal event. If automatic policy is
added later, it must run in a separate supervisor process and call the existing
`cancelTask()` API. Before doing so it should require two independent
high-confidence Rule A matches at least five minutes apart, at least six new
matching explicit failures, no intervening Git change, a still-current
nonterminal attempt, and the same dispatch instance. That future opt-in policy
is outside version 1.

## Deterministic test plan

No detector test should use real sleeps or depend on wall-clock time.

### Pure parser and state-machine tests

Use table fixtures in `loop-detector.test.ts` for Codex, Kimi, and OpenCode.
Call the parser and state machine directly with numeric observation times.
Cover:

- canonical key ordering and worktree-prefix replacement;
- retention of substantive numeric arguments;
- start/outcome correlation and explicit failure classification;
- opaque Kimi tool output not being guessed as failure;
- unknown vendor records, nulls, malformed JSON, and partial final lines;
- 8-of-12 dominance, the 3-signature ceiling, 6 matching failures, and every
  threshold boundary immediately below and at the default;
- cycle periods 1 through 4, four versus five repetitions, and the requirement
  that a cycle contain an action;
- repeated successful tests, varied failures, repeated assistant messages, and
  repeated stderr never triggering Rule A by themselves; and
- episode deduplication and three-sample clearing.

### Fake clock and filesystem tests

Reuse the `StepClock` style in `dispatch.test.ts`: `sleep(ms)` advances a number
and invokes an `onSleep` hook that appends capture lines or changes injected Git
evidence. The detector itself receives `clock.now()` and never schedules work.

Use per-test temporary directories and real small files, as existing Hydra TS
tests do, for incremental-reader cases:

- append complete records over multiple polls;
- leave a partial JSON record, then complete it;
- truncate and rewrite the capture;
- replace it with a new inode;
- rewrite it at the same size;
- begin with a stale capture before detector construction; and
- verify malformed records do not abort later valid parsing.

Inject `gitFingerprint()` as a sequence of fixed hashes instead of invoking a
real Git process in state-machine tests. Separately test the real Git
fingerprinter in a temporary repository with commits, staged and unstaged
changes, deletion, rename, untracked content changes at the same path, symlink,
and an injected read/command failure. Assert that unknown Git evidence suppresses
detection and requires a new full window after recovery.

### Dispatch integration tests

Extend the existing fake worker, `FakeHerdr`, and `StepClock` tests. Use a short
injected detector configuration only in tests (for example, a 60-second window
and three samples); production constants remain fixed. Verify:

- plain Codex/Kimi and plain OpenCode poll the shared detector;
- pane-hosted Codex/Kimi poll the same detector;
- no detector runs while waiting for a concurrency slot;
- a qualifying fixture appends exactly one `agent_loop_suspected` with the same
  `dispatch_instance_id` as `task_started`;
- real Git-signature changes prevent or clear suspicion even when `git status`
  remains `M file`;
- a terminal event or a newer `task_started` inserted just before emission
  prevents the warning;
- worker disappearance still records only the existing exit-127 terminal path;
- detector/parser/Git exceptions fail open and do not disrupt timeout, pane
  cleanup, slot release, usage recording, or worker exit; and
- detection never invokes `killTree`, `signalProcess`, or `cancelTask()`.

### Status and cancellation regression tests

In `status.test.ts`, write ledgers containing old-version suspicions, duplicate
same-version attempts, clear events, and terminal events. Use the injected
`now()` already present. Assert only the newest current-attempt warning is
rendered and JSON remains structured.

In `cancel-task.test.ts`, retain the existing injected `sleep`, liveness,
process-list, and signal functions. Add one case with an
`agent_loop_suspected` between `task_started` and cancellation to prove the
nonterminal warning does not change PID resolution, terminal waiting,
escalation safety, or the rule that `cancelTask()` never fabricates a ledger
event.

## Rollout and calibration

Ship advisory detection enabled for vendors with a supported primary streaming
capture. Treat parser or Git failures as degraded observability, not task
failure. After collecting suspected/cleared episodes, compare them with lead
cancellation decisions before considering threshold changes or the separate
opt-in auto-cancellation policy. Non-streaming vendors remain explicitly
unsupported for loop detection until their adapter supplies live structured
events; they continue to receive the existing inactivity, hard-cap, and process
liveness protections.
