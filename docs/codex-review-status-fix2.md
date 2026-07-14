# Code review: codex-review-status-fix2 (run 0026, spec v1)

**Overall verdict: ACCEPT**

The v2 fix correctly closes both findings from the rejected v1 review.
The TypeScript and bash status paths now distinguish "discovery could not run"
from "discovery ran and found nothing," and the bash dispatcher validation now
matches TypeScript's positional semantics exactly. The new tests genuinely
exercise both fixes. No source code files were modified by this review.

> Note: the read-only context file `docs/codex-review-status-fix.md` (the v1
> review) is not present in this worktree, so this review was performed purely
> from the v2 code, the task spec, and the referenced findings.

---

## Finding 1 — discovery failure vs. "no matches" distinction

**Verdict: FIXED**

### TypeScript path

`process-discovery.ts` exposes two discovery functions:

- `defaultListProcessesOrNull()` returns `null` when the `ps` invocation itself
  fails (`kit/hydra-ts/src/process-discovery.ts:26-37`).
- `defaultListProcesses()` collapses that `null` to `[]` for callers whose
  existing contract treats any discovery failure as "no matches"
  (`kit/hydra-ts/src/process-discovery.ts:45-47`).

`status.ts` uses the nullable variant (`kit/hydra-ts/src/status.ts:419`) and
maps the three outcomes explicitly:

```ts
const processes = listProcesses();
if (processes === null) {
  queuedDiscovery = 'unavailable';
} else {
  const matches = validatedDispatchMatches(processes, processAlive, runId, taskId);
  queuedDiscovery = matches.length > 0 ? 'alive' : 'dead';
}
```

— `kit/hydra-ts/src/status.ts:445-452`

`detectDisagreement()` then suppresses the queued-death report when discovery
was unavailable:

```ts
if (queuedDiscovery === 'alive') return null;
if (queuedDiscovery === 'unavailable') return null;
return 'ledger reports queued (concurrency_wait) but no live dispatch process was found; the dispatcher may have been killed while queued';
```

— `kit/hydra-ts/src/status.ts:315-319`

This is exactly the required behavior: `ps` failure is not conflated with a
genuine zero-match result, and it does not produce a false-positive
"dispatcher-may-be-dead" disagreement.

### Bash path

`status.sh` mirrors the same three-valued logic:

```bash
queued_dispatch_check() {
  local ps_output candidate command
  if ! ps_output="$(ps -axo pid=,command= 2>/dev/null)"; then
    return 2   # discovery itself unavailable
  fi
  ...
  return 1     # ran and found no validated live dispatcher
}
```

— `kit/hydra/scripts/status.sh:184-195`

The caller only emits the disagreement on return code `1`; return codes `0`
(alive) and `2` (unavailable) are suppressed:

```bash
queued_rc=0
queued_dispatch_check || queued_rc=$?
if [ "$queued_rc" -eq 1 ]; then
  disagreement='ledger reports queued (concurrency_wait) but no live dispatch process was found; the dispatcher may have been killed while queued'
fi
# queued_rc 0 (alive) or 2 (discovery unavailable): suppress, no disagreement.
```

— `kit/hydra/scripts/status.sh:203-208`

### Test coverage

The TypeScript test
`"does not report a death disagreement when process discovery itself is unavailable"`
forces `listProcesses: () => null` and asserts `disagreement === null`
(`kit/hydra-ts/test/status.test.ts:373-394`). This directly exercises the
"discovery unavailable → no disagreement" path.

---

## Finding 2 — bash command validation must require run/task tokens after the dispatcher token

**Verdict: FIXED**

### TypeScript semantics

`isDispatchCommand()` in `process-discovery.ts` tokenizes the command, finds the
first dispatcher token (`dispatch.ts` or `dispatch.sh`), and then checks that
both `runId` and `taskId` appear among the arguments **after** that token:

```ts
const dispatchIndex = tokens.findIndex((token) => {
  const basename = token.split('/').at(-1);
  return basename === 'dispatch.ts' || basename === 'dispatch.sh';
});
if (dispatchIndex < 0) return false;
const args = tokens.slice(dispatchIndex + 1);
return args.includes(runId) && args.includes(taskId);
```

— `kit/hydra-ts/src/process-discovery.ts:61-73`

### Bash semantics

`command_matches_dispatch()` in `status.sh` now matches this exactly:

```bash
for ((i = 0; i < ${#cleaned[@]}; i++)); do
  case "${cleaned[i]##*/}" in
    dispatch.ts|dispatch.sh) dispatch_index=$i; break ;;
  esac
done
[ "$dispatch_index" -ge 0 ] || return 1
for ((i = dispatch_index + 1; i < ${#cleaned[@]}; i++)); do
  [ "${cleaned[i]}" = "$run_id" ] && has_run=1
  [ "${cleaned[i]}" = "$task_id" ] && has_task=1
done
[ "$has_run" -eq 1 ] && [ "$has_task" -eq 1 ]
```

— `kit/hydra/scripts/status.sh:159-178`

It strips outer quotes identically to TypeScript (`_hydra_strip_outer_quotes`,
`status.sh:139-151`), locates the first dispatcher basename, and only scans
tokens to the right of it.

### Counterexample verification

The original counterexample command
`python worker.py expected-run expected-task /tmp/dispatch.sh other-run other-task`
was reconstructed and verified against the extracted bash function. The run/task
tokens appear before the dispatcher token, so `command_matches_dispatch`
correctly returns `1` (rejected). The TypeScript test
`"reports disagreement when a live process runs a dispatcher for the wrong task"`
includes exactly this shape (`kit/hydra-ts/test/status.test.ts:364`) and asserts
a disagreement.

### Test coverage

- TypeScript: `kit/hydra-ts/test/status.test.ts:344-371` exercises a live
  dispatcher-shaped process for the wrong `run_id`/`task_id` and asserts it is
  rejected.
- Bash: `kit/hydra-ts/test/status.sh.test.ts:231-268` spawns a real
  `dispatch.sh` process for the wrong run/task, waits until it is visible via
  `ps`, and asserts the disagreement is produced.

---

## Test-timing sensitivity in the live-process bash tests

**Verdict: FIXED with real synchronization**

`status.sh.test.ts` now provides `waitForProcessVisible()`
(`kit/hydra-ts/test/status.sh.test.ts:24-40`), which polls `ps` until the
spawned child's command line is observable or a timeout elapses. Both live
process tests use this helper before asserting against `status.sh` output
(`status.sh.test.ts:218-221` and `:256-259`). This is real synchronization, not
just a longer sleep.

---

## Regression checks

- `process-discovery.ts` extraction: behavior is preserved for `cancel-task.ts`,
  which continues to use `defaultListProcesses()` (the `null`-collapsing
  variant) and `validatedDispatchMatches()` / `processIsDispatch()`.
- The three core TypeScript liveness cases are intact and covered:
  - alive (`status.test.ts:279-300`),
  - absent/dead (`status.test.ts:302-320`),
  - non-matching (`status.test.ts:322-342`).
- `cancel-task.test.ts` — all 11 existing tests pass.

---

## Local verification

- Default `node` in this environment is v17.4.0, which cannot run the test
  suite. Tests were run with Node v22.14.0 from the installed `nvm` tree.
- `node --experimental-strip-types --test test/status.test.ts test/cancel-task.test.ts`
  passed in full (42 / 42 tests).
- `test/status.sh.test.ts` could not be exercised for live-process cases in this
  sandbox because `/bin/ps` is denied with "Operation not permitted". This
  causes `queued_dispatch_check` to return `2` (discovery unavailable) and
  suppress the disagreement, which is the correct behavior for that degraded
  condition but prevents the positive/negative live-process assertions from
  running here. The bash logic was independently verified with a fake `ps` in
  `PATH` and with the reconstructed counterexample.
- No source code files were modified.

---

## New issues introduced by this fix

None identified.
