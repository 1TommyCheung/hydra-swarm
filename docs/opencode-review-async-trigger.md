# Independent adversarial review — async completion + hang detection (Task #31)

- **Reviewer:** Claude (third-vendor, uninvolved in the Kimi-implements / Codex-reviews cycle).
- **Scope:** the ACTUAL code on master, not the design docs.
  - `kit/hydra-ts/src/dispatch.ts`
  - `kit/hydra-ts/src/status.ts`
  - `kit/hydra/scripts/status.sh`
  - `kit/hydra-ts/test/dispatch.test.ts`, `kit/hydra-ts/test/status.test.ts`
- **Design docs read for context (read-only):** `docs/async-trigger-design-codex.md`, `docs/async-trigger-design-kimi.md`.
- **Method:** fresh reading of the implementation plus a grep for every existing ledger consumer of `exit_code` / `reason` / `agent_exited` (`herdr-push.ts`, `review-dispatch.ts`, `review-dispatch.sh`, `promote.ts`, `run-boundary-tests.sh`).
- **Baseline verification (advisory):** `node --experimental-strip-types --test test/status.test.ts` → 19/19 pass; `… test/dispatch.test.ts` → 46/46 pass. No source files were modified for this review.

Each finding below labels whether it is **genuinely new** or **already covered by a design doc / prior round**, and carries a concrete failure scenario plus a severity. I did not manufacture concerns: categories I examined and found sound are listed explicitly at the end.

---

## Findings

### 1. `status` reports a disappeared worker as `state: completed` — NEW — severity: medium-high

- **Location:** `kit/hydra-ts/src/status.ts:142` (`determineState`).
- **Code:**
  ```ts
  if (event === 'agent_exited') return 'completed';
  ```
- **Scenario:** When a pane-hosted worker dies before writing its exit sentinel, `dispatch.ts:980` records `agent_exited` with `exit_code: "127"` and `reason: "worker_disappeared"`. `status.ts` maps **any** `agent_exited` to `state: "completed"`. The `127` / `worker_disappeared` distinction survives only inside the `ledger_events` detail array; the top-level `state` field (text and `--json`) is indistinguishable from a clean exit. A machine consumer that keys on `state === "completed"` (e.g. a future gating/promotion check, or an operator dashboard) will treat a worker that vanished without producing a result as a successful completion, with `disagreement: null` (the pidfile is removed on the terminal path, so no ledger-vs-pidfile disagreement fires either).
- **Why this is new:** The codex design (`docs/async-trigger-design-codex.md:96-98`) only states that `agent_exited` must be kept as the terminal event “so existing ledger-derived running counts still close correctly.” It does not address how the new `worker_disappeared` case should be surfaced in `status`’s `state` enum. Neither design doc defines a distinct status state for a lost worker, and no test asserts on the state value for this case (`dispatch.test.ts:1210-1217` asserts the *ledger* exit_code/reason, not `status()` output).
- **Consumer cross-check (per the task’s question):** the only ledger consumer that reads these terminal events by *event type* is `herdr-push.ts:102-117` (`started > ended` running count). Because it ignores `exit_code`/`reason`, it is **not** misled — the disappeared worker correctly decrements the running count. The misinterpretation risk is specifically for any consumer (present or future) of `status`’s `state` field.
- **Suggested check:** add a status test where the terminal event is `agent_exited` with `reason: "worker_disappeared"` and assert how it is surfaced; decide deliberately whether `state` should gain a `disappeared`/`failed` value or whether a dedicated `failure_reason`/`anomaly` field should be exposed.

---

### 2. `status`’s ledger read throws on any malformed/partial line — NEW — severity: medium-high

- **Location:** `kit/hydra-ts/src/status.ts:92-103` (`readLedger`).
- **Code:**
  ```ts
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as LedgerEntry;
    } catch {
      throw new Error(`malformed ledger line ${index + 1}: ${line}`);
    }
  });
  ```
