# Async completion, hang detection, status, and cancellation design

**Ticket:** #31

**Scope:** a build-ready design for replacing completion polling and detecting or
recovering unhealthy task runs. This document describes the TypeScript harness,
which is the default implementation behind `kit/hydra/scripts/dispatch.sh`.

## Executive decision: use the blocking dispatch as the completion future

`kit/hydra-ts/src/dispatch.ts` confirms the key premise. Both CLI modes construct
the same `runWorker(ctx, recorder)` promise. `background` only selects whether
`dispatch()` executes `await finished` before returning; it is not passed into an
adapter and does not alter the worker process. Consequently, the lead should run:

```bash
bash kit/hydra/scripts/dispatch.sh <run> <task>
```

without `--background`, while asking its own execution environment to run that
whole command asynchronously. Completion of that outer execution is the
notification. A detached shell equivalent is:

```bash
nohup bash kit/hydra/scripts/dispatch.sh <run> <task> \
  >"$log" 2>&1 </dev/null & disown
```

This removes watcher scripts and their sleep loops from the completion path. In
particular, a caller no longer constructs or guesses
`sessions/<run>-<task>-v<version>.exit`, so an old sentinel or stale version
suffix cannot report a new dispatch as complete. Sentinels remain a private
supervisor/worker handshake, not a lead-facing notification API.

The rest of this design adds a shared supervisor state model. Proposed new
harness-owned runtime data is kept under:

```text
<state-root>/runs/run-<run>/sessions/supervisor/
  <dispatch-instance-id>.json          # atomic latest health snapshot
  <dispatch-instance-id>.control.json  # control endpoint metadata, mode 0600
```

`dispatch_instance_id` is a random ID created for every invocation. It is added
to `task_started` and every terminal event. It is distinct from the currently
deterministic `agent_run_id` (`<run>-<task>-v<spec>`), and therefore safely
identifies retries of the same spec version.

## 1. Not running — **partially solved; pane-hosted gap remains**

### Verification against current code

The claim is correct for a plain worker:

- `runWorkerPlain()` attaches `exit` and `error` handlers to the spawned child.
  Normal exit, signal exit, and spawn error settle `exitedPromise` immediately;
  they do not wait for a capture timeout.
- A spawn that returns no PID throws, and the outer error path invokes the
  recorder's clean cancellation path.
- The optional OpenCode display calls `processAlive(workerPid)`, but that probe
  only governs its monitor pane. Plain-worker completion itself is driven by the
  child event.
- If a herdr pane cannot be launched, `runWorker()` falls back to the plain path,
  which has the behavior above.

The claim is **not** correct for an already launched, pane-hosted Claude, Codex,
or Kimi worker. `runWorkerInHerdrPane()` waits for `<agent_run_id>.exit`, the
inactivity limit, the hard cap, or cancellation. It writes a pane-shell PID to
`<agent_run_id>.pid`, but does not call `processAlive()` on that PID during the
loop. If the pane shell dies before it writes the sentinel, Hydra currently
misclassifies the disappearance as `stalled` after the full inactivity window.
The only present `processAlive()` use is in the decoupled OpenCode monitor and is
not an authoritative liveness decision.

### Proposed implementation

Extend the shared supervisor loop in `dispatch.ts` as follows:

1. The pane wrapper writes a harness-generated `dispatch_instance_id` and its
   shell PID to a temporary pid record, then atomically renames it to
   `sessions/supervisor/<instance>.worker.json`. The exit code is likewise
   written to a temporary file and renamed atomically to the existing `.exit`
   path. Atomic publication removes the dead-process-versus-partial-sentinel
   race.
2. Allow five seconds after `herdr.agentStart()` for either the worker PID record
   or an exit sentinel. If neither appears, record terminal `agent_exited` with
   `exit_code: "127"` and `reason: "never_started"`, then close the pane.
3. On every existing two-second supervisor tick, call `processAlive(pid)`. If it
   first returns false, re-read the atomic exit sentinel. If no sentinel exists,
   probe once more after a one-second grace period. A second false result records
   `agent_exited`, `exit_code: "127"`, and `reason: "worker_disappeared"`.
