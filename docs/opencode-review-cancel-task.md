# Independent adversarial review — cancel-task (Task #31, run 0011)

- **Reviewer:** Claude (adversarial pass before promotion).
- **Scope:** the ACTUAL candidate code on branch `hydra/0011/opencode-review-cancel`
  (base `cb3ccfb`), not just the design docs.
  - `kit/hydra-ts/src/cancel-task.ts`
  - `kit/hydra/scripts/cancel-task.sh`
  - `kit/hydra-ts/test/cancel-task.test.ts`
  - `kit/hydra-ts/test/cancel-task.sh.test.ts`
- **Design docs read for context (read-only):** `docs/async-trigger-design-codex.md`,
  `docs/async-trigger-design-kimi.md`, `docs/opencode-review-async-trigger.md`.
- **Cross-reference code read for signal/pidfile lifecycle:** `kit/hydra-ts/src/dispatch.ts`,
  `kit/hydra-ts/src/status.ts`.
- **Method:** fresh line-by-line reading of both implementations, every exit path traced,
  every signal-delivery call checked for identity validation, and every test assessed for
  whether it genuinely exercises the adversarial scenario or only the happy path.
- **No source code files were modified for this review.**

---

## Summary

The implementation's **observer-only / never-fabricate** contract is sound: every
`exit 0` path requires a real terminal ledger event, and the orphan path throws with
exit code 1. The SIGTERM → wait → SIGKILL escalation flow is structurally correct.

The implementation's **never-signal-the-wrong-process** contract has one significant
gap: the primary PID resolution path (the dispatch pidfile) trusts the file's PID
without verifying the process's command-line identity, while the pgrep fallback
(concurrency_wait path) does validate it. A stale pidfile left behind by a SIGKILLed
dispatch process whose PID was subsequently reused by an unrelated process can cause
cancel-task to deliver SIGTERM and SIGKILL to an innocent process.

The bash fallback maintains the same core safety properties as the TS implementation
and shares the same pidfile-trust gap. Test coverage for adversarial scenarios is
strong in the TS suite but minimal in the bash suite.

---

## Findings

### 1. Pidfile path trusts PID without command-line identity validation — severity: HIGH

- **Location:** `kit/hydra-ts/src/cancel-task.ts:293-295` (TS);
  `kit/hydra/scripts/cancel-task.sh:85-89` (bash).
- **Code (TS):**
  ```ts
  if (existsSync(pidfilePath)) {
    const pid = readPidfile(pidfilePath);
    if (pid !== undefined && safeProcessAlive(processAlive, pid)) dispatchPid = pid;
  } else if (isLastEventConcurrencyWait(snapshot.events)) {
    // ... pgrep fallback with isDispatchCommand validation ...
  }
  ```
- **Issue:** When the dispatch pidfile exists and the PID it contains is alive, the
  PID is used unconditionally as the signal target. No command-line validation
  (`isDispatchCommand`) is performed. The `else if` branch — the only code path that
  calls `isDispatchCommand` — is entered **only** when the pidfile does NOT exist.
  The pidfile path is the **primary** path (checked first) and covers the common case
  of a running task that has acquired its concurrency slot.

  The dispatch process writes the pidfile via `writeAtomic` (`dispatch.ts:1177`) and
  removes it in three cleanup paths: `work.finally()` (`dispatch.ts:1181`), the outer
  `catch` (`dispatch.ts:1204`), and `process.once('exit', releaseOnExit)`
  (`dispatch.ts:1172`). All three are bypassed by **SIGKILL** — the very signal
  cancel-task's own escalation path delivers (`cancel-task.ts:393`). No `exit` event
  fires, no `finally` runs, the pidfile is left behind as stale state.

