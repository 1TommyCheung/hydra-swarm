# Follow-up adversarial review — cancel-task identity-validation fix (run 0012, Task #31)

- **Reviewer:** OpenCode (adversarial re-verification of the fix commit).
- **Base commit under review:** `9d7283518ebe087aea3d1276056e2afb175ab1f0`
  (`fix: validate cancel task process identity`).
- **Scope:** re-derive, from the code itself, whether the three findings raised in
  `docs/opencode-review-cancel-task.md` (run 0011 review) are actually resolved.
  Files re-read line-by-line:
  - `kit/hydra-ts/src/cancel-task.ts` (read-only)
  - `kit/hydra/scripts/cancel-task.sh` (read-only)
  - `kit/hydra-ts/test/cancel-task.test.ts` (read-only)
  - `kit/hydra-ts/test/cancel-task.sh.test.ts` (read-only)
- **Method:** traced every PID-resolution and signal-delivery call site against the
  original findings, then independently assessed whether the new tests genuinely
  exercise the adversarial scenarios (not just the summary claims). Re-ran both test
  suites: 17/17 pass (10 TS + 7 bash).
- **No source code files were modified for this review.**

> Note: the prior review doc `docs/opencode-review-cancel-task.md` is listed as a
> read-only context path but is not present in this worktree's working tree (it lives
> on branch `hydra/0011/opencode-review-cancel`, commit `4db4f33`). Its contents were
> recovered via `git show` for cross-referencing the original finding text. This
> absence does not affect the review — the three findings are also fully quoted in the
> task spec.

---

## Verdicts on the three original findings

### Finding #1 (HIGH) — pidfile path trusted PID without command-line identity validation
**Verdict: FIXED** (both TS and bash).

**Evidence (TS — `kit/hydra-ts/src/cancel-task.ts:317-331`):**

```ts
let shouldDiscover = isLastEventConcurrencyWait(snapshot.events);
if (existsSync(pidfilePath)) {
  const pid = readPidfile(pidfilePath);
  if (pid !== undefined && safeProcessAlive(processAlive, pid)) {
    const processes = listProcesses();
    if (processIsDispatch(processes, pid, runId, taskId)) {   // :322 identity gate
      dispatchPid = pid;
    } else {
      // SIGKILL can leave a stale pidfile behind. Never trust a live, reused
      // PID; search the same process snapshot for the real dispatcher.
      shouldDiscover = true;
      discoveryProcesses = processes;                          // :328 reuse snapshot
    }
  }
}
```

The primary pidfile path now performs identity validation *before* trusting the PID:
- `processIsDispatch` (`cancel-task.ts:212-220`) looks up the PID in the live process
  snapshot and runs the *same* `isDispatchCommand` (`:186-198`) used by the discovery
  fallback. This is exactly the parity the original review asked for — the validation
  is no longer exclusive to the no-pidfile branch.
- On validation failure the code does **not** die immediately; it sets
  `shouldDiscover = true` and caches the snapshot in `discoveryProcesses`, then falls
  through to the discovery block (`:333-344`):
  ```ts
  if (dispatchPid === undefined && shouldDiscover) {
    const matches = validatedDispatchMatches(
      discoveryProcesses ?? listProcesses(), ...);   // :335 reuses snapshot, no 2nd ps
  ```
- Discovery still succeeds if the real dispatcher is running under a different PID:
  `validatedDispatchMatches` (`:222-232`) filters the snapshot by `pid > 0 &&
  safeProcessAlive && isDispatchCommand`, so the legitimate dispatcher is found and the
  stale PID is never signaled. If discovery also fails, the command dies safely with
  "dispatch process not found" (`:347`) rather than signaling an unverified PID.

**Evidence (bash — `kit/hydra/scripts/cancel-task.sh:117-129`):**

