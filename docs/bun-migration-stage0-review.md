# Bun migration Stage 0 review

## Verdict: reject-and-fix

Stage 0 is scope-disciplined and the normal Bun-compiled self-re-exec path works,
but it does not satisfy the release-blocking `BUN_BE_BUN` requirement. An
inherited `BUN_BE_BUN=1` hijacks the initial compiled process before
`bin-cli.ts` can delete the variable. In addition, `status` reports `ok: true`
and exits 0 even when its self-reexec result is absent or malformed. These are
real correctness gaps in the spike's claimed proof, not hypothetical production
concerns.

Review environment: macOS arm64, Bun 1.3.14, Node 22.14.0. The implementation
commit is `f29e46eeb376e68c23633d3dd252e7a00b2b35f4`; because the review branch
starts at that commit, its parent `d48ebe2` is the actual pre-implementation
snapshot.

## Findings

### 1. Blocker: startup deletion cannot protect the initial binary from `BUN_BE_BUN`

`kit/hydra-ts/src/bin-cli.ts:9-14` deletes `BUN_BE_BUN` only after the bundled
entry point starts. Bun's executable loader processes the variable earlier.
The [Bun standalone-executable documentation](https://bun.sh/docs/bundler/executables#act-as-the-bun-cli)
states that `BUN_BE_BUN=1` makes a standalone executable ignore its bundled
entry point and act as the Bun CLI. The repository's prior spike records the
same ordering at `docs/bun-migration-spike-results.md:62-74`.

The child env expression itself is correct. The
[Node child-process documentation](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
states that `undefined` values in `env` are ignored. Node 22.14.0 empirical
evidence agreed: a child launched with
`env: { ...process.env, HYDRA_UNDEFINED_ENV_PROBE: undefined }` printed
`false:undefined`, proving the key was absent. `spawnSync()` of a nonexistent
command also returned `{ status: null, error: "ENOENT" }`; it did not throw.

Bun 1.3.14's `node:child_process` implementation also dropped the key. A Bun
parent set its own `process.env.BUN_BE_BUN = "1"`, then spawned the compiled
Stage 0 binary with `env: { ...process.env, BUN_BE_BUN: undefined }`; the child
ran `status`, exited 0, and produced a populated `selfReexecCheck`. Thus
`bin-cli.ts:25-29` protects self-reexec children once the parent entry point is
already running.

The initial launch still fails concretely:

```text
$ env BUN_BE_BUN=1 ./dist/hydra-bin-stage0 status
error: Script not found "status"
$ echo $?
1
```

The same environment applied to `test/bin-cli.test.ts` made all three compiled
binary tests fail (0 passed, 3 failed): `status` and relocated `status` exited 1,
and the unknown-subcommand case exited 1 rather than 2. No child report exists
to inspect because the bundled parent never runs. Therefore the startup delete
at `bin-cli.ts:12-14` does not implement the intended shell-to-binary defense.
The fix must occur before executable startup (for example, the planned
`env -u BUN_BE_BUN` launcher at `docs/bun-migration-plan-codex.md:303-307`) or
through a compile-time mechanism proven to disable the hijack. A regression
test must launch the compiled artifact from a process that initially has
`BUN_BE_BUN=1`.

### 2. High: `status` converts self-reexec failure into a false success

`kit/hydra-ts/src/bin-cli.ts:32-41` ignores `child.status`, `child.signal`, and
`child.error`; missing stdout or a JSON parse error leaves `childReport` as
`null`. Lines 43-50 then unconditionally emit `ok: true` and set exit code 0.
Malformed child JSON is caught, so it does not crash the parent, but the result
is misleading rather than sane:

```json
{"ok":true,"runtime":"bun-cli-stage0","selfReexecCheck":null}
```

There is also no timeout in `selfReexec()` (`bin-cli.ts:25-29`), so a stuck
child can hang `status` indefinitely. Since the delivery document claims the
populated object proves self-reexec (`docs/bun-migration-stage0.md:10-13`), the
status contract should validate a zero child exit, no spawn error/signal,
well-formed JSON, and the expected report shape. Failure should produce
`ok: false` and a nonzero parent exit (with bounded execution).

### 3. Medium: the real-subprocess test does not prove adapter argument routing

The status test obtains the child report at
`kit/hydra-ts/test/bin-cli.test.ts:91`, but lines 92-99 assert only that
`execPath` is a non-empty existing path. It never asserts that the child's
`argv` contains `__adapter`, `stub`, and `spike-check`. The relocation test at
lines 115-124 likewise checks only `execPath`. A regression that misroutes the
vendor or verb can therefore evade the test even though argument delivery is a
load-bearing claim.

Direct empirical checks showed the implementation currently behaves as
intended: `__adapter stub verb-one arg-a arg-b` preserved all five arguments and
exited 0; a missing vendor, missing verb, or unknown vendor exited 2. The gap is
coverage, not observed routing behavior. Add assertions for the exact child
argv slice and direct cases for missing/unknown adapter arguments, as well as
the inherited-`BUN_BE_BUN` case from finding 1.

### 4. Medium: the required full Node suite is not green in this environment

With Node 22.14.0 selected, `npm test` completed with 676 tests: 673 passed and
3 failed. The failures were the existing process-discovery cases at
`kit/hydra-ts/test/status.sh.test.ts:182`, `:196`, and `:231`. Running that test
file alone reproduced the same 3/6 failures.

This diff does not modify `status.sh.test.ts` or its implementation, and the
failure reproduces without the new binary test running concurrently, so there
is no evidence that Stage 0 caused these failures. Nevertheless, the requested
claim that the full existing suite passes with zero regressions cannot be made
from this checkout. The harness should re-run its normal suite in its reference
environment and resolve or classify those failures.

### 5. Medium: Stage 0 does not complete the plan's build-matrix proof

The Stage 0 plan requires movable/no-Node execution on both supported macOS
architectures (`docs/bun-migration-plan-codex.md:480-485`) and requires compiled
runtime auto-loading to be disabled (`docs/bun-migration-plan-codex.md:288-294`).
The only build command, at `kit/hydra-ts/package.json:13`, has no explicit target
and omits both `--no-compile-autoload-dotenv` and
`--no-compile-autoload-bunfig`.

The produced artifact was verified as `Mach-O 64-bit executable arm64` and ran
successfully with an empty environment except `PATH`, proving native arm64
standalone execution. There is no x64 artifact or x64 smoke evidence in the
delivery. This is a Stage 0 completeness gap even though it does not affect the
native-path findings above.

## Scope-discipline verification

I ran the actual implementation diff, not the task's claimed file list:

```text
$ git diff-tree --no-commit-id --name-status -r f29e46eeb376e68c23633d3dd252e7a00b2b35f4
A docs/bun-migration-stage0.md
A kit/hydra-ts/.gitignore
M kit/hydra-ts/package.json
A kit/hydra-ts/src/bin-cli.ts
A kit/hydra-ts/test/bin-cli.test.ts
```

`git diff --stat f29e46e^ f29e46e` reported exactly those five files, with 287
insertions and 1 deletion. No existing file outside the allowed five changed.

I also ran `git diff --exit-code f29e46e^ f29e46e` restricted to
`dispatch.ts`, `review-dispatch.ts`, `lib.ts`, and every `src/adapter-*.ts`; it
exited 0. Their before/after Git blob IDs matched:

| File | Unchanged blob |
|---|---|
| `kit/hydra-ts/src/dispatch.ts` | `ce994283577e19127c680e427186c55471e0a350` |
| `kit/hydra-ts/src/review-dispatch.ts` | `14cff5d28c2b2d6662dc716230b9895d6edc1001` |
| `kit/hydra-ts/src/lib.ts` | `68598769ffab4dd4d25cf6333569f20df5238b1c` |
| `kit/hydra-ts/src/adapter-claude.ts` | `7a6d5e047061adfc7e98fef2c8fac6b3bccb4621` |
| `kit/hydra-ts/src/adapter-codex.ts` | `192fa950bb50f7c48cd64edfb49799a830a45630` |
| `kit/hydra-ts/src/adapter-kimi.ts` | `6a620f44ad134ad09b873886b2a01014c57a637f` |
| `kit/hydra-ts/src/adapter-opencode.ts` | `e0d97b7a6e0ddff327454d2d81182e78cb61b8e7` |
| `kit/hydra-ts/src/adapter-stub.ts` | `b4ae05c7b8c4f148690169fdd4182cedcaa01c7e` |

Parsing `package.json` at both commits and removing only the new `build:bin`
key showed the remaining `scripts` objects identical in value and order:
`test`, `test:concurrent`, `test:promote`, and `typecheck` are unchanged.

## Other verified behavior

- With Bun available, `node --experimental-strip-types --test
  test/bin-cli.test.ts` passed all 3 tests.
- With `PATH=/usr/bin:/bin` (no Bun) and Node invoked by absolute path, the same
  test file exited 0 without failure or hang. `bunAvailable()` is safe on
  `ENOENT` because `spawnSync()` returns a result with `status: null`; it does
  not throw. The current placeholder is counted by Node as a pass
  (`pass 1`, `skipped 0`), not a native skip; using `it.skip()` would improve CI
  reporting but is not a functional blocker.
- Unknown top-level commands print usage to stderr and exit 2. Existing CLI
  entry points use mixed usage conventions (for example, `status.ts` returns 1,
  while promote's internal/usage error and `jsonschema.mjs` use 2). Because this
  is a new, unwired standalone entry point, exit 2 creates no compatibility
  regression and is a reasonable usage-error contract.
- GitNexus mapped the five-file change to 16 symbols and two new local flows:
  `main -> handleStatus -> selfReexec` and
  `main -> failUnknown -> printUsage`. `selfReexec` has only one direct caller,
  `handleStatus`, so the correctness gaps are localized to the new entry point.

## Verification summary

| Check | Result |
|---|---|
| Actual `f29e46e^..f29e46e` scope diff | Pass: exactly the five declared files |
| Named existing-file blob comparison | Pass: all byte-identical |
| Existing npm script comparison | Pass: all unchanged |
| Node undefined-env behavior | Pass: key absent in child |
| Bun undefined-env behavior | Pass: key absent in compiled child |
| Initial binary with inherited `BUN_BE_BUN=1` | **Fail: entry point hijacked, exit 1** |
| Compiled binary targeted test (normal env) | Pass: 3/3 |
| Compiled binary targeted test (no Bun) | Passes cleanly; reported as pass, not skip |
| Full `npm test` | **Fail: 673/676; three existing `status.sh` cases** |
| Native no-Node/empty-environment smoke | Pass on arm64 |
| macOS x64 artifact/smoke | Not delivered |