- **Concrete failure scenario:**
  1. Dispatch process starts with PID 12345, writes `12345` to the pidfile.
  2. Operator runs `cancel-task.sh 0011 task-a`. Dispatch does not respond to SIGTERM
     within the wait window (stuck in a synchronous operation, unresponsive event loop).
  3. cancel-task escalates to SIGKILL (`cancel-task.ts:393`). Dispatch is killed
     instantly — no exit handler runs, pidfile is **not** removed.
  4. cancel-task reports ORPHAN (exit 1). The ledger has no terminal event.
  5. Time passes. The OS reuses PID 12345 for an unrelated process (a build server, a
     database, a shell — PIDs wrap at ~100K on macOS and ~32K on Linux default, so
     reuse can happen within seconds on an active system).
  6. Operator (or an automated retry) runs `cancel-task.sh 0011 task-a` again.
  7. `existsSync(pidfilePath)` → true. `readPidfile` → 12345. `safeProcessAlive` →
     true (the reused PID is alive). `dispatchPid = 12345`.
  8. Ledger re-read finds no terminal event (dispatch was SIGKILLed before writing one).
  9. Liveness check on 12345 → alive. **SIGTERM delivered to the wrong process.**
  10. If the wrong process dies or ignores SIGTERM, cancel-task escalates to **SIGKILL
      on the wrong process** after the wait window.

  The design doc claims this is handled: *"If the dispatch pidfile is stale and points
  to an unrelated process, the command-line validation in step 2 rejects it."*
  (`docs/async-trigger-design-kimi.md` §Idempotency and safety). But step 2 in that
  design is ledger scanning, not command-line validation, and the implementation's
  command-line validation is only in the pgrep fallback (step 1). The claimed safety
  property is not realized.

- **Suggested fix:** After reading the pidfile and confirming liveness, verify the
  process identity by reading its command line (`ps -p <pid> -o command=` in bash;
  `defaultListProcesses` filtered to the PID in TS) and running `isDispatchCommand`. If
  the command does not match, treat the pidfile as stale (skip the PID, fall through to
  the pgrep/orphan path). This mirrors the validation already applied in the pgrep
  fallback and closes the gap.

---

### 2. No re-validation of process identity at SIGKILL escalation time — severity: MEDIUM

- **Location:** `kit/hydra-ts/src/cancel-task.ts:378-399`; `kit/hydra/scripts/cancel-task.sh:159-167`.
- **Code (TS):**
  ```ts
  if (safeProcessAlive(processAlive, dispatchPid)) {
    // ...ledger re-read...
    if (safeProcessAlive(processAlive, dispatchPid)) {
      try {
        signalProcess(dispatchPid, 'SIGKILL');
```
- **Issue:** Between initial PID resolution and the SIGKILL call, at least `waitSeconds`
  (default 15s) have elapsed. During this window the dispatch process may have exited
  and its PID reused. The escalation path checks **liveness** (is the PID alive?) but
  not **identity** (is it still the same dispatch process?). For the pgrep-resolved PID,
  identity was validated at resolution time but not re-validated 15+ seconds later.
  Combined with Finding 1 (pidfile path never validated identity at all), this means the
  SIGKILL can be delivered to a process that was never confirmed to be the dispatcher.

- **Concrete failure scenario:** Same as Finding 1 step 5-10, but the PID reuse happens
  during the SIGTERM wait window rather than between two separate cancel-task
  invocations. Dispatch handles SIGTERM partially (exits at T=5s without writing
  terminal event due to a crash in `killTree`). PID is reused by T=10s. At T=15s,
  cancel-task checks liveness → alive → SIGKILL on wrong process.

- **Note:** This is inherent in Unix PID-based signaling (you cannot atomically verify
  identity and deliver a signal). The standard mitigation is to verify process identity
  immediately before the signal, which the code does not do. For the pgrep path, the
  practical risk is low (the reused process must happen to be alive at the exact moment
  of the liveness check). For the pidfile path, the risk is elevated because identity
  was never established (Finding 1).

---

### 3. `isDispatchCommand` substring validation is tight — no issue found