4. Validate the PID record before probing: regular file, exact run/task/agent and
   instance IDs, positive integer PID, and expected pane-shell command identity.
   A malformed record is a start failure, not a PID to signal. The instance ID
   and command check make PID reuse unable to impersonate this dispatch.
5. Keep `agent_exited` as the terminal event so existing ledger-derived running
   counts still close correctly. The additional `reason` distinguishes a lost
   process from an adapter's genuine nonzero exit.

Pseudo-code for the pane branch:

```ts
if (!workerRecord && ageSincePaneStart >= 5_000 && !exitSentinel) {
  recorder.recordExit("agent_exited", "127", { reason: "never_started" });
}

if (workerRecord && !processAlive(workerRecord.pid) && !exitSentinel) {
  await clock.sleep(1_000);
  if (!readAtomicExit() && !processAlive(workerRecord.pid)) {
    recorder.recordExit("agent_exited", "127", {
      reason: "worker_disappeared",
    });
  }
}
```

Tests should cover no pidfile, a PID that dies before sentinel publication, a
sentinel that wins the race, malformed/PID-reuse metadata, and the existing
plain-process immediate exit cases.

## 2. Loop-thinking — **unsolved today; add a multi-signal detector**

### Data that actually exists

The harness can observe the following without consulting pane text:

| Signal | Current source |
|---|---|
| Codex events | `sessions/<agent_run_id>.cli.jsonl` |
| Kimi events | `sessions/<agent_run_id>.cli.jsonl` |
| OpenCode events | `sessions/<agent_run_id>.events.jsonl` |
| Vendor diagnostics | `sessions/<agent_run_id>.stderr` |
| Claude final response | `sessions/<agent_run_id>.cli.json` (normally written only at exit) |
| Session identity | `sessions/<agent_run_id>.json` |
| Lifecycle/checkpoints | `authoritative/ledger/events.jsonl` |
| Actual implementation progress | task worktree `HEAD`, index, tracked changes, and untracked files |

The ledger currently has lifecycle events, not turn-by-turn progress. Pane text
is a derived display and must not become truth. Claude's current non-streaming
capture provides no repeated-tool evidence while it is running; for Claude the
detector will use worktree progress plus inactivity/hard-cap behavior until its
adapter exposes streaming events.

Capture growth alone is not progress: an agent can emit the same failed tool
call indefinitely. Git dirtiness alone is also insufficient: `git status` can
remain simply `M file` while the file changes many times. The detector therefore
uses both semantic event repetition and a content-sensitive worktree signature.

### Concrete sampler

Implement `TaskHealthSampler` in a new shared TypeScript module, used by both
plain and pane-hosted dispatch loops. Sample capture byte counters on the normal
two-second tick and perform the more expensive Git sample every 30 seconds with
`GIT_OPTIONAL_LOCKS=0`.

The Git signature is SHA-256 over:

```text
git rev-parse HEAD
git diff --no-ext-diff --binary HEAD --
git status --porcelain=v2 -z --untracked-files=all
git hash-object --no-filters <each untracked regular file, path-sorted>
```

The NUL-delimited status output must be parsed without shell word splitting;
symlinks are hashed as link text, and unreadable/special files contribute a
typed marker. This detects commits, staged or unstaged content changes, deletes,
renames, and untracked content changes. `last_git_activity_at` is the supervisor
observation time at which this signature last changed; Git does not itself store
a reliable "last worktree activity" timestamp.

Incrementally parse only complete new JSONL records from the raw adapter files.
For each tool action, create a normalized signature:

```text
<vendor>:<tool-kind>:sha256(canonical arguments)
```

Canonicalization removes event IDs, timestamps, absolute worktree prefixes, and
other per-attempt nonce values, but retains the command/tool name, target paths,
and substantive arguments. Capture a separate failure fingerprint from a
nonzero command status, tool error status, or normalized first 512 bytes of the
error result. Store hashes and counts in supervisor state; never copy raw prompts
or tool output into the ledger.

Examples of adapter-specific extraction:

- Codex: `item.started` command/file/MCP records provide the action; matching
  completed/error records provide outcome when present.