- **Scenario:** `status.sh` is explicitly designed to run concurrently with a live dispatch. The dispatch writer appends one line at a time via `appendFileSync(ledgerPath, ${JSON.stringify(entry)}\n)` (`dispatch.ts:1091`). `appendFileSync` maps to a single `write()` and is line-atomic for *the writer*, but `status.ts`’s `readFileSync` + `split('\n')` provides **no** partial-line tolerance on the reader side: if the read observes the file between the moment the writer has extended it and the moment the trailing `"\n"` is durable, the final line has no terminator and `JSON.parse` throws. That throw propagates out of `status()` → `main()` → the process exits non-zero with no partial report. The same throw also means any *historically* corrupt line (from a prior crash, manual edit, or filesystem hiccup) permanently breaks `status` for that entire run.
- **Why this is new / asymmetric:** The progress-tail path in the same file is resilient to exactly this — `kimiEventText`/`codexEventText`/`monitorEventText` and `dispatch.ts:pollJsonlFile:634-659` all `try/catch` per line and skip unparseable lines. The codex design (`docs/async-trigger-design-codex.md:353-355`) lists “truncated capture” as a test target for *captures* but neither design doc addresses partial-line tolerance for the authoritative ledger reader. No test exercises a malformed/partial ledger line.
- **Suggested check:** have `readLedger` skip (or tail-truncate) lines that fail `JSON.parse` rather than aborting, and add a test with a trailing partial JSON line.

---

### 3. Bash `status.sh` emits **raw** `progress_tail`; TS emits **parsed** text — NEW — severity: medium

- **Location:** `kit/hydra/scripts/status.sh:139-148` vs `kit/hydra-ts/src/status.ts:225-254` (`gatherProgressTail` → `extractProgressLine`).
- **Scenario:** For a Kimi/Codex task the TS path tail of `<id>.cli.jsonl` runs each line through `kimiEventText`/`codexEventText` and returns human-readable strings (`[cmd] …`, assistant message text), falling back to raw lines only when nothing extracts. The bash fallback (`HYDRA_HARNESS=bash`) does a bare `tail -n "$lines" "$cli_jsonl"` and returns unparsed JSON. For the **same** capture file the two harness modes therefore produce structurally different `progress_tail` arrays (and the same `progress_source: "cli.jsonl"` label). This is a semantic divergence, not cosmetic: a machine consumer of `--json` cannot rely on the element shape, and the documented preference order (“prefer Codex/Kimi `.cli.jsonl`”) implies parsed content in both designs (`docs/async-trigger-design-codex.md:340-343`, `docs/async-trigger-design-kimi.md:295-299`).
- **Why this is new:** neither design doc specifies that the bash path may return raw JSON, and the bash `status.sh` path is exercised by no test in either test file.
- **Suggested check:** add a smoke test that runs `HYDRA_HARNESS=bash kit/hydra/scripts/status.sh … --json` and compares the `progress_tail` shape against the TS output for an identical fixture.

---

### 4. Bash `status.sh` parses elapsed time with macOS-only `date -j -f` — NEW — severity: medium

- **Location:** `kit/hydra/scripts/status.sh:93`.
- **Code:**
  ```bash
  started_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_time" '+%s' 2>/dev/null || true)"
  ```
- **Scenario:** `date -j` / `date -f <fmt>` are BSD-only flags. On Linux (GNU coreutils `date`) this invocation errors; the `2>/dev/null || true` swallows it, leaving `started_epoch` empty, so `elapsed_seconds` is emitted as `null` for **every** task regardless of how long it has run. The very next line (`date -u '+%s'`, `status.sh:97`) is portable, which shows the asymmetry was not intended. `lib.sh:177` (`hydra_now`) also only uses the portable `date -u` form, so this is the lone non-portable call. Confined to the bash fallback path (TS is default), but it is a silent correctness loss on Linux rather than a loud failure.
- **Suggested check:** parse the ISO timestamp portably (e.g. `date -u -d "$started_time" +%s` on GNU, or branch, or let `jq`/node do it), and add a Linux-CI run of the bash status path.

---

### 5. Unprotected `readFileSync` of pane pidfile/sentinel in the dispatch loop — NEW — severity: low-medium