- **Location:** `kit/hydra-ts/src/cancel-task.ts:186-198`; `kit/hydra/scripts/cancel-task.sh:91-104`.
- **Analysis:** The task asked whether a task_id/run_id that is a substring of another
  task's id could cause a false match (e.g. task `"foo"` matching a process running
  task `"foo-bar"`). The answer is **no**. `args.includes(runId)` and
  `args.includes(taskId)` perform exact token equality after whitespace-splitting. The
  token `"foo-bar"` is not equal to `"foo"`, so no false match occurs. The unit test at
  `cancel-task.test.ts:298-301` confirms this: searching for `run-1` does not match a
  process running `run-10`. The bash equivalent uses `[ "$clean" = "$run_id" ]` (string
  equality), which is similarly exact.

  One platform-level caveat: `ps -axo command=` joins argv with spaces, so a task_id
  containing whitespace (e.g. `"foo bar"`) would appear as two tokens and could
  theoretically be matched by searching for `"foo"`. This is not a practical concern
  since task_ids are conventionally single-word identifiers, but the tokenization
  approach cannot distinguish `dispatch.ts run-1 "foo bar"` from
  `dispatch.ts run-1 foo bar`.

---

### 4. Orphan contract is honored in every exit path — no issue found

- **Location:** All exit paths in `kit/hydra-ts/src/cancel-task.ts:242-415` and
  `kit/hydra/scripts/cancel-task.sh:72-177`.
- **Analysis:** Every code path that returns a result (and thus causes `main()` to
  return 0) requires a `terminal_event` read from the ledger:
  - Already terminal at entry (`cancel-task.ts:270-278`): returns `snapshot.terminalEntry`.
  - Already terminal after PID resolution re-read (`:314-323`): returns snapshot terminal.
  - SIGTERM failed, terminal found on re-read (`:330-342`): returns ledger terminal.
  - Wait window produced a terminal (`:344-362`): returns `waitForTerminal` result.
  - Pre-escalation re-read found terminal (`:366-375`, `:378-389`): returns ledger terminal.
  - Post-SIGKILL grace produced terminal (`:402-411`): returns ledger terminal.

  The only path that does NOT return a terminal event is the final `throw orphanError(dispatchPid)`
  at `:414`, which causes `main()` to catch and return 1. The bash equivalent is
  `hydra_die "ORPHAN: ..."` at `:177`, which exits non-zero.

  Neither implementation ever writes to the ledger — confirmed by the absence of any
  `appendFileSync`/`writeFileSync`/`>>` operation on the ledger path in either file. The
  TS test at `cancel-task.test.ts:262-263` explicitly asserts the ledger content is
  unchanged after the orphan path.

---

### 5. Bash fallback has structural parity with TS for core safety properties — no new safety divergence

- **Location:** `kit/hydra/scripts/cancel-task.sh` (entire file) vs `kit/hydra-ts/src/cancel-task.ts`.
- **Analysis:** The bash fallback (`HYDRA_HARNESS=bash`) was compared line-by-line
  against the TS implementation for the following safety properties:

  | Property | TS | Bash | Parity |
  |---|---|---|---|
  | Observer-only (no ledger writes) | ✓ | ✓ | **Same** |
  | Never signals worker PID/pane | ✓ (signals dispatchPid only) | ✓ (signals dispatch_pid only) | **Same** |
  | Pidfile trust without identity check | Vulnerable (`:293-295`) | Vulnerable (`:85-89`) | **Same gap (Finding 1)** |
  | pgrep fallback validates command | ✓ (`isDispatchCommand`) | ✓ (`command_matches_dispatch`) | **Same** |
  | Multiple-match refusal | ✓ (`:302-304`) | ✓ (`:114-115`) | **Same** |
  | SIGTERM → wait → SIGKILL escalation | ✓ (`:328-399`) | ✓ (`:131-167`) | **Same** |
  | Liveness check before each signal | ✓ (`:324`, `:378`, `:391`) | ✓ (`:129`, `:159`, `:165`) | **Same** |
  | Orphan reporting (no fabrication) | ✓ (`:414`) | ✓ (`:177`) | **Same** |
  | Pre-signal ledger re-read (race close) | ✓ (`:314`) | ✓ (`:124`) | **Same** |
  | Kill grace after SIGKILL | configurable (`killGraceMs`, default 2000) | hardcoded `sleep 2` | **Equivalent** |
  | Poll interval | configurable (`pollIntervalMs`, default 500) | hardcoded `sleep 0.5` | **Equivalent** |

  The bash fallback correctly mirrors the TS implementation's safety structure. Both
  share the same pidfile-trust gap (Finding 1). The only non-cosmetic divergence is in
  the pgrep pre-filter (see Finding 6 below).

---

