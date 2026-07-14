# Cross-vendor review: loop-thinking detector

## Overall verdict: REJECT

Risk is **critical** because the implementation has multiple reachable false-positive paths to `recorder.cancel()`. The cancellation wiring itself is appropriately local to dispatch and Stage 2, but the evidence retained by the state machine is not constrained to the declared windows, Stage 2 does not require continued looping, and Rule B can classify successful work as a loop. These issues should be fixed before promotion.

## Finding 1 — Historical evidence survives Git progress and can later cancel healthy reasoning

- **Severity:** high
- **References:** `kit/hydra-ts/src/loop-detector.ts:668-673`, `kit/hydra-ts/src/loop-detector.ts:693-703`, `kit/hydra-ts/src/loop-detector.ts:730-755`
- **Failure scenario:** An agent produces 12 matching explicit failures and enough output early in the attempt, then edits or commits a fix. The Git change updates only `lastGitChangeAt`; it does not clear `recentActions`, `totalMeaningfulEvents`, or `cumulativeRawBytes`. If the agent then spends ten minutes in a legitimate reasoning burst with few or no tool calls, Rule A reuses the pre-fix failures, declares a new suspicion, and can cancel five minutes later even though there were no post-progress failures.

The action timestamps are populated but never used to select a 10- or 15-minute interval. Both rules operate on lifetime counters and the last 100 semantic records, while only Git stagnation is time-bounded. A Git change clears an existing episode at `loop-detector.ts:710-722`, but it still does not reset the evidence that immediately seeds the next episode. This also means old Rule B cycles can reappear after progress.

Pure reasoning from the start of a task remains safe because it lacks an actionable cycle, but a long reasoning burst following earlier failures is not safe.

## Finding 2 — Stage 2 confirms stale Stage-1 evidence without continued repetition

- **Severity:** high
- **References:** `kit/hydra-ts/src/loop-detector.ts:769-804`, `kit/hydra-ts/src/loop-detector.ts:806-835`, `kit/hydra-ts/src/dispatch.ts:549-570`
- **Failure scenario:** Rule A becomes suspected after a burst of failures. The agent stops retrying and begins a legitimate activity that produces no recognized signature, or produces only one different action. The retained 12-action suffix can still satisfy Rule A. After five wall-clock minutes, Stage 2 confirms solely from `now - suspectedAt` and dispatch immediately calls `recorder.cancel()`; no new matching failures or repeated cycles are required during the confirmation period.

The clearing check only runs when `activeKind === null`. A single new non-repeating action does not clear a Rule A episode if the old suffix still has 8-of-12 dominance and six matching failures. Capture growth during the confirmation period is not required either: the lifetime output floors remain true after the file stops growing. Thus the second stage is a delay on the original sample, not an independent confirmation that the loop persisted.

## Finding 3 — Rule B can auto-cancel repeated successful or legitimate cyclic work

- **Severity:** high
- **References:** `kit/hydra-ts/src/loop-detector.ts:553-573`, `kit/hydra-ts/src/loop-detector.ts:749-767`, `kit/hydra-ts/src/loop-detector.ts:806-835`
- **Failure scenario:** A healthy agent repeatedly runs the same passing test command, with test output taking the capture beyond 32 KiB and enough start/completion/message records to exceed 24 meaningful events, while not editing files for 15 minutes. The semantic suffix is a period-1 cycle containing an actionable event, so Rule B suspects it despite every action succeeding and then auto-cancels after the confirmation delay.

An exact sequence of three or four legitimate actions is also unsafe. For example, repeatedly running test, lint, and status commands can form a period-3 cycle; five or more consecutive repetitions satisfy the cycle check once the output floors are met. Rule B has no failure predicate and no allow-list for successful outcomes. Alternating five or more distinct actions is safe from Rule B's period ceiling, while ordinary varied investigation is also safe.

## Finding 4 — Git sampling is not fully fail-open

- **Severity:** high
- **References:** `kit/hydra-ts/src/loop-detector.ts:443-463`, `kit/hydra-ts/src/loop-detector.ts:466-514`, `kit/hydra-ts/src/loop-detector.ts:683-728`
- **Failure scenario:** The initial fingerprint is taken while `git ls-files --others --exclude-standard -z` repeatedly fails. `listUntrackedFiles()` catches that command failure and returns an empty list, after which `sampleGitSignature()` reports `unknown: false`. A background process or the agent can repeatedly rewrite an existing untracked file at the same path; `git diff HEAD --` remains empty and porcelain status continues to report the same path, so the detector treats the worktree as unchanged and may auto-cancel.

