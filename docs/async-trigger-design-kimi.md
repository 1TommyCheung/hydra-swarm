# Async trigger / hang-detection design codex

**Task:** #31 — Replace watcher-script polling with genuine async completion, add
hang-detection, live status, and clean cancellation for Hydra-Swarm worker
dispatch.

**Scope:** This document is a concrete design brief. It does not modify code; it
verifies each claimed scenario against the current implementation and prescribes
what to build next.

**Runtime note (run 0045):** the Bash implementation lane referenced below
(`dispatch.sh` Bash bodies, `HYDRA_HARNESS=bash`) was retired in run 0045
(`docs/bash-lane-retirement-plan.md`). `ts` is the default and only source
runtime; the no-Node rollback is `HYDRA_HARNESS=bin` with a pinned compiled
`HYDRA_BIN` (`~/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64`).
`HYDRA_HARNESS=bash` / `HYDRA_ADAPTER_RUNTIME=bash` now fail loudly with an
explicit retirement error rather than silently coercing to `ts`.

**Key files read for verification:**
- `kit/hydra-ts/src/dispatch.ts`
- `kit/hydra-ts/src/lib.ts`
- `kit/hydra/scripts/dispatch.sh`
- `docs/operations.md`
- `docs/task-result-review-contracts.md`
- `docs/state-and-worktrees.md`
- `docs/architecture.md`
- `docs/trust-and-permissions.md`
- `kit/hydra-ts/src/adapter-kimi.ts`
- `kit/hydra-ts/src/adapter-codex.ts`

## Conventions used below

```text
<repo-id>          := basename of the git repository
<state-root>       := $HYDRA_STATE_ROOT || ~/.local/state/<repo-id>-hydra
<run-dir>          := <state-root>/runs/run-<run-id>
<sessions-dir>     := <run-dir>/sessions
<ledger>           := <run-dir>/authoritative/ledger/events.jsonl
<task-spec>        := <run-dir>/tasks/<task-id>.yaml
<agent-run-id>     := <run-id>-<task-id>-v<spec-version>
```

All detector / status / cancel tooling is harness-side and therefore allowed to
read the ledger, session metadata, and worktree Git state. They must never write
to worker-owned capture files such as `<agent-run-id>.cli.jsonl` or the worker
inbox.

---

## 1. Scenario: Not running (process died / never started)

### Claim
Believed **solved** via `processAlive()` checks plus immediate exit detection.

### Verification
- `dispatch.ts` `defaultProcessAlive()` (`dispatch.ts:99-106`) is defined and
  injectable, but it is **only** used inside `openOpencodeMonitor()`
  (`dispatch.ts:697`) to decide whether the monitor should keep tailing. It is
  **not** consulted by the main dispatch loops.
- Plain-subprocess path (`runWorkerPlain`, `dispatch.ts:722-815`):
  - `spawn()` returns a `ChildProcessLike`.
  - `exitedPromise` resolves on `'exit'` or `'error'` (`dispatch.ts:754-766`).
  - The main loop (`dispatch.ts:777`) awaits `exitedPromise`; if the child dies
    or fails to start, `exited` becomes true and the loop terminates immediately.
  - **Conclusion:** plain mode detects process death and startup failure
    immediately through Node's `exit`/`error` events.
- Herdr-pane path (`runWorkerInHerdrPane`, `dispatch.ts:821-960`):
  - The loop (`dispatch.ts:919-938`) waits for `<agent-run-id>.exit` to appear.
  - It does **not** check the worker pid written to `<agent-run-id>.pid`
    (`dispatch.ts:823, 861`) inside the loop.
  - If the pane bash process dies from an external `kill -9` before it writes
    the sentinel, the loop will continue until the inactivity or hard-cap
    timeout fires.
  - **Conclusion:** pane mode does **not** immediately detect process death.

### Verdict
**Partially solved.** Plain mode is immediate; pane mode is not. The
`processAlive()` claim is incorrect as a general statement — the function exists
but is not wired into the main detection path.