- Kimi: assistant `tool_calls[].function.{name,arguments}` provides the action;
  the corresponding `tool_call_id` result provides the outcome.
- OpenCode: `part.type == "tool"`, `part.tool`, and its state/input fields provide
  the action and outcome.
- Claude: no semantic action records are available from the current adapter, so
  do not invent signatures from process output.

Write the latest sampler state atomically to
`sessions/supervisor/<dispatch_instance_id>.json`. Keeping it in a subdirectory
is important: current `plainActivity()` globs top-level `<agent_run_id>.*` files,
so a supervisor file with that prefix would otherwise reset its own inactivity
timer forever.

### Detection rule and action

Use fixed defaults initially, configurable only at dispatch start and copied
into the supervisor snapshot:

- rolling observation window: 10 minutes;
- active-output floor: 20 complete events or 8 KiB of new raw capture;
- repetition set: last 12 actionable tool calls;
- repeated-action threshold: one signature appears at least 8 times, no more
  than 2 unique signatures, and at least 4 attempts share a failure fingerprint;
- no worktree-signature change during the same window.

When all conditions hold while the process is alive, append one nonterminal
`agent_loop_suspected` event containing instance ID, window seconds, event count,
repeat count, and signature/failure **hashes**. Surface the warning immediately
in `status.sh` but do not cancel on the first window.

If the same dominant action/failure remains present for a further five minutes,
with at least four new matching failed attempts and still no Git-signature
change, call the dispatcher's existing recorder cancellation path with
`reason: "loop_thinking"`. That path kills the worker tree, atomically records a
single terminal `agent_cancelled`, writes exit code 130, releases the slot, and
closes the pane. A Git-signature change, a new successful tool signature, or a
change of dominant failure clears the suspicion episode.

```ts
if (captureIsActive(window)
    && workSignatureUnchanged(window)
    && dominantAction.count >= 8
    && uniqueActions <= 2
    && matchingFailures >= 4) {
  markSuspectedOnce(metrics);
}

if (sameSuspicionPersistsFor(5 * MINUTE)
    && additionalMatchingFailures >= 4) {
  recorder.cancel({ reason: "loop_thinking", detector: metrics });
}
```

The conservative second window is deliberate: repeated reads or test commands
can be legitimate, but repeated identical failures with active token output and
no content change for 15 minutes are strong evidence of a loop. Unit fixtures
must cover genuine iterative edits, repeated successful tests, same-size file
rewrites, truncating capture files, malformed/partial JSONL, and a real repeated
failure loop.

## 3. Running too long — **solved, with two accuracy hardenings**

### Verification against current code

The belief is substantially correct in both execution paths:

- `timeout_minutes` becomes an inactivity limit.
- `runWorkerPlain()` and `runWorkerInHerdrPane()` reset their `waited` counter
  when their activity-size signature changes.
- Both maintain a separate `elapsed` counter that never resets.
- `HYDRA_HARD_CAP_MIN`, defaulting to `timeout_minutes * 6`, terminates a worker
  that continues emitting output forever.
- Timeout kills the worker tree and records one `agent_timed_out` event with
  `reason: "stalled"` or `reason: "hard_cap"`; tests cover exact inactivity,
  renewal on capture growth, and hard-cap precedence.

Two details make "resets on real capture growth" slightly too strong today.
The pane path watches the combined sizes of `.cli.jsonl` and `.stderr`; the plain
path watches every top-level `<agent_run_id>.*` session file. Both compare size
signatures, not monotonic bytes or content. A same-size rewrite is invisible,
and a non-capture session artifact can renew the plain timer.

### Proposed hardening

Have `TaskHealthSampler` expose per-raw-capture `{device,inode,size}` high-water
marks. Renew inactivity only when a designated raw stream grows beyond its
previous high-water mark. On inode change or truncation, treat subsequently
written bytes as new activity but do not grant a reset merely for the truncate
operation. Designated files are `.cli.jsonl`/`.stderr` for Codex and Kimi,
`.events.jsonl`/`.stderr` for OpenCode, and `.stderr` plus final `.cli.json` for
Claude. Supervisor, banner, pid, session-identity, progress, and sentinel files
never count as worker activity.

