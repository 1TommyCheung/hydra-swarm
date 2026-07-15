# Bun migration Stage 4 — adversarial TypeScript runtime review

Run 0041, task `review-runtime-changes`. Reviewed the accumulated runtime diff
`f34de42..446a3f4` under `kit/hydra-ts/src` and `kit/hydra-ts/test`, after
reading the accepted plan, all three spike reports, the four Stage 1 reports,
the four Stage 2 reports, and both Stage 3 reports in the order specified by
the task.

## Verdict: REJECT

The router table, argv forwarding, ordinary guard neutralization, asset split,
override precedence, audit-ownership environment fix, vendor spawn strips, and
in-process freshness gate are internally consistent. However, the compiled
binary's production `dispatch` path still has only `ts` and `bash` adapter
runtimes. It defaults to `ts` even when `HYDRA_HARNESS=bin`, derives adapter
source paths from the synthetic `/$bunfs/root` module URL, and uses the
compiled executable itself as the supposed Node interpreter. Consequently, a
valid `hydra dispatch` cannot launch any worker from the standalone binary.
This defeats the migration's main runtime objective and is a merge blocker.

Two smaller runtime issues were also found: the `isCompiledBinary()` heuristic
has a reproducible plain-Node false positive for a checkout physically rooted
under `/$bunfs`, and `herdr-push.ts` was missed by the `BUN_BE_BUN` child-spawn
audit.

## Real bugs

### 1. High — compiled `dispatch` cannot launch an adapter

Evidence:

- `kit/hydra-ts/src/dispatch.ts:83` exposes only `'bash' | 'ts'`; there is no
  compiled/self-reexec runtime.
- `dispatch.ts:1053-1057` maps every non-bash case, including
  `HYDRA_HARNESS=bin`, to `ts`.
- `dispatch.ts:1062-1070` derives `adapter-<vendor>.ts` from
  `dirname(fileURLToPath(import.meta.url))`. In the compiled binary that
  directory is the synthetic `/$bunfs/root`, not a source checkout.
- `dispatch.ts:754-757` launches a `ts` adapter as
  `<nodeExecutable> --experimental-strip-types <adapterPath> ...`, while
  `dispatch.ts:1153` defaults `nodeExecutable` to `process.execPath`. In a Bun
  executable, that is the Hydra executable itself, not Node.
- `kit/hydra-ts/src/cli.ts:67-102` routes public `adapter-<vendor>` commands,
  but `dispatch.ts` never self-reexecutes one of those commands (nor the
  accepted plan's `__adapter <vendor>` form).
- Current source tests preserve the old Node behavior: for example,
  `kit/hydra-ts/test/dispatch.test.ts:358,371,406,425` explicitly expect
  `process.execPath`. The Stage 3 black-box suite only invokes `dispatch` with
  no arguments and checks its usage error; it never creates a valid task and
  follows the worker-spawn path.

Concrete failing scenario:

1. Build `src/cli.ts` with the repository's `npm run build:bin` command.
2. Create a valid run/task whose vendor is `claude`, whose worktree exists,
   and whose adapter override is unset.
3. Run `HYDRA_HARNESS=bin dist/hydra-cli dispatch <run> <task>`.
4. `adapterRuntime` becomes `ts`. Normally the command fails the
   `isFile('/$bunfs/root/adapter-claude.ts')` check with `no adapter for
   vendor 'claude'`. Even if a runtime exposed that virtual path as a file,
   the next hop would execute `dist/hydra-cli --experimental-strip-types ...`;
   the router would treat `--experimental-strip-types` as an unknown Hydra
   subcommand rather than starting Claude.

Required correction: add the static adapter capability registry and a
compiled/self-reexec mode, default it when running the binary, and add a
compiled black-box dispatch fixture that reaches the adapter child (the stub
adapter is sufficient and avoids vendor/API calls). The test must assert exact
argv, exit propagation, and the plain plus Herdr wrapper shapes.

### 2. Medium — `herdr-push.ts` is a missed `BUN_BE_BUN` strip site

Evidence:

- `kit/hydra-ts/src/herdr-push.ts:60-65` calls `execFileSync` without an
  explicit sanitized environment.
- The same runner starts Herdr at `herdr-push.ts:210`, lists panes at line 241,
  renames a pane at line 265, sends a notification at line 288, and lists
  agents at line 309.
- The Stage 2 audit applied
  `{ ...process.env, BUN_BE_BUN: undefined }` to the equivalent Herdr calls in
  `dispatch.ts:142-196` and to `review-dispatch.ts:70-75`, but its inventory
  omitted `herdr-push.ts` entirely.

Concrete failing scenario: run the supported Node source lane with
`BUN_BE_BUN=1` and a Bun-compiled Herdr executable. Node starts normally, but
`herdr-push` implicitly passes `BUN_BE_BUN` to Herdr. The child acts as the Bun
CLI instead of Herdr; the initial `herdr status` probe fails and Hydra silently
falls back to writing `herdr-panes.json` rather than updating live panes. The
same omission affects rename, notification, and reconciliation calls if the
availability probe is injected or otherwise succeeds.

Required correction: make `defaultExec` extend the call's existing `env` (or
`process.env`) while setting `BUN_BE_BUN: undefined`, and add a test that the
real default runner's child sees the variable as absent.