The normal untracked-file path is correct: when all commands succeed, the path from `ls-files` is content-hashed, so a same-path rewrite changes the fingerprint even though diff and status text do not. `GIT_OPTIONAL_LOCKS=0` is also applied through `runGit()` to all four Git invocations.

Two fail-open gaps remain:

1. `ls-files` failure is silently converted to a complete empty untracked set. Untracked `stat`/read failures similarly become stable `missing` or `unreadable` markers while the sample remains known.
2. Failures of the other Git commands set `gitUnknown`, but recovery does not reset `lastGitChangeAt` or require a new complete window. If evidence is unavailable around the threshold and later recovers, detection can fire immediately using the pre-failure stagnation clock and retained actions.

An inspection failure must make the entire sample unknown and restart the qualifying window after a successful baseline.

## Finding 5 — The detector does not validate the current attempt or dispatch before emitting

- **Severity:** medium
- **References:** `kit/hydra-ts/src/current-attempt.ts:21-36`, `kit/hydra-ts/src/loop-detector.ts:819-866`, `kit/hydra-ts/src/dispatch.ts:553-568`, `kit/hydra-ts/src/status.ts:143-159`, `kit/hydra-ts/src/status.ts:373-401`
- **Failure scenario:** Dispatch A for spec version 1 is still winding down when dispatch B starts spec version 2. After B's `task_started`, A emits a late `agent_loop_suspected` or `agent_loop_confirmed`. `currentAttemptEvents()` finds B's boundary but returns every task event after it without filtering later entries by `agent_run_id` or `dispatch_instance_id`; status can therefore show A's old suspicion as active for B. A late terminal event can likewise make the new attempt appear terminal.

Loop events do carry `dispatch_instance_id`, because the dispatch ledger appender adds it to every entry at `dispatch.ts:1137-1145`. However, `loop-detector.ts` never uses the shared current-attempt helper or re-reads the ledger before suspicion/confirmation. Consequently the available dispatch identity is not enforced, and duplicate same-version dispatches have the same race.

The extraction itself is otherwise a pure shared refactor: `status.ts` and `cancel-task.ts` both import `currentAttemptEvents()`, and their previous boundary behavior is preserved.

## Finding 6 — Per-invocation IDs prevent logical repeat and failure detection for tool calls

- **Severity:** medium
- **References:** `kit/hydra-ts/src/loop-detector.ts:191-220`, `kit/hydra-ts/src/loop-detector.ts:251-286`, `kit/hydra-ts/src/loop-detector.ts:318-327`, `kit/hydra-ts/src/loop-detector.ts:534-550`
- **Failure scenario:** Kimi calls the same function with the same arguments 12 times, receiving unique tool-call IDs `tc-1` through `tc-12`, and each call fails identically. The assistant-side action hash includes the unique ID, so there is no dominant repeated action. The tool-result-side failure uses a different hash built only from `{id}`, so it cannot correlate with even its own assistant-side action. Rule A and Rule B both remain healthy for a genuine tool loop.

Codex MCP and OpenCode tool signatures also include invocation IDs, which makes logically identical calls distinct when the vendor generates a fresh ID per invocation. IDs should be retained only for start/outcome correlation, not included in the normalized logical action signature.

This is primarily a false-negative defect, so it is lower severity than the cancellation false positives, but it substantially weakens cross-vendor coverage.

## Finding 7 — Safety-focused tests stop before the dangerous boundaries

- **Severity:** medium
- **References:** `kit/hydra-ts/test/loop-detector.test.ts:292-315`, `kit/hydra-ts/test/loop-detector.test.ts:336-369`, `kit/hydra-ts/test/loop-detector.test.ts:254-289`, `kit/hydra-ts/test/dispatch.test.ts:1420-1458`, `kit/hydra-ts/test/dispatch.test.ts:1491-1509`, `kit/hydra-ts/test/status.test.ts:490-542`
- **Failure scenario:** The suite remains green while the false-positive scenarios above are present. The unit repeated-success test advances only to Rule A's 10-minute boundary and does not meet/test Rule B's 15-minute plus confirmation path. The dispatch repeated-success case exits after eight one-minute ticks. The diverse-action test uses ten distinct commands instead of stressing exact period-3 or period-4 legitimate cycles.