### Proposed design
1. Add a dispatch-process pidfile:
   - Path: `<sessions-dir>/<agent-run-id>.dispatch.pid`
   - Written by `dispatch.ts` immediately after `acquireSlot()` succeeds and
     before `runWorker()` starts.
   - Removed in the `work.finally()` block (`dispatch.ts:1108-1112`) after a
     terminal ledger event is recorded.
2. In `runWorkerInHerdrPane()`, poll `processAlive(pid)` on each tick using the
   existing `<agent-run-id>.pid` file. If the process is gone and the sentinel
   does not exist, break the loop and record `agent_exited` with exit code `130`
   (or reuse `signalExitCode()` for the actual signal if known).
3. Provide a lightweight `orphan-detector` (can be the same logic used by
   `status.sh`) that scans the ledger for `task_started` events with no matching
   terminal event (`agent_exited`, `agent_cancelled`, `agent_timed_out`) and no
   live dispatch process. This is an **observability/reconciliation** step, not
   a cancellation path; it emits `observability_anomaly` and points the operator
   at recovery (see §cancel-task.sh).

---

## 2. Scenario: Loop-thinking (alive but not making progress)

### Claim
**Not solved.** The current timeout resets whenever *any* session capture file
changes size, so a worker that streams tokens or repeats the same failing tool
call indefinitely will never trip the inactivity timer.

### Data sources available to a detector
A loop detector can read all of the following without interfering with the
worker:

| Source | Path | What it tells us |
|---|---|---|
| Ledger | `<ledger>` | `task_started`, terminal events, `herdr_pane_started`, etc. |
| Capture files | `<sessions-dir>/<agent-run-id>.cli.jsonl` | Vendor event stream (Kimi assistant messages, Codex tool/file/command events). |
| Stderr | `<sessions-dir>/<agent-run-id>.stderr` | Repeated error messages, tee output. |
| OpenCode events | `<sessions-dir>/<agent-run-id>.events.jsonl` | `part.type=text/tool` stream. |
| Worker pidfile | `<sessions-dir>/<agent-run-id>.pid` | Existence when pane mode is on. |
| Dispatch pidfile | `<sessions-dir>/<agent-run-id>.dispatch.pid` | Proposed in §1; confirms the harness is alive. |
| Progress sink | `<sessions-dir>/<agent-run-id>.pane-progress.txt` | Harness-derived human-readable tail (Codex/Kimi pane mode). |
| Worktree Git | `<worktree>` | Last commit timestamp, dirty state, diff vs base. |
| Task spec | `<task-spec>` | `timeout_minutes`, `vendor`. |

### Proposed concrete detector: `detect-loop.sh` → `detect-loop.ts`

The detector runs as a harness-owned cron/one-shot process. It keeps a small
rolling state file and writes findings back to the ledger using the existing
append-only `ledgerAppend()` mechanism.

#### State file
```text
<run-dir>/.loop-detector/<agent-run-id>.state.json
```
Example:
```json
{
  "last_check_time": "2026-07-14T10:00:00Z",
  "last_capture_bytes": 123456,
  "last_git_dirty_hash": "sha256:abc...",
  "last_git_commit_time": "2026-07-14T09:55:00Z",
  "last_event_fingerprint": "md5:7d3...",
  "fingerprint_repeat_count": 3,
  "stagnant_seconds": 420
}
```

#### Inputs / thresholds
- `HYDRA_LOOP_WINDOW_MIN` — default `10`. Stagnation must persist this many
  minutes while capture files grow.
- `HYDRA_LOOP_REPEAT_THRESHOLD` — default `5`. Number of consecutive identical
  event fingerprints before a repetitive loop is declared.
- `HYDRA_LOOP_MIN_GROWTH_BYTES` — default `1024`. Ignore noise below this size
  delta.

#### Detection signals

