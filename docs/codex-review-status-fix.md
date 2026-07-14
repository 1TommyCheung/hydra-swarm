# Cross-vendor review: queued status liveness fix

**Overall verdict: REJECT**

**Risk: MEDIUM.** The TypeScript implementation fixes the original blind suppression and the `cancel-task.ts` extraction is behavior-preserving. However, the change introduces a false-positive disagreement when process discovery itself is unavailable, and the Bash fallback's command validation is materially looser than the shared TypeScript validator. The Bash tests also omit the required live-but-non-matching case.

## Findings

### 1. [Medium] Process-discovery failure is reported as dispatcher death

`defaultListProcesses()` catches every `ps` failure and returns `[]` (`process-discovery.ts:8-17`). After the three-second grace period, `status()` passes that empty list to `validatedDispatchMatches()`, obtains no matches, and reports that the queued dispatcher may have been killed (`status.ts:417-434` and `status.ts:296-302`). The Bash fallback makes the same availability/absence conflation with `ps ... || true` (`status.sh:146-155`).

Consequently, a healthy task that remains queued can produce a spurious disagreement whenever `ps` fails, is denied, or returns a transiently incomplete snapshot. This is a new false-positive risk relative to the former unconditional queued suppression. It is directly observable in a restricted environment: `ps -axo pid=,command=` is denied, so the Bash live-process test reports the dispatcher as absent.

The original grace period is still correctly applied before discovery:

- TypeScript scans only when elapsed time is non-null and at least `DISPATCH_PIDFILE_GRACE_SECONDS` (3 seconds), and `detectDisagreement()` also returns `null` below that threshold (`status.ts:69`, `status.ts:296-297`, and `status.ts:417-425`).
- Bash enters queued discovery only when elapsed time is present and at least `grace_seconds=3` (`status.sh:158-165`).

That guard handles the normal pidfile-creation window. A `concurrency_wait` event is emitted by an already-running dispatcher, so ordinary process startup is not the main production race once that event is visible. The guard does not protect a long-queued task from a later transient process-scan failure. There is also the usual narrow snapshot race in the other direction: a process may exit or a PID may be reused between reading `ps`, checking `kill(pid, 0)`, and returning status.

### 2. [Medium] Bash validation does not mirror TypeScript validation

TypeScript finds the first `dispatch.ts`/`dispatch.sh` token and requires exact run and task tokens in the arguments **after** that dispatcher token (`process-discovery.ts:40-51`). Bash independently records whether a dispatcher basename, run token, and task token occur anywhere in the command (`status.sh:131-144`).

For example, an unrelated live command shaped like:

```text
python worker.py expected-run expected-task /tmp/dispatch.sh other-run other-task
```

is rejected by TypeScript because the expected identifiers are not dispatcher arguments, but accepted by Bash because all three tokens occur somewhere. Bash would therefore suppress the disagreement for a process that does not validate under the shared `isDispatchCommand()` semantics. Bash's quote stripping also differs for mismatched outer quotes, though the argument-position difference alone is substantive.

The high-level Bash control flow otherwise mirrors TypeScript: running state, no pidfile, expired grace, and trailing current-attempt `concurrency_wait` lead to a process scan; a match suppresses the disagreement and no match reports it. The command-matching difference means required case (c) is not equivalent in practice.

### 3. [Low] Bash coverage omits the non-matching live-process case

The new TypeScript tests genuinely exercise all three required outcomes with explicit assertions:

1. A live, exact dispatcher match produces `disagreement === null` (`status.test.ts:279-300`).
2. An empty process list produces the queued-dead disagreement (`status.test.ts:302-320`).
3. Live unrelated processes fail validation and produce the disagreement (`status.test.ts:322-342`).

These are meaningful unit tests of the injected discovery and liveness boundaries, although the non-matching fixture uses non-dispatch commands rather than a `dispatch.ts` command for the wrong run/task.

The Bash tests assert the absent case and spawn a real matching `dispatch.sh` process for the healthy case (`status.sh.test.ts:157-198`), but there is no live-but-non-matching Bash test. Thus they do not cover the exact branch where the Bash/TypeScript matcher divergence occurs. The live test also checks `child.pid` and immediately invokes status without waiting for the child command line to become visible; that creates avoidable test timing sensitivity even on systems where `ps` is allowed.

## Process-discovery extraction review

The extraction from `cancel-task.ts` is faithful and behavior-preserving:

- `ProcessInfo` retains exactly `pid: number` and `command: string`.
- `defaultListProcesses()` retains the same `execFileSync('ps', ['-axo', 'pid=,command='])` call, error-to-empty-list behavior, line regex, numeric PID conversion, and output ordering.
- `stripOuterQuotes()` and `isDispatchCommand()` are unchanged: whitespace tokenization, matching-quote removal, dispatcher basename recognition, and exact run/task membership after the dispatcher token are identical.
- `safeProcessAlive()`, `validatedDispatchMatches()`, and `processIsDispatch()` retain their original predicates and exception behavior. Their order in the new module has no semantic effect.
- `cancel-task.ts` re-exports `isDispatchCommand` and `ProcessInfo`, preserving its existing public import surface, and imports the other helpers from a dependency-free module. No new cycle is introduced.

The focused cancellation suite passed all 11 existing tests, including stale-PID rejection, queued discovery, escalation identity checks, and exact token matching. Static comparison with the parent commit confirms that the helper bodies were moved rather than rewritten.

## TypeScript liveness-path trace

All three paths share the gate at `status.ts:417-423`: state is `running`, parsed pidfile liveness is absent, elapsed time is at least three seconds, and the last event in the current-attempt window is `concurrency_wait`.

- **(a) Validated live dispatcher:** `validatedDispatchMatches()` requires `pid > 0`, a non-throwing positive liveness check, and `isDispatchCommand(command, runId, taskId)`. At least one match sets `queuedDispatchAlive=true`; `detectDisagreement()` returns `null` at `status.ts:299-301`.
- **(b) No process:** the empty process list yields no matches and leaves `queuedDispatchAlive=false`; `detectDisagreement()` returns the queued-dead message.
- **(c) Live non-matching process:** liveness alone is insufficient because `isDispatchCommand()` must also pass. Unrelated or wrong-identity commands are filtered out, again leaving `queuedDispatchAlive=false` and returning the queued-dead message.

The TypeScript implementation therefore handles all three required cases correctly. The reject verdict is due to discovery-error handling and Bash parity, not the central TypeScript predicate.

## Verification

- Passed: Node 22 focused `cancel-task.test.ts`: 11/11.
- Passed: Node 22 focused `status.test.ts`: 29/29.
- Passed: focused Bash queued-dead test: 1/1.
- Advisory environment result: the combined three-file run was 44/45; only the Bash live-dispatch integration test failed. Five focused reruns failed identically because this sandbox denies `ps`, which the implementation converts to an empty process list. The independently supplied out-of-sandbox result is 694/694.
- Typecheck could not run because `tsc` is not installed in this worktree environment.

## Recommendation

Request changes before acceptance:

1. Preserve an explicit “process discovery unavailable” result and avoid asserting dispatcher death from that state.
2. Make Bash validate exact run/task tokens after the dispatcher token, matching `isDispatchCommand()`.
3. Add a Bash test with a live unrelated or wrong-run/wrong-task dispatcher-shaped command, plus deterministic readiness synchronization for the live-process fixture.