Additional gaps:

- The Stage-2 unit test appends one extra failure but does not prove that fresh evidence is required; it would also confirm with no new record.
- No test verifies that Git progress clears historical action/output evidence, or that Git/read failures restart the full window.
- The Git sampler tests cover the successful untracked rewrite and optional-lock environment, but not any command/read failure.
- Status tests cover an in-order current suspicion but not a late old-version or wrong-dispatch event after the new boundary.
- Vendor parser tests do not verify that different invocation IDs produce the same logical action or that Kimi tool results correlate with starts.

There is real end-to-end coverage for the intended destructive path: `dispatch.test.ts:1439-1457` verifies suspected, confirmed, worker kill, final `agent_cancelled`, and dispatch identity. What is missing is comparable integration coverage proving Stage 1 alone cannot cancel and proving the false-positive avoidance boundaries through the full 20-minute Rule B path.

## Finding 8 — The Git execution type was not widened for `env`

- **Severity:** medium
- **References:** `kit/hydra-ts/src/dispatch.ts:27-31`, `kit/hydra-ts/src/loop-detector.ts:443-454`, `kit/hydra-ts/test/loop-detector.test.ts:255-267`
- **Failure scenario:** Running the declared strict TypeScript typecheck with dependencies installed reports an excess `env` option at the `execGit()` call and an unknown `options.env` property in the new test, because `ExecFileSyncLike` declares only `encoding`, `cwd`, and `stdio`. Runtime tests use Node's type stripping, so 679 passing runtime tests do not exercise this compile-time contract.

The local dependency tree did not contain `tsc`, so `npm run typecheck` could not execute in this worktree; the mismatch is visible directly in the strict interfaces and call sites.

## Finding 9 — Unrelated Git activity can indefinitely mask a genuine loop

- **Severity:** informational
- **References:** `kit/hydra-ts/src/loop-detector.ts:693-722`
- **Failure scenario:** A genuinely stuck agent repeats a failing action, while an unrelated background formatter, generator, or process changes any tracked or untracked file before the stagnation threshold. Every fingerprint change resets `lastGitChangeAt` and clears an episode, so the task may never be suspected or cancelled.

This is a false negative toward treating the task as healthy, not a false-positive cancellation risk. It follows from using a whole-worktree fingerprint without ownership attribution and should at least be documented operationally.

## Categories with no new issue found

### Cancellation placement

`dispatch.ts` neither imports/calls `cancelTask()` nor invokes `cancel-task.sh`. The detector reaches `recorder.cancel()` only when `loopDetectorTick()` returns `verdict === 'confirmed'` (`dispatch.ts:549-570`); Stage 1 returns `suspected` and does not cancel. The recorder then owns worker-tree termination, `agent_cancelled`, sentinel creation, slot release, and pane cleanup (`dispatch.ts:313-370`).

### Exception containment and cleanup

Thrown detector/parser/Git-sampling errors are caught at `dispatch.ts:572-575`. Both plain and pane polling loops continue through their existing timeout, exit, pane-close, pidfile, and slot-release paths. This exception containment is sound; Finding 4 concerns samples incorrectly classified as successful, not uncaught exceptions.

### Claude and unknown non-streaming vendors

`loopDetectorTick()` exits before capture parsing, Git sampling, episode creation, or ledger emission for every vendor outside `codex`, `kimi`, and `opencode` (`loop-detector.ts:106-107`, `loop-detector.ts:628-631`). Claude therefore cannot reach either Stage 1 or Stage 2 through any polling path. This is stricter than suspicion-only behavior and is safe with respect to autonomous cancellation.

### Shared current-attempt refactor regression

The extraction into `current-attempt.ts` preserves the prior backward scan and slice semantics. `status.ts` and `cancel-task.ts` use that one helper, and the cancel-task addition correctly treats `agent_loop_suspected` as nonterminal. The new detector's failure to perform the required identity check is separately covered by Finding 5.