**Signal A — Worktree stagnation with capture growth**
```python
capture_grew = current_capture_bytes - state.last_capture_bytes > MIN_GROWTH
git_changed  = current_git_dirty_hash != state.last_git_dirty_hash
commit_changed = current_git_commit_time != state.last_git_commit_time

if capture_grew and not git_changed and not commit_changed:
    state.stagnant_seconds += elapsed_since_last_check
else:
    state.stagnant_seconds = 0

if state.stagnant_seconds >= WINDOW_MIN * 60:
    flag("stagnant_loop")
```
- `current_capture_bytes` = total size of `.cli.jsonl`, `.stderr`, `.events.jsonl`
  (whichever exist).
- `current_git_dirty_hash` = SHA-256 of:
  - `git -C <worktree> status --porcelain`
  - `git -C <worktree> diff --name-status <base>...HEAD`
- `current_git_commit_time` = `git -C <worktree> log -1 --format=%ct HEAD`.

Rationale: a healthy implementer eventually produces a commit or at least a
changing dirty tree. If the vendor is streaming output but the worktree is
frozen, the agent is reasoning in circles or retrying a failing operation.

**Signal B — Repetitive tool-call / assistant-message fingerprint**
Vendor-specific fingerprint of the last *meaningful* event in the capture stream:

- **Kimi** (`kit/hydra-ts/src/adapter-kimi.ts:557-560` parses `role=assistant`):
  hash of `(role, content[:200])`.
- **Codex** (`dispatch.ts:550-592`):
  - `item.started` + `command_execution` → hash of `command[:200]`.
  - `item.started` + `file_change` → hash of sorted changed paths.
  - `item.started` + `mcp_tool_call` → hash of `server.tool`.
  - `item.completed` + `agent_message` → hash of `text[:400]`.
- **OpenCode** (`dispatch.ts:639-652`):
  - `part.type=text` → hash of `text[:400]`.
  - `part.type=tool` → hash of `tool` + `state.title`.
- **Claude**: no streaming JSONL; rely on Signal A and Signal C.

```python
fp = fingerprint_last_event(vendor, capture_file)
if fp == state.last_event_fingerprint:
    state.fingerprint_repeat_count += 1
else:
    state.fingerprint_repeat_count = 0
    state.last_event_fingerprint = fp

if state.fingerprint_repeat_count >= REPEAT_THRESHOLD:
    flag("repetitive_loop")
```

**Signal C — Repeated identical stderr lines**
```python
# Tail last 50 non-empty lines of .stderr; if any line accounts for > 60%, flag.
stderr_tail = tail(stderr_path, 50)
if stderr_tail:
    most_common_ratio = max(count(line) for line in stderr_tail) / len(stderr_tail)
    if most_common_ratio > 0.6:
        flag("error_loop")
```

#### Action on detection
The detector appends one event to the ledger:
```json
{"time":"...","event":"observability_anomaly","run_id":"0042","task_id":"...","vendor":"...","agent_run_id":"...","reason":"loop_detected","detail":"stagnant_loop|repetitive_loop|error_loop","idle_sec":"420"}
```
It then **invokes** the clean cancellation path (§cancel-task.sh) rather than
killing anything itself. Loop detection is advisory-to-actionable: it records
its finding first, then cancels, so the ledger always shows *why* the task
stopped.

#### Detector invocation model
- **Synchronous:** call it from the dispatch polling loop in `dispatch.ts` once
  per `pollIntervalMs` tick. This reuses the loop's existing timing and avoids a
  separate daemon. Cost: one small JSON state read + one `git` invocation per
  tick. Recommended.
- **Asynchronous one-shot:** a standalone `detect-loop.sh <run> <task>` that the
  lead can run or schedule. This is useful for monitoring background dispatches
  from a separate shell.

Recommended default: integrate into the dispatch loop, with an environment
override `HYDRA_LOOP_DETECTOR=0` to disable.

---

## 3. Scenario: Running too long (wall-clock / inactivity timeout)

### Claim
Believed **solved** via `timeout_minutes` (inactivity window) plus a
`HYDRA_HARD_CAP_MIN` wall-clock backstop.