```bash
should_discover=0
[ "$last_event" = 'concurrency_wait' ] && should_discover=1
if [ -f "$pidfile" ]; then
  candidate="$(tr -d '[:space:]' <"$pidfile")"
  if [[ "$candidate" =~ ^[0-9]+$ ]] && kill -0 "$candidate" 2>/dev/null; then
    if pid_matches_dispatch "$candidate"; then        # :122 identity gate
      dispatch_pid="$candidate"
    else
      # SIGKILL can leave a stale pidfile whose live PID has been reused.
      should_discover=1                               # :126 fall through to discovery
    fi
  fi
fi
```

`pid_matches_dispatch` (`:111-115`) composes `command_for_pid` (a `ps -axo pid=,command=`
scan, `:100-109`) with `command_matches_dispatch` (`:85-98`), reusing the identical
token-equality logic as the discovery path. On mismatch it sets `should_discover=1` and
enters the same full-scan discovery block at `:131-148`. Parity with TS confirmed.

**Original failure scenario re-traced:** stale pidfile → live reused PID →
`processIsDispatch`/`pid_matches_dispatch` now returns false → no signal to the reused
PID → discovery finds the real dispatcher (or dies safely). The HIGH-severity
wrong-process-signal path is closed.

---

### Finding #2 (MEDIUM) — no identity re-validation at SIGKILL escalation
**Verdict: FIXED** (both TS and bash), with an inherently irreducible TOCTOU window
that is as small as practically achievable.

**Evidence (TS — `kit/hydra-ts/src/cancel-task.ts:416-441`):**

```ts
if (safeProcessAlive(processAlive, dispatchPid)) {        // :416 liveness
  terminal = currentAttemptSnapshot(...).terminalEntry;   // :419 ledger re-read
  if (terminal) { return ...; }
  if (
    safeProcessAlive(processAlive, dispatchPid)           // :430 liveness re-check
    && processIsDispatch(listProcesses(), dispatchPid, runId, taskId)  // :431 IDENTITY
  ) {
    try {
      signalProcess(dispatchPid, 'SIGKILL');              // :434 signal
```

The escalation path now requires **identity**, not just liveness, immediately before
SIGKILL. `processIsDispatch(listProcesses(), …)` takes a *fresh* process snapshot
(`listProcesses()` is called inline, not a cached value) and re-runs
`isDispatchCommand` against the dispatch PID's current command line. If the PID was
reused by a non-dispatch process during the wait window, the check fails, `escalated`
stays false, no SIGKILL is sent, and the command proceeds to the orphan throw (`:455`).
This is the standard mitigation the original review's "Suggested fix" called for.

**Evidence (bash — `kit/hydra/scripts/cancel-task.sh:188-198`):**

```bash
if kill -0 "$dispatch_pid" 2>/dev/null; then
  terminal="$(terminal_event)"; if [ -n "$terminal" ]; then ...; fi
  if kill -0 "$dispatch_pid" 2>/dev/null \
    && pid_matches_dispatch "$dispatch_pid"; then        # :195 IDENTITY re-check
    kill -KILL "$dispatch_pid" 2>/dev/null || true       # :196 signal
  fi
fi
```

`pid_matches_dispatch` re-reads the command line via `command_for_pid` (fresh `ps`
scan) and re-validates identity before `kill -KILL`. Parity with TS confirmed.

**TOCTOU assessment (as requested — practical, not zero):** A residual window exists
between `processIsDispatch`/`pid_matches_dispatch` returning and the signal syscall
landing (`:431`→`:434` in TS; `:195`→`:196` in bash). This is **inherent to Unix
PID-based signaling** and cannot be eliminated in userspace. The identity check is
placed as the *last* gate before the signal (liveness → ledger → liveness → identity →
signal), so the window is reduced to the few microseconds between the snapshot lookup
returning and `kill(2)` being entered. The only known way to close it further is
`pidfd_open` + `pidfd_send_signal` (Linux-specific, verifies the fd still refers to the
original process), which Node's `process.kill` does not use and which is not portable
to macOS. The remaining window is therefore as small as practically achievable with
portable APIs. No defect.