### 6. Bash pgrep pre-filter treats run_id as extended regex — severity: LOW

- **Location:** `kit/hydra/scripts/cancel-task.sh:112`.
- **Code:**
  ```bash
  done < <(pgrep -f "$run_id" 2>/dev/null || true)
  ```
- **Issue:** `pgrep -f` interprets its argument as an extended regular expression, not
  a literal string. If `run_id` contains regex metacharacters (`.`, `+`, `*`, `[`, etc.),
  the pre-filter could match unintended processes or, more importantly, fail to match
  the actual dispatch process (false negative). The TS equivalent (`defaultListProcesses`)
  scans all processes and filters with literal `args.includes(runId)`.

- **Impact on safety:** False positives from the regex pre-filter are harmless — the
  subsequent `command_matches_dispatch` validation requires exact token equality for
  both `run_id` and `task_id`, so a spuriously matched process is rejected. False
  negatives (missing the real dispatch) would cause cancel-task to fail with "dispatch
  process not found" rather than signal the wrong process — a safe failure mode.

- **Concrete scenario:** `run_id` = `task.1` → `pgrep -f "task.1"` matches any process
  whose command contains `taskX1` for any character X. The real dispatch process with
  literal `task.1` in its command also matches (since `.` matches itself). So in
  practice the regex pre-filter is permissive, not restrictive, for simple identifiers.
  The divergence only matters if `run_id` contains characters that change regex
  semantics in a way that excludes the literal match (e.g., `run_id` = `001+1` would
  require one or more `1`s, but `001+1` as a literal PID is unlikely).

- **Suggested fix:** Use `pgrep -fF` pattern or quote the regex: `pgrep -f "$(printf '%s' "$run_id" | sed 's/[.[\*^$()+?{|]/\\&/g')"` — or simply fall back to scanning all processes like the TS version does (`ps -axo pid=,command=`).

---

## Categories examined and found sound (no new issue)

- **`isDispatchCommand` exact-token matching.** `args.includes(runId) && args.includes(taskId)`
  after whitespace tokenization is immune to substring false matches (`cancel-task.ts:186-198`).
  The bash equivalent uses `[ "$clean" = "$run_id" ]` string equality (`cancel-task.sh:100-101`).
  Both correctly reject `"foo"` matching `"foo-bar"`. ✔
- **Atomic pidfile publication.** `dispatch.ts:writeAtomic` (`:514-525`) uses tmp+rename.
  cancel-task reads via `readPidfile` which validates `^\d+$` and `Number.isSafeInteger`
  (`cancel-task.ts:143-152`). No partial pidfile is observable. ✔
- **Idempotency of cancel.** Running cancel-task twice for the same task: the second
  invocation finds the terminal event written by the first and returns `already_terminal`
  (`cancel-task.ts:270-278`). No double-signaling. ✔
- **Concurrency_wait fallback scoping.** The pgrep fallback is only entered when the
  pidfile is absent AND the last event is `concurrency_wait` (`cancel-task.ts:296`). This
  correctly targets the queued-task case where no pidfile exists yet. Once a slot is
  acquired and the pidfile is written, the primary path takes over. ✔
- **Orphan ledger integrity.** Verified by test `cancel-task.test.ts:242-264`: the ledger
  is byte-for-byte unchanged after the orphan path, and the event list is still
  `['task_started']`. Neither implementation contains any write operation on the ledger
  path. ✔
- **`waitForTerminal` bounded wait.** The polling loop (`cancel-task.ts:216-234`) is
  bounded by `waitMs` and uses `Math.min(pollIntervalMs, waitMs - elapsed)` to avoid
  overshoot. No unbounded loop. ✔
- **`safeProcessAlive` error suppression.** Both liveness checks and signal delivery are
  wrapped in try/catch (`cancel-task.ts:204-210`, `:328-342`, `:392-398`). A failing
  `processAlive` probe is treated as "not alive," preventing a signal to an
  unverifiable PID. ✔

---

## Test coverage assessment

### `cancel-task.test.ts` (TS unit tests) — 8 tests