### Verification
- `dispatch.ts` `runWorkerPlain` (`dispatch.ts:769-800`):
  - `limit = timeoutMinutes * 60_000`
  - `hardCap = Number(env.HYDRA_HARD_CAP_MIN || timeoutMinutes * 6) * 60_000`
  - On each tick `waited` and `elapsed` increase by `pollIntervalMs`.
  - `plainActivity()` computes a signature from all files matching
    `<agent-run-id>.*` in `<sessions-dir>`.
  - If the signature changes, `waited` resets to 0 (`dispatch.ts:795-799`).
- `dispatch.ts` `runWorkerInHerdrPane` (`dispatch.ts:913-938`): identical
  semantics, using `herdrActivity()` (`.cli.jsonl` + `.stderr`).
- `dispatch.sh` (`dispatch.sh:239-246`, `dispatch.sh:335-344`,
  `dispatch.sh:379-388`): mirrored the same `limit`/`hard_cap` logic in Bash at
  verification time; that Bash body was retired in run 0045 and `dispatch.sh`
  is now a `ts`/`bin` launcher only.

### Verdict
**Confirmed solved.** The inactivity window resets on capture-file growth, and
the hard cap is a true wall-clock ceiling. No design change required for this
scenario, but the status command (§4) should expose both budgets so operators
can see remaining time.

---

## 4. Scenario: Live status visibility

### Claim
**Not solved.** Today the only live view is tailing a herdr pane or manually
inspecting files. There is no one-shot command that returns a structured
snapshot.

### Proposed command
```bash
bash kit/hydra/scripts/status.sh <run-id> <task-id> [--lines N] [--json]
```
Default output is human-readable text; `--json` emits a machine-readable object.

#### What it reports
| Field | Source | Purpose |
|---|---|---|
| `state` | ledger | One of `running`, `completed`, `cancelled`, `timed_out`, `failed_start`, `unknown`. |
| `agent_run_id` | task spec | Deterministic id for the task version. |
| `vendor` | task spec | claude / codex / kimi / opencode. |
| `dispatch_pid` | `<agent-run-id>.dispatch.pid` (proposed) | PID of the harness dispatch process. |
| `worker_pid` | `<agent-run-id>.pid` | Pane-mode worker pid (if present). |
| `elapsed_seconds` | ledger `task_started` time vs now | Wall time since dispatch. |
| `inactivity_budget_seconds` | task spec `timeout_minutes` | Seconds of capture inactivity allowed before `agent_timed_out` (reason `stalled`). |
| `hard_cap_seconds` | `HYDRA_HARD_CAP_MIN` or `timeout_minutes * 6` | Absolute wall-clock ceiling. |
| `remaining_hard_cap_seconds` | computed | `hard_cap_seconds - elapsed_seconds`. |
| `progress_tail` | harness progress file | Last N lines of live progress (pane mode). |
| `last_git_activity` | worktree git | `{commit_time, commit_sha, dirty_files_count, changed_vs_base_count}`. |
| `last_ledger_events` | ledger | Last 5 events for this task. |
| `pane_id` | ledger `herdr_pane_started` event | For `herdr pane list` cross-check. |
| `warnings` | computed | e.g. `dispatch process not found`, `terminal event missing`. |