---

### Finding #6 (LOW) — bash `pgrep -f` treated run_id as extended regex
**Verdict: FIXED** (bash).

**Evidence (`kit/hydra/scripts/cancel-task.sh:131-148`):** `pgrep` is removed entirely.
The discovery loop now scans all processes via `ps -axo pid=,command=` and pre-filters
with **literal** substring tests:

```bash
while read -r candidate command; do
  [[ "$candidate" =~ ^[0-9]+$ ]] || continue
  kill -0 "$candidate" 2>/dev/null || continue
  # These shell pattern checks use quoted expansions, so run/task IDs are
  # literal strings rather than regular expressions.
  [[ "$command" == *"$run_id"* ]] || continue            # :138 literal substring
  [[ "$command" == *"$task_id"* ]] || continue           # :139 literal substring
  command_matches_dispatch "$command" && matches+=("$candidate")
done < <(ps -axo pid=,command= 2>/dev/null || true)       # :141 no pgrep
```

Because `$run_id`/`$task_id` are **double-quoted** inside `[[ ... == *"$var"* ]]`,
their contents are treated literally (no glob/regex metacharacter interpretation), so
the regex false-negative/false-positive risk from `pgrep -f` is structurally
eliminated. The pre-filter is permissive (substring), and the final gate
`command_matches_dispatch` (`:85-98`) uses exact token equality
(`[ "$clean" = "$run_id" ]`), so any spurious pre-filter survivor is rejected.

**New-correct-issue assessment of the replacement (as requested):**

- *False-positive risk vs pgrep:* none introduced. The pre-filter is a *looser*
  (literal substring) match than pgrep's regex, so it can only let *more* candidate
  lines through; the exact-token `command_matches_dispatch` gate then removes all
  non-dispatchers. Net false-positive rate is unchanged at zero.
- *False-negative risk vs pgrep:* none introduced. A legitimate dispatch command
  contains `run_id` as an argv token, therefore always as a substring, so the literal
  pre-filter never excludes the real dispatcher. pgrep's regex could (per the original
  finding) exclude it via metachar semantics; the new code cannot.
- *Parsing correctness:* `while read -r candidate command` correctly consumes the
  `ps -axo pid=,command=` format — `read` strips leading IFS whitespace from `candidate`
  and assigns the full remainder of the line (internal spaces preserved) to the last
  variable `command`. Matches the TS regex `/^\s*(\d+)\s+(.*)$/` (`cancel-task.ts:167`).
- *Minor inefficiency (not a defect):* in the stale-pidfile case bash performs two `ps`
  scans — one inside `pid_matches_dispatch`/`command_for_pid` for validation, one for
  discovery — whereas TS reuses one snapshot via `discoveryProcesses` (`:328`,`:335`).
  Both scans are followed by per-candidate `kill -0` liveness checks, so correctness is
  unaffected; only a trivial cost difference on a cold path.

---

## Test assessment — do the new tests genuinely exercise the adversarial scenarios?

### Finding #1 scenario (stale live pidfile PID that is NOT the dispatcher)

**TS — `cancel-task.test.ts:197-220` "rejects a stale live pidfile PID and falls through to validated discovery":** genuine. Pidfile points at `stalePid=43211` whose mocked command is `'sleep 300'`; `processAlive` returns true for *both* stale and real PIDs; `listProcesses` returns the stale entry plus a real `dispatchProcess(dispatchPid=43212)` (`:104-109`). Asserts `dispatch_pid === 43212`, signals `=== [[43212,'SIGTERM']]`, and `signals.some(([pid]) => pid === stalePid) === false`. This is exactly the live-but-not-the-dispatcher PID-reuse case from Finding #1.