- **Location:** `kit/hydra-ts/src/dispatch.ts:944`, `:977`, `:991`, `:1003`.
- **Scenario:** In `runWorkerInHerdrPane`, every `ctx.processAlive(pid)` call is wrapped in `try/catch` (`dispatch.ts:947,952`), but the surrounding `readFileSync(pidfile,…)` / `readFileSync(sentinel,…)` calls are not. Two concrete consequences:
  1. **Uncaught throw masks the real exit code.** If `readFileSync(sentinel)` at `:1003` throws after the `existsSync(sentinel)` check at `:989` (TOCTOU, or a transient `EIO`/`ESTALE` on a networked/home-dir state root), the error propagates out of `runWorkerInHerdrPane` → `runWorker` → the `dispatch()` catch at `:1182-1195`, which calls `recorder.cancel()`. The worker’s genuine exit code is thereby replaced by `agent_cancelled` / exit `130`, and the process exits non-zero.
  2. **Non-atomic pane pidfile → truncated pid probe.** The pane shell writes `echo $$ > <id>.pid` (`dispatch.ts:883,895`), which is truncate-then-write, not atomic. A `workerDisappeared()` read that catches the file mid-write could observe a truncated numeric prefix (e.g. `"12"` of `"12345"`); `Number("12")` is a valid pid belonging to some *other* living process, so `processAlive` returns true and the real disappearance is missed until the inactivity/hard-cap timeout. An empty/truncated-to-non-numeric value is handled (`!pid` → false), but a truncated-to-numeric prefix is not.
- **Why this is new:** the codex design (`docs/async-trigger-design-codex.md:80-95`) explicitly calls for an *atomic* pid record (tmp + rename) and metadata validation before probing; the implementation writes the pane pidfile via a non-atomic shell redirect and reads it back without the validation or the same try/catch discipline applied to `processAlive`. No test covers a transient FS error or a truncated pidfile in this path.
- **Suggested check:** wrap the sentinel/pidfile reads in try/catch (falling back to the timeout/cancel path), and consider having the pane write its pid via `printf` to a tmp file + `mv` (matching `writeAtomic`).

---

### 6. `ledger_events` is not scoped to the current attempt — NEW — severity: low-medium

- **Location:** `kit/hydra-ts/src/status.ts:394` (`const lastEvents = taskEvents.slice(-5);`) and the matching bash `kit/hydra/scripts/status.sh:151` (`tail -n 5` of `task_events_all`).
- **Scenario:** `state` and `elapsed_seconds` are derived from `attemptEvents` (the window from the *latest* `task_started` whose `agent_run_id` matches — `status.ts:360-364`), but the displayed “last 5 ledger events” are sliced from `taskEvents`, which is **all** events for the `task_id` across every prior spec-version attempt (`status.ts:359`). For a retried task this means `state: running` can be shown alongside a prior attempt’s `agent_timed_out` / `agent_exited` in `ledger_events`, which is confusing for humans and inconsistent for machine consumers. The existing retry test (`status.test.ts:133-157`) asserts only `state`/`elapsed_seconds`/`disagreement`; it does not assert on `ledger_events`, so the inconsistency is unobserved. (Note: TS and bash behave identically here, so this is a shared design gap rather than a TS/bash divergence.)
- **Suggested check:** slice `ledger_events` from `attemptEvents` (or otherwise label prior-attempt events), and extend the retry test to assert the scoping.

---

### 7. Unbounded `concurrency_wait` suppression can mask a dead-while-queued dispatch — NEW — severity: low-medium

- **Location:** `kit/hydra-ts/src/status.ts:256-291` (`detectDisagreement`, the `isLastEventConcurrencyWait` branch at `:278`) and `kit/hydra/scripts/status.sh:121-131`.
- **Scenario:** The missing-pidfile disagreement is suppressed without time bound when the last event in the current attempt window is `concurrency_wait`. This is intentional and correct for a genuinely queued task. But `dispatch.ts:385-394` emits `concurrency_wait` exactly once and then sleeps in a 1s loop awaiting a slot. If the dispatch process is `SIGKILL`ed while queued (OOM, operator `kill -9`, panic), no pidfile was ever written and the trailing event stays `concurrency_wait` forever, so `status` reports `state: running, disagreement: null` indefinitely for a task that will never make progress. The codex design defers crashed-dispatch reconciliation to a “future reconciler” (`docs/async-trigger-design-codex:425-428`), so the limitation is consistent with the design — but the specific consequence that `status`’s own disagreement detector is *structurally unable* to ever flag this case (because the suppression is unbounded) is not called out anywhere, and no test covers a dead queued dispatch.
- **Suggested check:** at minimum document that a queued task is never disagreement-checked; ideally bound the suppression by the elapsed-since-`task_started` time and flag after a generous ceiling.