#### Data-reading rules (does not touch worker-owned files)
- **Progress tail:**
  - Codex/Kimi pane mode → read `<sessions-dir>/<agent-run-id>.pane-progress.txt`
    (written by `dispatch.ts` `pollJsonlFile()` from the worker's `.cli.jsonl`).
  - OpenCode pane mode → read `<sessions-dir>/<agent-run-id>.monitor.txt`.
  - Plain mode / pane disabled → report `progress_tail: null` and explain that
    live progress is unavailable.
- **Git activity:** run read-only `git -C <worktree> log/status/diff` commands.
  The worktree is harness-created and outside the state store.
- **Ledger:** read-only tail/scan of `<ledger>`.
- **Process state:** read pidfiles only; never `kill -0` unless the pidfile is
  harness-owned (`<agent-run-id>.dispatch.pid` or `<agent-run-id>.pid`).

#### Output example (text)
```text
run 0042 task canvas-node-validation (agent_run_id 0042-canvas-node-validation-v1)
state: running | vendor: kimi | dispatch_pid: 98234
elapsed: 00:12:34 | inactivity budget: 45m | hard-cap remaining: 02:37:26
progress tail (last 5 lines):
  [tool] Bash:0 > git status
  [tool] Bash:0 > npm test
  [tool] Bash:0 > npm test
  [tool] Bash:0 > npm test
  [tool] Bash:0 > npm test
last git activity: 2026-07-14T09:58:12Z (commit 7a3b2c1, 0 dirty files)
warning: repetitive tool-call fingerprint detected 5 times — possible loop
```

#### Implementation sketch
Add `kit/hydra-ts/src/status.ts` and a thin `kit/hydra/scripts/status.sh` wrapper
that resolves Node 22.6+ exactly like `dispatch.sh` does. The TypeScript module
imports `lib.ts` helpers (`ledger`, `runDir`, `yamlScalar`, etc.) so it stays
consistent with the rest of the harness.

```typescript
export function status(runId: string, taskId: string, options: StatusOptions): StatusReport {
  const runDir = lib.runDir(runId);
  const spec = readTaskSpec(join(runDir, 'tasks', `${taskId}.yaml`));
  const agentRunId = `${runId}-${taskId}-v${spec.specVersion}`;
  const ledgerEvents = readLedgerForTask(runDir, taskId);
  const terminal = findTerminalEvent(ledgerEvents);
  const state = terminal ? terminalToState(terminal) : 'running';

  return {
    state,
    agent_run_id: agentRunId,
    vendor: spec.vendor,
    dispatch_pid: readPid(join(runDir, 'sessions', `${agentRunId}.dispatch.pid`)),
    worker_pid: readPid(join(runDir, 'sessions', `${agentRunId}.pid`)),
    elapsed_seconds: elapsedSince(ledgerEvents, 'task_started'),
    inactivity_budget_seconds: spec.timeoutMinutes * 60,
    hard_cap_seconds: hardCapSeconds(spec.timeoutMinutes),
    remaining_hard_cap_seconds: ..., // computed
    progress_tail: tailProgress(runDir, agentRunId, spec.vendor, options.lines ?? 20),
    last_git_activity: gitActivity(spec.worktree, spec.baseCommit),
    last_ledger_events: ledgerEvents.slice(-5),
    pane_id: paneIdFromLedger(ledgerEvents),
    warnings: buildWarnings(state, ...),
  };
}
```

---

## 5. `cancel-task.sh` design

### Requirement
Cancel a running task through `dispatch.ts`'s own clean `cancel()` path. A bare
`kill -9 <worker>` bypasses exit handlers and leaves a dangling `task_started`
ledger entry; this design must avoid that.

### Current cancellation machinery in `dispatch.ts`
- `makeExitRecorder()` returns a `cancel()` function (`dispatch.ts:317-332`).
- `cancel()`:
  1. Sets `wasCancelled = true`.
  2. Calls `ctx.killTree(workerPid)` (SIGTERM + best-effort SIGKILL after 2s).
  3. Calls `finish('agent_cancelled', [], '130')`, which appends to the ledger
     and writes the `.exit` sentinel.
  4. Closes the herdr pane (best effort).
- `register()` (`dispatch.ts:347-365`) installs `SIGINT`/`SIGTERM`/`SIGHUP`
  handlers that call `cancel()` and then exit 130.
- Programmatic callers can pass an `AbortSignal` in `DispatchOptions.signal`;
  aborting it triggers the same `cancel()`.

### Proposed command
```bash
bash kit/hydra/scripts/cancel-task.sh <run-id> <task-id> [--wait-seconds N]
```

### Cancellation protocol
1. **Resolve the dispatch pid.**
   - Primary: read `<sessions-dir>/<agent-run-id>.dispatch.pid` (proposed in §1).
   - Fallback: `pgrep -f "dispatch\.ts ${run_id} ${task_id}"` or
     `pgrep -f "dispatch\.sh ${run_id} ${task_id}"`, validating the command
     line contains both ids.
2. **Validate state.**
   - Scan `<ledger>` for the most recent events for this task.
   - If a terminal event already exists (`agent_exited`, `agent_cancelled`,
     `agent_timed_out`), print the event and exit 0 (idempotent no-op).
   - If no `task_started` event exists, exit with error.
3. **Send SIGTERM to the dispatch process.**
   - This is the clean trigger. The dispatch process's own handler calls
     `cancel()`, records `agent_cancelled`, and reaps the worker tree.
   - `cancel-task.sh` **must not** send SIGTERM/SIGKILL directly to the worker
     pid or to the herdr pane process.
4. **Wait for the ledger to close.**
   - Poll `<ledger>` every 500ms for up to `--wait-seconds` (default 15).
   - Look for `agent_cancelled` (or any terminal event) for this task.
   - If it appears, print success and exit 0.
5. **Escalation only if the dispatch process ignores SIGTERM.**
   - If the dispatch process is still alive after the wait window and no
     terminal event was written, send **SIGKILL to the dispatch process only**.
   - This is a last-resort; even then, the worker tree should already have been
     reaped by `dispatch.ts` if the SIGTERM handler ran at all.
   - If SIGKILL succeeds and a terminal event still does not appear, report an
     orphan task and exit non-zero. Do **not** hand-patch the ledger; point the
     operator at `herdr-push.sh --notify` / reconciliation, which already emits
     `observability_anomaly` on ledger-vs-live disagreement.

### Why this respects the append-only ledger
- `cancel-task.sh` never rewrites or deletes events from `<ledger>`.
- In the normal path it causes `dispatch.ts` to append `agent_cancelled` via the
  existing `finish()` writer.
- In the failure path it reports an orphan; any manual recovery must also append
  a new event (e.g. `agent_cancelled` with `source:manual_recovery`) rather than
  edit existing lines. This matches the ledger principle in
  `task-result-review-contracts.md` §7: "Append-only ... harness-written."

### Idempotency and safety
- If the task already terminated, the command succeeds and prints the existing
  terminal event.
- If the dispatch pidfile is stale and points to an unrelated process, the
  command-line validation in step 2 rejects it.
- At verification time, a task started with the Bash harness
  (`HYDRA_HARNESS=bash`) had an equivalent trap in `dispatch.sh`
  (`dispatch.sh:107-118`) recording `agent_cancelled`. That lane was retired in
  run 0045: `HYDRA_HARNESS=bash` now fails loudly, and the TypeScript
  `dispatch.ts` trap is the only live cancellation path.

---

## 6. Recommended build order

1. Add `<agent-run-id>.dispatch.pid` to `dispatch.ts` (and `dispatch.sh` for
   parity) — unblocks both `status.sh` and `cancel-task.sh`.
2. Add `processAlive()` check to the herdr-pane loop in `dispatch.ts` to close
   the "not running" gap in pane mode.
3. Implement `status.ts` + `status.sh` using only harness-owned data sources.
4. Implement `cancel-task.sh` as a SIGTERM-to-dispatch wrapper with ledger-wait.
5. Implement the loop detector inside the `dispatch.ts` polling loop, writing
   `observability_anomaly` and calling `cancel-task.sh` on detection.
6. Add harness tests that simulate:
   - child exit before sentinel (pane mode),
   - repetitive tool-call stream,
   - stagnant capture growth with no git change,
   - clean cancellation via SIGTERM.

---

## 7. Open questions to resolve during implementation

- Should the loop detector be on by default, or default-off behind
  `HYDRA_LOOP_DETECTOR=1` until it is calibrated on real runs?
- Should `cancel-task.sh` support a `--force-orphan-append` mode for fully dead
  dispatch processes, or should orphan recovery remain a separate
  reconciliation-only operation?
- What is the desired false-positive tolerance for Signal A on long-running
  reasoning tasks that legitimately produce many tokens before the first commit?
  (Initial proposal: 10-minute window with reset on any meaningful event
  fingerprint change.)
