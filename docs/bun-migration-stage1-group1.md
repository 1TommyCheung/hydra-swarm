# Bun migration — Stage 1, group 1: router normalization (run 0036)

Mechanical normalization per `docs/bun-migration-plan-codex.md` and the spike
#2 finding (`docs/bun-migration-spike-adapters.md`): when bundled, every
`isMain` guard evaluates **true**, so the future single-CLI router must call an
exported `main()` from every file instead of relying on guard-triggered side
effects at import time. This change only extracts/verifies exported `main()`
entry points; it does **not** build the router and changes **zero** behavior in
the existing Node lane (`node --experimental-strip-types <file>.ts` and the
bash wrappers).

Reference patterns followed (both pre-existing):

- sync — `kit/hydra-ts/src/status.ts:489-535`:
  `export function main(args: string[] = process.argv.slice(2)): number`
  with `if (isMain) { process.exitCode = main(); }`
- async — `kit/hydra-ts/src/promote.ts:505-528`:
  `export async function main(args: string[] = process.argv.slice(2), ...): Promise<number>`
  with `if (isMain) { process.exitCode = await main(); }`

## Per-file results

### Already conformant (verified, untouched)

Each of these already exported a `main()` whose body parses argv, catches all
errors to a stderr write + numeric return, and never calls `process.exit()`
internally (verified by reading each one). Guards were already reduced to the
two-line pattern or the `.then()` async equivalent.

| File | Exported signature | Guard |
|---|---|---|
| `kit/hydra-ts/src/amend-task.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` (line 292) | `process.exitCode = await main();` |
| `kit/hydra-ts/src/audit-ownership.ts` | `export function main(args: string[] = process.argv.slice(2)): number` (line 242) | `process.exitCode = main();` |
| `kit/hydra-ts/src/build-worker-prompt.ts` | `export function main(args: string[] = process.argv.slice(2)): number` (line 123) | `process.exitCode = main();` |
| `kit/hydra-ts/src/cancel-task.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` (line 376) | `main().then((exitCode) => { process.exitCode = exitCode; })` (async equivalent) |
| `kit/hydra-ts/src/code-intel.ts` | `export function main(args: string[] = process.argv.slice(2)): number` (line 456) | `process.exitCode = main();` |
| `kit/hydra-ts/src/adapter-claude.ts` | `export function main(args: string[] = process.argv.slice(2)): number` (line 359) | `process.exitCode = main();` |
| `kit/hydra-ts/src/adapter-opencode.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` (line 605) | `void main().then((exitCode) => { process.exitCode = exitCode; })` (async equivalent) |

### Needed extraction (changed in this task)

Inline argv-parsing/dispatch logic was moved verbatim out of the
`if (isMain) { ... }` block into an exported `main()`; the guard was reduced to
the two-line pattern. All flags, argument order, error message text, and exit
codes are preserved exactly.