| Scenario | Test | Genuinely exercised? |
|---|---|---|
| Already-terminal idempotent no-op | `:132-153` | ✓ Happy path |
| Missing task attempt rejection | `:155-166` | ✓ Error path |
| Cancel via pidfile (mock PID) | `:168-187` | ✓ Happy path, but **mock `processAlive` trusts PID without identity check** — does not test stale-pidfile/PID-reuse |
| pgrep fallback with validated match | `:189-218` | ✓ Includes non-matching processes (different task_id, non-dispatch script) |
| SIGKILL escalation | `:220-240` | ✓ Exercises SIGTERM → no event → SIGKILL |
| Orphan reporting | `:242-264` | ✓ Verifies ledger unchanged, both SIGTERM+SIGKILL sent, ORPHAN error |
| Dead dispatcher (no SIGKILL) | `:266-287` | ✓ Dispatcher dies between SIGTERM and escalation |
| `isDispatchCommand` substring safety | `:289-302` | ✓ Tests `run-1` vs `run-10` exact token matching |

**Coverage gaps:**
- **No test for stale pidfile with PID reuse.** The pidfile path (`:293-295`) trusts the
  PID without identity validation (Finding 1). Test `:168-187` uses a mock that returns
  true only for the exact dispatch PID, but never tests the case where the pidfile points
  to a live PID that is NOT the dispatch process. This is the most significant gap — the
  primary vulnerability is untested.
- **No test for process identity re-validation at escalation.** Finding 2 is not
  exercised: no test simulates the dispatch PID dying and being reused during the
  wait window.
- **`isDispatchCommand` tests are minimal.** Only 3 cases (exact match, wrong script,
  run-1 vs run-10). No tests for: `dispatch.sh` basename, quoted arguments, task_id
  substring (e.g. `task-a` vs `task-aa`), task_id appearing in a flag value.

### `cancel-task.sh.test.ts` (bash integration test) — 1 test

| Scenario | Test | Genuinely exercised? |
|---|---|---|
| Cancel via pidfile (real process) | `:112-161` | ✓ Happy path with a real bash dispatcher |

**Coverage gaps (significant):**
- **No test for pgrep/concurrency_wait fallback path.** The entire `command_matches_dispatch`
  / `pgrep` branch (`cancel-task.sh:90-119`) is untested.
- **No test for SIGKILL escalation.** The escalation path (`:159-167`) is untested.
- **No test for orphan reporting.** The ORPHAN exit path (`:177`) is untested.
- **No test for already-terminal idempotency.** The early-return path (`:74-77`) is untested.
- **No test for wrong-process filtering.** No test verifies that `command_matches_dispatch`
  rejects non-matching processes.

The bash test suite has **1 test vs 8 in the TS suite**. This is consistent with the
documented pattern in `docs/opencode-review-async-trigger.md` (findings #1/#6) where the
bash fallback silently diverged from the TS implementation due to insufficient test
coverage. While the current bash implementation appears structurally correct (Finding 5),
the lack of adversarial tests means future regressions could go undetected.

---

## Suggested additional checks

1. **Add a stale-pidfile test (TS):** Create a fixture where the pidfile points to a PID
   that is alive but whose command line is NOT a dispatch command for this run/task.
   Assert that cancel-task either rejects it or falls through to the pgrep path, rather
   than signaling the wrong PID. (Finding 1)

2. **Add identity re-validation before SIGKILL (TS):** Test that when the dispatch PID is
   reused by a non-dispatch process during the wait window, the SIGKILL path detects the
   mismatch and does not signal. This requires implementing identity validation in the
   escalation path. (Finding 2)

3. **Add bash adversarial tests:** At minimum: escalation-to-SIGKILL, orphan reporting,
   concurrency_wait/pgrep fallback with a non-matching process, and already-terminal
   idempotency. These mirror the TS tests and would catch silent divergences.
   (Finding 5 / test coverage)

4. **Add a `pgrep -f` regex safety test (bash):** Test with a `run_id` containing regex
   metacharacters to verify the pre-filter doesn't cause false negatives. (Finding 6)

5. **Consider cross-harness parity smoke test:** Run the same fixture through both
   `HYDRA_HARNESS=ts` and `HYDRA_HARNESS=bash` and compare exit codes, signal targets,
   and output for the orphan and escalation paths.