**Bash — `cancel-task.sh.test.ts:302-322` "rejects a stale live pidfile PID and signals the discovered dispatcher":** genuine and stronger — it uses a **real** `spawn('sleep', ['30'])` process as the reused-PID target, writes its PID into the pidfile, and asserts `unrelated.kill(0) === true` (the innocent process is never signaled) while the real dispatcher emits `agent_cancelled`. Real-process proof of the Finding #1 fix.

### Finding #2 scenario (escalation-time identity mismatch)

**TS — `cancel-task.test.ts:325-350` "skips SIGKILL when the PID no longer has dispatcher identity":** genuine. `listProcesses` returns the real `dispatchProcess` on the *first* call (initial resolution) and `{pid: dispatchPid, command: 'sleep 300'}` on every subsequent call (identity changed by escalation time). `processAlive` always true. Asserts only `[dispatchPid,'SIGTERM']` was sent (no SIGKILL), `processLists >= 2` (identity was actually re-queried at escalation), and ORPHAN. Directly exercises the Finding #2 gap.

**Bash — `cancel-task.sh.test.ts:365-383` "skips SIGKILL when escalation-time identity no longer matches":** genuine and elegant. The `'change-identity'` dispatcher mode (`:50-51`) traps SIGTERM to `exec sleep 30` and touches a marker file; the fake `ps` shim (`:84-96`) rewrites that PID's command to `sleep 30` once the marker exists. So after SIGTERM the PID is alive but its *command identity* changes — the escalation `pid_matches_dispatch` then fails and SIGKILL is withheld. Asserts `dispatcher.kill(0) === true`. Real-process proof of the Finding #2 fix.

### Bash ↔ TS suite parity

The bash suite grew from **1 test → 7 tests**, closing most of the gap documented in
the run-0011 review ("1 vs 8"):