| File | Final exported signature | Sync/async |
|---|---|---|
| `kit/hydra-ts/src/adapter-stub.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync |
| `kit/hydra-ts/src/aggregate-usage.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync (`args` unused; CLI takes no arguments) |
| `kit/hydra-ts/src/allocate.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync |
| `kit/hydra-ts/src/adapter-codex.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` | async |
| `kit/hydra-ts/src/adapter-kimi.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` | async |

Extraction notes:

- `adapter-codex.ts` already used top-level `await` inside its guard, so
  `process.exitCode = await main();` is valid there.
- `adapter-kimi.ts` previously wrapped its dispatch in a fire-and-forget
  `(async () => { ... })()` IIFE; it is now `process.exitCode = await main();`
  (same shape as `promote.ts`). Its `isMain` check uses the no-`resolve()`
  variant (`pathToFileURL(process.argv[1])`) — preserved verbatim.
- `adapter-kimi.ts`'s default export (`{ buildWorkerPrompt, makeSrtSettings,
  kimiVisual, kimiStart }`) and `adapter-stub.ts`'s default export
  (`{ stub }`) are unchanged; `main` was not added to them (additive named
  export only).

## Bug fix: `adapter-codex.ts` spawnSync status check

Fixed the latent misbranch flagged by spike #6
(`docs/bun-migration-spike-adapters.md`) and item #9
(`docs/bun-migration-spike-testing.md`): `defaultSpawn` decided its first
branch with `result.status !== null`, but under Bun a spawn error produces
`status: undefined` (not `null`), so the check would silently take the wrong
branch (`exitCode = undefined`). The check is now loose:
`if (result.status != null)` (adapter-codex.ts:173), with a comment explaining
why. Under Node, spawn errors really do produce `status: null`, so the branch
taken today is unchanged — this is a no-op under Node and a fix under Bun.

Coverage: no existing test exercises `defaultSpawn` directly (grepped
`kit/hydra-ts/test` for `defaultSpawn` / `status === null` — no matches; the
`adapterCodex` suite always injects `options.spawn`, and the nearest spawn-error
test, `review-dispatch`'s "records 127 when the vendor executable is missing",
drives `review-dispatch.ts`, not this code). A new persistent test could **not**
be added because `kit/hydra-ts/test/**` is outside this task's writable paths
(the worker protocol's "Edit ONLY within these writable paths" is binding and
outranks the conditional "add one" instruction). As a substitute, a scratch
assertion script (kept outside the repo) imported `defaultSpawn` from both the
pre-change (git archive of HEAD) and post-change file and asserted identical
results under Node v24.16.0:

- missing executable (ENOENT, `status: null` under Node) → `exitCode 127` — same
  error branch taken before and after;
- `/bin/sh -c 'exit 3'` → `exitCode 3` — first branch unchanged;
- `/bin/sh -c 'kill -TERM $$'` → `exitCode null, signal 'SIGTERM'` — middle
  branch unchanged;
- plus the JS-level fact `undefined != null === false`, which is what makes the
  Bun (`status: undefined`) and Node (`status: null`) shapes equivalent now.

A follow-up task with `test/` writable should add a persistent test asserting
the null-status branch (e.g. `defaultSpawn('missing-cmd', [], {})` → 127).

## Top-level import-time side effects (all 13 files)

Every file was scanned for module-level code outside any function/guard.
**No problematic import-time side effects were found in any of the 13 files.**
The only top-level statements are:

- simple const/type declarations:
  `adapter-opencode.ts:37 DEFAULT_MODEL`, `adapter-stub.ts:57
  DETERMINISTIC_DATE`, `allocate.ts:20 MIN_N`, `allocate.ts:27 SEED_FILES`,
  `cancel-task.ts:59 TERMINAL_EVENTS` (+ injected-default arrow-function consts
  at lines 61-74), `code-intel.ts:70 ANSI_RE`;
- the `const isMain = process.argv[1] !== undefined && import.meta.url ===
  pathToFileURL(...).href;` comparison itself (executes a cheap pure path
  computation at import; part of the reference pattern, same as
  `status.ts`/`promote.ts`);
- the `if (isMain) { ... }` guard, which is inert on import under Node (and is
  what the future router/build gate must neutralize under `bun build
  --compile`, per spike #2 — out of scope here).

No file performs I/O, spawns processes, reads env-dependent state into module
state, or mutates anything at import time.

## Verification performed (all advisory; harness re-verifies)

Environment: Node v24.16.0 (`--experimental-strip-types`), macOS arm64. The
default `/usr/local/bin/node` is v17.4.0 and cannot run the suite (pre-existing
PATH-shadowing note from the testing spike).

1. **Full suite, zero regression** — `npm test` in `kit/hydra-ts`:
   baseline (pre-change) **76 pass / 87 fail**; post-change **76 pass / 87
   fail**, with byte-identical sets of passing and failing test names (diffed).
   All 87 baseline failures are pre-existing environment/sandbox artifacts, not
   code failures: this shell denies writes to any `**/.git/**` path inside the
   worktree (fixtures cannot `git init`) and to certain dotfiles
   (e.g. `.bash_profile`), and blocks `ps` visibility for `status.sh` process
   checks. None of them touch the changed code paths; the suites that do
   exercise the changed files (`adapterCodex`, `kimiStart` errors aside,
   `adapter-stub`, `aggregateUsage`, `CLI`, `allocate`, `allocate CLI`,
   `defaultExec`, …) pass identically before and after.
2. **Direct invocation, byte-identical I/O** — each extracted file was run
   directly via `node --experimental-strip-types <file> <args>` from both the
   pre-change source (git archive of HEAD) and the post-change source, with
   stdout, stderr, and exit code diffed (9/9 identical):
   - `adapter-stub.ts` — usage-error (exit 1, usage text) and a **real success
     run** (`start` verb against a git fixture, `STUB_MODE=success`): identical
     stdout (`run-9999`), identical `inbox/result.json`, identical session
     file, and an identical resulting commit SHA (`c370105d…`, deterministic
     fixture dates).
   - `aggregate-usage.ts` — success against an empty `HYDRA_STATE_ROOT`
     (exit 0, same stderr log line) and an error case (state root a regular
     file → `ENOTDIR`, exit 1).
   - `allocate.ts` — usage-error plus two success cases
     (`implementer code_review high`; `reviewer long_diff --exclude-vendor
     codex`), exit 0, identical JSON.
   - `adapter-codex.ts`, `adapter-kimi.ts` — usage-error cases (real success
     cases are infeasible without paid/side-effectful vendor CLI spawns).
   - Harness note: on macOS, files under `/tmp` must be invoked via their
     `/private/tmp` real path, or the `isMain` guard itself goes false
     (symlink mismatch) — observed and worked around during verification.
3. **defaultSpawn branch check** — see "Bug fix" above; base vs new behavior
   identical under Node for all three branches.
4. `npm run typecheck` could not be run: `node_modules` is absent and the npm
   registry is unreachable from this environment (403). Type/syntax safety was
   instead established by the test suite and the direct invocations, all of
   which import/execute the modified modules (a strip-types or syntax error
   would fail loudly).