### 3. Low — `isCompiledBinary()` can suppress legitimate Node entry points

Evidence: `kit/hydra-ts/src/kit-assets.ts:37-39` decides solely from
`import.meta.url.startsWith('file:///$bunfs/')`. This is true for Bun's virtual
filesystem, but it is also true for an ordinary Node module physically located
under the legal absolute path `/$bunfs/...`.

Concrete failing scenario: in a root-run container, check out the repository
at `/$bunfs/hydra`, then run:

```text
node --experimental-strip-types /$bunfs/hydra/kit/hydra-ts/src/status.ts <run> <task>
```

Node gives `kit-assets.ts` a URL beginning `file:///$bunfs/`, so
`isCompiledBinary()` returns true. `status.ts:531` therefore suppresses its
legitimate direct-invocation guard and exits successfully without running
`main()`. The same applies to all 34 directly invocable modules, and
`kitAssetPath()` also takes compiled-lane error behavior under plain Node.

The normal checkout was independently probed and returns false. A URL probe
for `/$bunfs/checkout/...` returns
`file:///$bunfs/checkout/...` and matches the current predicate, establishing
the collision. The detector should include a runtime-specific discriminator
rather than treating a filesystem prefix as unique.

## Checks found solid

### CLI routing and argv shape

- Read all 34 imports and all 34 `routes` entries in `cli.ts:22-102`; every key
  maps to the `main` imported from the same-basename module. Mechanical counts
  are 34 routes, 34 non-CLI guard modules, and 34 guarded modules.
- Read every routed module's actual `main()` block. All 34 accept
  `args: string[] = process.argv.slice(2)` and parse their first CLI argument
  from `args[0]` (or ignore args for the two no-argument commands). None reads
  `process.argv[2+]` inside its callable body. Therefore `route()` at
  `cli.ts:120-130` correctly removes exactly one router subcommand with
  `argv.slice(1)` for every module.
- `test/cli.test.ts` independently identity-checks all 34 table slots, checks
  forwarding for all 34, and compares seven routed child invocations with
  direct source invocation. The targeted router/assets/graph-impact run below
  passed 115/115.

### Guard neutralization

- Grep and source inspection found exactly 34 non-`cli.ts` `isMain` guards and
  all 34 begin with `!isCompiledBinary()`. `cli.ts` is the lone intentionally
  ungated entry guard.
- The normal source checkout probe returned
  `{"isCompiledBinary":false}` under Node 22.14.0, and direct/router tests
  confirm ordinary source-lane invocation remains active. The only defect is
  the physical `/$bunfs` collision reported above.

### Asset embedding and checkout-relative assets

- EMBED set matches the spike verdict: the four profile YAML files are loaded
  through `kitAssetText()` in `allocate.ts:37-46`, result schema through
  `promote.ts:30-31`, and review schema through `record-review.ts:27-28`.
  `cli.ts:147-170` registers precisely those six embedded texts before routing.
- CHECKOUT-RELATIVE set matches the verdict: WAVE at
  `create-worktree.ts:103-107`, promote verification policy at
  `promote.ts:34-37`, integrate verification policy at
  `integrate.ts:37-40`, and review policy at
  `review-required.ts:21-25` all use `kitAssetPath()`.
- Override precedence was verified from implementation, not only test names:
  `allocate.ts:37-43` consults `profilesDir` first;
  `create-worktree.ts:148-156,282-283` gives `HYDRA_WAVE` precedence over the
  option-selected/default file and gives `wavePath` precedence over the
  default; `promote.ts:274-275,284-293` gives policy/schema options and
  `HYDRA_VERIFY_POLICY` precedence; `record-review.ts:176-178` gives
  `schemaPath` precedence; `integrate.ts:145-148` gives
  `HYDRA_VERIFY_POLICY` and `HYDRA_SMOKE_POLICY` precedence; and
  `review-required.ts:63` gives `policyFile` precedence.
- Whole-tree grep found no missed old kit-asset reader using
  `dirname(fileURLToPath(import.meta.url))`. The only remaining occurrence is
  `kit-assets.ts:57`, the deliberate plain-Node fallback. `dispatch.ts` still
  computes adapter directories from `import.meta.url`; that is not one of the
  eight documented data assets, but it is the core compiled-dispatch bug above.