Parse `timeout_minutes` and `HYDRA_HARD_CAP_MIN` once at dispatch start and reject
non-finite, zero, or negative values. Store the resolved inactivity and hard-cap
budgets in the supervisor snapshot so status reports the dispatcher's actual
values, not the status process's environment.

These changes tighten accounting; they do not change the existing semantic
decision that inactivity and absolute wall time are separate limits.

## 4. Live status visibility — **unsolved; add one-shot `status.sh`**

No dedicated task-status command exists. `ledger-view.sh` renders the ledger,
and herdr shows panes, but neither combines current progress, budgets, Git
activity, liveness, and authoritative state for one task.

### Command and output

Add a stable entry point:

```bash
bash kit/hydra/scripts/status.sh <run> <task> [--lines N] [--json]
```

Default `N` is 20. Text output should be compact and explicitly label which
facts are authoritative versus advisory:

```text
run 0005 / task async-trigger-codex / codex / spec v1
state: running (ledger authoritative)  instance: 8d2...  agent: 0005-...-v1
elapsed: 06:14  inactivity: 00:31 / 15:00  hard cap: 06:14 / 90:00
process: dispatcher alive, worker alive (advisory)
capture: codex cli.jsonl, 184 KiB, last growth 14s ago
git: HEAD abc1234, dirty 2, last observed change 2m08s ago
health: healthy
ledger: task_started -> herdr_pane_started
progress (last 20):
  [cmd] rg -n processAlive kit/hydra-ts/src/dispatch.ts
  [edit] async-trigger-design-codex.md
```

The JSON form returns the same fields with ISO timestamps and numeric seconds,
so future UIs do not scrape text.

### Read algorithm

1. Resolve the run directory with the same state-root helper as dispatch. Read
   the task spec for the configured worktree and timeout.
2. Read the ledger and select the latest `task_started` for the requested task.
   Use its `agent_run_id` and new `dispatch_instance_id`; never reconstruct a
   version suffix. Match its terminal event by instance ID. This is what prevents
   stale session files from becoming current status. During migration of old
   ledgers, fall back to ordered start/terminal pairing and label the match
   `legacy_ambiguous` if more than one start is unmatched.
3. Read the matching supervisor snapshot. Calculate elapsed, inactivity used and
   remaining, hard-cap used and remaining, last capture growth, last observed
   Git change, current HEAD/signature, dirty count, and detector health. Probe
   dispatcher/worker PIDs with `processAlive()` only as advisory corroboration.
4. Render the last N progress records directly from the raw capture with the
   same pure parsers used by the pane display. Prefer Codex/Kimi `.cli.jsonl`,
   OpenCode `.events.jsonl`, then stderr. For non-streaming Claude, show recent
   stderr or `no streaming progress available; final JSON pending`. Do not rely
   on a pane or mutate a derived progress file.
5. Show the last relevant ledger events and terminal details. Ledger lifecycle
   state wins over a liveness disagreement; print a warning on disagreement.

`status.sh` is strictly one-shot and read-only: no ledger append, no session or
worktree write, no pane state change, no lock acquisition, and no capture
offset checkpoint. Git reads use `GIT_OPTIONAL_LOCKS=0`. All parsing offsets are
in memory and disappear when the command exits. The worker owns its worktree and
result; status merely reads Git evidence and harness-owned state/captures.

Tests should exercise running, completed, timed out, cancelled, missing/partial
snapshot, truncated capture, legacy ledger, retry of the same spec version,
multiple unmatched starts, non-streaming Claude, and `--json` schema stability.

## Clean cancellation — add `cancel-task.sh` through dispatch control

There is no dedicated `cancel-task.sh` (or equivalent recovery command) in
`kit/hydra/scripts/` or `kit/hydra-ts/src/`. Current `dispatch.ts` does have the
correct in-process cleanup primitive:

- `ExitRecorder.cancel()` calls `killTree(workerPid)`;
- `finish()` appends `agent_cancelled`, writes exit code 130, releases the slot,
  and unregisters handlers;