---

### 8. Bash `status.sh` interpolates `task_id` directly into a `jq` filter — NEW — severity: low

- **Location:** `kit/hydra/scripts/status.sh:60`.
- **Code:**
  ```bash
  task_events_all="$(jq -rc "select(.task_id == \"$task_id\")" "$ledger")"
  ```
- **Scenario:** `task_id` is placed into the jq program string via shell interpolation rather than `--arg`. The very next statement (`status.sh:61`) correctly parameterizes `agent_run_id` with `--arg`. A `task_id` containing `"`, `\`, or jq metacharacters would either break the query or alter its meaning (jq injection). Task ids are conventionally safe identifiers, so this is low severity, but it is an inconsistency within the same function and a latent injection point.
- **Suggested check:** use `jq -rc --arg t "$task_id" 'select(.task_id == $t)'`.

---

### 9. `writeAtomic` leaves a `.tmp.<pid>` file behind on rename failure — NEW — severity: low

- **Location:** `kit/hydra-ts/src/dispatch.ts:504-509` (`writeAtomic`), called at `:1163`; cleanup at `:511-513` (`removeDispatchPidfile`) and the `finally` at `:1167`.
- **Scenario:** If `writeFileSync(tmp,…)` succeeds but `renameSync(tmp, path)` throws (full disk, permissions, cross-device state root), the catch path calls `removeDispatchPidfile(dispatchPidfile)` which removes only the *final* path, not `${path}.tmp.${process.pid}`. Orphaned temp files accumulate under `sessions/supervisor/`. This does not crash the dispatch (the surrounding try/catch handles it) and pid reuse eventually overwrites a same-named tmp, but it is an unguarded accumulation path. The existing test (`dispatch.test.ts:1165`) asserts no leftover tmp on the *happy* path only.
- **Suggested check:** have `writeAtomic` clean up its tmp in a `try/finally` on the rename-failure path.

---

### 10. `status.ts` ignores `dispatch_instance_id` for terminal matching (design divergence, not a practical bug) — INFORMATIONAL

- **Location:** `kit/hydra-ts/src/status.ts:116-131` (`currentAttemptEvents` matches on `agent_run_id` only).
- **Note:** The codex design (`docs/async-trigger-design-codex.md:328-334`) recommends isolating the current attempt and matching its terminal event by `dispatch_instance_id` (and labeling ambiguous multi-start cases `legacy_ambiguous`). The implementation instead matches on `agent_run_id` (`<run>-<task>-v<spec>`) and slices from the *latest* `task_started`. **This is sufficient for sequential retries** (including same-spec-version re-dispatch, because the backward scan picks the newest start and the slice excludes earlier terminals), so it is not a practical bug under the current one-dispatch-at-a-time execution model. It would only matter for *concurrent* same-`agent_run_id` dispatches, which the slot mechanism does not prevent (two dispatches of the same version overwrite the same slot file at `dispatch.ts:402`). Calling this out for completeness, not as an actionable defect.

---

### 11. `exit_code: "127"` is overloaded (spawn error vs `worker_disappeared`) — INFORMATIONAL

- **Location:** `kit/hydra-ts/src/dispatch.ts:785` (plain-mode spawn `error` → `exitCode = 127`, recorded at `:830` with **no** `reason`) and `:980` (pane `worker_disappeared` → `127` with `reason: "worker_disappeared"`).
- **Note:** Unix conventionally reads 127 as “command not found”; here it additionally denotes a lost pane worker. The two cases are distinguishable only via the `reason` field, which the plain-mode path omits entirely. I grepped every ledger consumer: `herdr-push.ts:102-117` keys on **event type** only, `review-dispatch.ts:434-447` / `review-dispatch.sh:98-99` write `exit_code` for the separate `review_completed` event (the *reviewer’s* own exit, not the worker’s), and `promote.ts:312-313` derives completion from the worker’s `.hydra-result.json` `status` field rather than the ledger `exit_code`. So **no existing consumer misinterprets the overload today**. The risk is purely for future consumers that key on `exit_code == 127` without consulting `reason`. Worth a one-line convention note in the ledger contract docs.

---

### 12. The “never_started” sub-case of §1 was not implemented — INFORMATIONAL (design-vs-code gap, likely known)

- **Location:** `kit/hydra-ts/src/dispatch.ts:941-954` (`workerDisappeared` requires `isFile(pidfile)` at `:943`).
- **Note:** The codex design (`docs/async-trigger-design-codex.md:85-88`) specifies a second liveness outcome: if 5s after pane start neither the worker pid record nor an exit sentinel has appeared, record `agent_exited` / `127` / `reason: "never_started"`. The implementation only handles the *disappeared* case (pidfile present, process gone). A pane that launches but never writes `<id>.pid` and never writes a sentinel falls through to the ordinary inactivity/hard-cap timeout → `agent_timed_out` / `reason: "stalled"`, which is precisely the slow-to-detect failure the codex design wanted to eliminate. This may be a deliberate deferral, but it is a behavioral gap between the design and the shipped code, and no test covers the never-started scenario.

---

## Categories examined and found sound (no new issue)

- **Atomic publication of the dispatch pidfile.** `writeAtomic` (`dispatch.ts:504-509`) uses tmp+`renameSync`, and `status.ts` only ever reads it after an `isFile` check; a partial pidfile is never observable by `status`. The pidfile path (`sessions/supervisor/<id>.dispatch.pid`) is consistent between writer (`dispatch.ts:500-502`) and reader (`status.ts:373`). ✔
- **Supervisor-metadata / plain-activity interference.** Placing the pidfile under `sessions/supervisor/` correctly keeps it out of the top-level `<id>.*` glob used by `plainActivity` (`dispatch.ts:482-491`); this is guarded by `dispatch.test.ts:1174-1188`. ✔
- **Idempotence of the terminal recorder.** `finish()`’s `recorded` guard (`dispatch.ts:312-313`) correctly resolves cancel-vs-exit and cancel-vs-timeout races; the sentinel-wins test (`dispatch.test.ts:1219-1244`) and the transient-false-negative test (`dispatch.test.ts:1246-1274`) cover the worker-disappearance races well. ✔
- **`concurrency_wait` write-once behavior** (`dispatch.ts:385-394`) and the current-attempt windowing in `status.ts` for the *state/elapsed* path are correct for sequential retries. ✔
- **Progress-tail resilience to malformed *capture* lines** (`status.ts:219-223` via `kimiEventText`/`codexEventText` try/catch; `dispatch.ts:634-659` `pollJsonlFile`) is sound — the concern in finding #2 is specifically the *ledger* path, which lacks this resilience. ✔
- **`--json` field-naming consistency (TS).** Field names are uniformly snake_case; numbers vs strings are consistent (`elapsed_seconds` number|null, `timeout_minutes`/`hard_cap_minutes` numbers, `dispatch_liveness` null-or-object). The schema-level caveats are captured in findings #1, #3, #6 rather than here. ✔

---

## Suggested additional checks (summary)

1. Status test asserting how `worker_disappeared` / `exit_code 127` is surfaced in `state` (finding #1).
2. Status test with a trailing partial / malformed ledger line (finding #2).
3. Cross-harness `--json` parity test for `progress_tail` shape (finding #3) and a Linux run of the bash status path (finding #4).
4. Dispatch test injecting a transient `readFileSync` failure on the sentinel/pidfile, and a truncated-numeric pidfile (finding #5).
5. Status retry test asserting `ledger_events` scoping (finding #6).
6. Status test for a dispatch killed while queued on `concurrency_wait` (finding #7).