| Scenario | TS | Bash |
|---|:---:|:---:|
| Happy-path pidfile cancel | ✓ (`:175`) | ✓ (`:223`) |
| Already-terminal idempotency | ✓ (`:139`) | ✓ (`:254`) |
| Concurrency_wait discovery + non-match rejection | ✓ (`:222`) | ✓ (`:272`) |
| **Stale pidfile → discovery (Finding #1)** | ✓ (`:197`) | ✓ (`:302`) |
| SIGKILL escalation (delayed terminal) | ✓ (`:253`) | ✓ (`:324`) |
| Orphan reporting, no fabrication | ✓ (`:276`) | ✓ (`:344`) |
| **Escalation identity mismatch (Finding #2)** | ✓ (`:325`) | ✓ (`:365`) |
| Dead dispatcher during wait (no SIGKILL) | ✓ (`:301`) | ✗ (TS-only) |
| Missing-attempt rejection | ✓ (`:162`) | ✗ (TS-only) |
| `isDispatchCommand` token-exactness unit cases | ✓ (`:352`) | ✗ (TS-only) |

The bash suite is now **meaningfully close to parity** — every adversarial
signal-safety scenario (Findings #1 and #2, escalation, orphan, discovery filtering,
idempotency) is exercised against real bash processes with a deterministic fake-`ps`
shim. Remaining gaps (dead-during-wait, missing-attempt, unit-level token cases) are
lower-value and do not leave any *safety* property unexercised. The fake-`ps` design
(`:84-96`, marker-file-driven command rewriting) is sound and makes the identity-mismatch
test deterministic.

---

## New issues introduced by this fix

### N1 — `ps` is now a hard dependency on the primary pidfile path (was not before)
- **Severity: LOW (informational / reliability consideration, not a safety regression).**
- **Location:** `cancel-task.ts:321` (`listProcesses()` now called in the pidfile
  branch); `cancel-task.sh:122` (`pid_matches_dispatch` → `command_for_pid` → `ps`).
- **Analysis:** Pre-fix, the TS pidfile path resolved the PID using only
  `safeProcessAlive` — no `ps` call — so cancel-task functioned (unsafely) even if
  `ps` was unavailable. Post-fix, identity validation requires the process list.
  `defaultListProcesses` (`cancel-task.ts:154-163`) returns `[]` on any `ps` failure
  (try/catch around `execFileSync`), so in a restricted environment without `ps` the
  identity check fails → discovery finds nothing → `die('dispatch process not found')`
  (`:347`). The command therefore **fails safe** (no signal to an unverified PID) but
  can no longer cancel a task that it previously could have cancelled.
- **Why this is not a true regression:** it is the *intended and correct* cost of
  fixing Finding #1 — you cannot validate command-line identity without reading the
  process list, and the run-0011 review's own "Suggested fix" prescribes exactly this
  `ps` lookup. The concurrency_wait discovery path was already `ps`-dependent pre-fix,
  and `ps -axo` is universally available on the target platforms (macOS/Linux). Noted
  only for completeness.

### N2 — no explicit regex-metacharacter test for the bash literal-matching replacement
- **Severity: INFORMATIONAL (test-coverage nicety, not a code defect).**
- **Location:** test gap; code under test is `cancel-task.sh:138-139,94-95`.
- **Analysis:** Finding #6 is structurally fixed — `pgrep` is gone, so **no regex code
  path remains** to regress. `[[ "$command" == *"$run_id"* ]]` (quoted ⇒ literal) and
  `[ "$clean" = "$run_id" ]` (string equality) cannot reinterpret metacharacters.
  However, no bash test uses a `run_id` containing regex/glob metacharacters
  (`.`, `*`, `+`, `[`) to *demonstrate* the literal matching at the behavior level. A
  one-line fixture (e.g. `runId='task.1'` confirmed to match only a literal `task.1`
  dispatcher) would make the fix self-proving. Purely optional; the structural
  elimination of regex already guarantees correctness.

### No higher-severity regressions found
I specifically looked for and did **not** find:
- Any path where a non-dispatch PID gets signaled (all signal sites are gated by
  `processIsDispatch`/`pid_matches_dispatch` or prior validated resolution).
- Any change to the observer-only / never-fabricate contract (no ledger write was
  added; every `exit 0`/return still requires a real terminal event; orphan still
  throws/dies — `cancel-task.ts:455`, `cancel-task.sh:207`).
- Any multiple-dispatch ambiguity (the `>1` refusal is preserved in both
  implementations: `cancel-task.ts:340-342`, `cancel-task.sh:143-144`).
- Any deadlock/unbounded loop introduced by the new snapshot reuse or extra `ps` calls
  (all paths remain bounded; `defaultListProcesses` swallows `ps` errors).

---

## Summary table

| Finding | Severity (orig) | Verdict | Key evidence |
|---|---|---|---|
| #1 pidfile trusts PID without identity check | HIGH | **FIXED** | `cancel-task.ts:322,328,335`; `cancel-task.sh:122,126`; tests `:197`,`:302` |
| #2 no identity re-validation before SIGKILL | MEDIUM | **FIXED** (TOCTOU minimal) | `cancel-task.ts:430-434`; `cancel-task.sh:194-196`; tests `:325`,`:365` |
| #6 bash `pgrep -f` regex interpretation | LOW | **FIXED** | `cancel-task.sh:138-141` (pgrep removed); test `:272` |
| N1 `ps` now hard-required on pidfile path (new) | LOW | accepted tradeoff | `cancel-task.ts:154-163,321`; `cancel-task.sh:100-109` |
| N2 no metachar test for literal matching (new) | INFO | optional | test gap only |

**Overall:** all three findings are genuinely resolved in both implementations, with
file:line evidence and real-process tests that exercise the exact adversarial
scenarios. The bash suite has moved from token to near-parity on every safety-relevant
path. No safety regression was introduced; the only new considerations are an intended
`ps`-dependency tradeoff (LOW) and an optional test nicety (INFO).