- pane cleanup follows the ledger write; and
- an internal `recorded` guard makes the terminal append idempotent.

Its signal handlers route SIGINT/SIGTERM/SIGHUP through that method. A bare
`kill -9` bypasses all of it and must never be the cancellation interface.

### Control-channel design

At dispatch start, create a per-invocation Unix-domain control socket in a
mode-0700 runtime directory with a short hashed path (macOS has a small Unix
socket path limit). Atomically publish a mode-0600 metadata file at
`sessions/supervisor/<dispatch_instance_id>.control.json`:

```json
{
  "run_id": "0005",
  "task_id": "async-trigger-codex",
  "agent_run_id": "0005-async-trigger-codex-v1",
  "dispatch_instance_id": "8d2f...",
  "dispatch_pid": 12345,
  "socket_path": "/tmp/hydra-501/1a2b.sock",
  "nonce": "256-bit-random-value",
  "started_at": "2026-07-14T10:00:00Z"
}
```

The dispatch server accepts one newline-delimited request containing the exact
identity, nonce, and `action: "cancel"`. On a valid request it appends optional
nonterminal `agent_cancel_requested`, calls
`recorder.cancel({reason: "operator"})`, and acknowledges only after the
terminal ledger record and sentinel have been written. It then closes/unlinks the
socket and metadata during normal cleanup. Socket errors cannot terminate the
worker or write a terminal event.

Add:

```bash
bash kit/hydra/scripts/cancel-task.sh <run> <task>
```

The script delegates to a TypeScript `requestCancel()` implementation. It:

1. reads the append-only ledger and locates the latest unmatched
   `task_started` by `dispatch_instance_id`;
2. refuses an ambiguous set of active instances rather than guessing;
3. loads only metadata whose run/task/agent/instance fields match that ledger
   entry, rejects symlinks or unsafe ownership/mode, and checks dispatcher
   liveness;
4. sends the authenticated request and waits up to five seconds for the clean
   acknowledgement; and
5. re-reads the ledger and succeeds only if the matching terminal event is
   `agent_cancelled` (an already-raced terminal event is reported accurately,
   not overwritten).

The script itself never signals the worker, removes a slot, closes a pane,
writes an `.exit` file, or appends/fixes the ledger. All state transition work
stays inside the running dispatcher's `cancel()` path. If the control endpoint
or dispatcher is gone, it exits nonzero with `dispatcher unavailable; no ledger
mutation performed`. That is a recovery condition, not permission to fabricate
a terminal event. Scenario 1's immediate liveness handling prevents an intact
dispatcher from leaving such a task dangling; a future crashed-dispatch
reconciler may append a distinct, evidence-backed `agent_lost` terminal event
only after proving both dispatcher and worker are absent.

### Append-only ledger requirements

Cancellation adds records; it never edits or deletes a prior `task_started`.
Every lifecycle event carries `agent_run_id` and `dispatch_instance_id`, allowing
reconstruction without count-based guessing. The recorder remains the sole
terminal-event writer and its idempotence guard resolves cancel-versus-exit and
cancel-versus-timeout races. Captures, worktree changes, and the worker branch
are preserved for forensics.

Required tests include successful cancellation in plain and pane modes,
cancellation while waiting for a concurrency slot, cancel/normal-exit race,
cancel/timeout race, repeated cancel, stale socket/nonce, PID reuse, duplicate
same-version dispatch ambiguity, dispatcher unavailable, slot release, pane
cleanup ordering, and exactly one matching terminal ledger event.

## Implementation order

1. Add `dispatch_instance_id` to lifecycle records and introduce the atomic
   supervisor snapshot/control metadata.
2. Refactor both worker loops onto `TaskHealthSampler`; add pane PID liveness and
   monotonic raw-capture timeout accounting.
3. Add loop signature parsers, two-stage detection, and clean auto-cancellation.
4. Add the read-only `status.sh` command over the shared parsers/snapshot.
5. Add the authenticated dispatcher control channel and `cancel-task.sh`.
6. Update operations/recovery documentation and run the dispatch, ledger, and
   recovery suites, including a real detached blocking-dispatch smoke test.