- Stage 3's real native and Linux black-box evidence already proves the dynamic
  embedded imports are traced and the embedded profiles/review schema survive
  relocation. This review did not recompile because runtime/build artifacts
  were outside this task's writable path.

### Spawn and environment changes

- `audit-ownership.ts:101-209` now constructs `{ ...process.env }` at each
  synchronous Git call. Under Node this is equivalent to implicit inheritance:
  the launch shell environment and any current `process.env` mutations were
  already inherited. The spread neither adds variables absent from
  `process.env` nor creates an asynchronous window for later mutation. Under
  Bun it intentionally repairs post-start mutations such as
  `GIT_CEILING_DIRECTORIES`.
- The actual vendor boundaries strip `BUN_BE_BUN`: Claude
  (`adapter-claude.ts:66-75`), Codex (`adapter-codex.ts:165-174`), Kimi/srt
  (`adapter-kimi.ts:345-353`), OpenCode (`adapter-opencode.ts:130-137`), and
  direct review vendor wrappers (`review-dispatch.ts:70-78`). Dispatch's four
  Herdr methods strip it at `dispatch.ts:142-196`, and its plain worker spawn
  passes the explicitly stripped `ctx.env`. Broad grep found the missed
  `herdr-push.ts` family reported above; other remaining calls are Git,
  `pgrep`, shell dependency probes, verification's scrubbed `env -i`, or
  Graphify/GitNexus tooling rather than vendor/Hydra self-invocation.
- The Bun `spawnSync` `status: undefined` fixes use `!= null` correctly in
  `adapter-codex.ts` and `review-dispatch.ts`.

### `graph-impact` freshness-gate semantics

- The default path no longer spawns the checkout shell script. It calls
  `freshnessGate(runId, taskId).fresh` at `graph-impact.ts:108-109`.
- Observable failure mapping is preserved. Previously every nonzero subprocess
  status (including freshness exit 8 and internal exit 1) became one
  `stale_omitted` ledger event, a warning, and `GraphImpactError(..., 8)`.
  Now `fresh === false` and any thrown gate error both reach that same block at
  lines 116-130. The original exception was never exposed to the caller, and
  the piped child stderr/stdout was ignored, so exception type/text and exit
  mapping do not regress. The optional script path remains only as an injected
  test hook.

## Independent verification

Environment: Node v22.14.0 selected explicitly because the machine's default
Node 17 cannot run the TypeScript test lane.

- `cd kit/hydra-ts && npm test` — **not green**: concurrent lane discovered
  808 tests, 805 passed, 3 failed, 0 cancelled. All three failures are the
  documented `test/status.sh.test.ts` process-visibility cases at lines
  182-256 (`ps` cannot observe the spawned dispatcher in this sandbox). No
  Git fixture failures occurred in this run, so this is not the documented
  72-failure `.git`-write signature. Because the package script uses `&&`, the
  isolated promote lane did not run automatically.
- `npm run test:promote` — **27/27 passed** when run independently.
- `node --experimental-strip-types --test test/cli.test.ts
  test/kit-assets.test.ts test/graph-impact.test.ts` — **115/115 passed**.
- `git diff --check f34de42..HEAD -- kit/hydra-ts/src kit/hydra-ts/test` —
  passed.
- `npm run typecheck` was unavailable because `node_modules/.bin/tsc` is not
  installed; no dependency installation was attempted.

The requested “810-test” number does not reproduce at this HEAD. The actual
package lanes currently total 808 concurrent tests plus 27 isolated promote
tests (835 executions when both are run). This agrees with the Stage 3 report's
808-test shape, while the Stage 2 guard report separately recorded an
environment-dependent 810-test shape. The substantive zero-regression signal
available here is 805/808 with exactly the known three process-visibility
failures, plus 27/27 promote and 115/115 focused runtime tests—not a fabricated
810/810 claim.

## Review limitations and required next verification

- GitNexus reported its index current at `446a3f4`, but `detect-changes` could
  not run because its CLI attempted to update
  `~/.gitnexus/registry.json.tmp`, outside this task's permitted writable
  paths. Direct diff, call-site, and test analysis was used instead.
- After fixing finding 1, run a compiled, checkout-free stub dispatch through
  both plain and Herdr modes on native macOS and both Linux architectures.
  Assert the self path, adapter subcommand/verb argv, empty prior-session
  preservation, cwd/env, sentinel, signal, timeout, and exit-code behavior.
- After fixing finding 2, add whole-tree spawn-audit tests so a newly added
  vendor/Hydra/Herdr child cannot omit the explicit strip unnoticed.
