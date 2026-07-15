# Bun migration Stage 4 adversarial review: Bash and build tooling

Run 0041, task `review-bash-and-build-tooling`, reviewing
`git diff f34de42..446a3f4` for `kit/hydra/scripts`,
`kit/hydra-ts/package.json`, and `kit/hydra-ts/scripts`.

## Verdict: reject

The ordinary wrapper routing is mechanically consistent, the current compiled
artifact passes the supplied black-box suite, and the source test result matches
the documented baseline. The accumulated change is nevertheless not ready to
accept. Most importantly, all 28 wrappers launch the compiled executable without
removing `BUN_BE_BUN`; Bun 1.3.14 therefore ignores Hydra's bundled entry point
when that variable is inherited. I reproduced the hijack through a real wrapper.

The review also found a controlled-Bun-resolution escape, stale artifact and
manifest retention after matrix failures, a routes-drift false-pass, an invalid
`HYDRA_BIN` case that produces a raw Bash error instead of fallback, and changes
inside the nominally frozen Bash rollback lane.

## Real bugs found

### 1. Blocker: every `bin` wrapper inherits `BUN_BE_BUN`

- Location: all 28 wrapper preambles; for example
  `kit/hydra/scripts/status.sh:15`.
- The accepted plan requires `exec env -u BUN_BE_BUN "$HYDRA_BIN" ...`.
  The implemented line is `exec "$HYDRA_BIN_PATH" ...`, and `src/cli.ts`
  cannot delete the variable because Bun acts on it before the bundled program
  starts.
- Concrete reproduction, using a real Bun 1.3.14 build of `src/cli.ts`:

  ```text
  $ BUN_BE_BUN=1 HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli \
      bash kit/hydra/scripts/status.sh review-missing task
  error: Script not found "status"
  exit 1
  ```

  The clean invocation reaches Hydra and reports its expected missing task-spec
  error. The inherited-variable invocation instead enters Bun CLI mode. This is
  a runtime diversion of every wrapper command, not a cosmetic output change.

### 2. High: a relative `HYDRA_BUN` can escape controlled resolution to PATH

- Location: `kit/hydra-ts/scripts/build-matrix.ts:97-106` and `:173-177`.
- `resolveBun()` accepts `HYDRA_BUN` without requiring an absolute path. For a
  bare value such as `bun`, `existsSync("bun")` and the executable check inspect
  `./bun`, but `execFileSync("bun", ...)` resolves through `PATH`. The returned
  `bun.path` remains bare and is PATH-resolved again for the build.
- Concrete reproduction: in `/tmp`, I placed an executable `./bun` that is a
  Hydra compiled binary and whose `./bun --version` exits 1. With
  `HYDRA_BUN=bun` and `PATH=/Users/tommycheung/.bun/bin`, the matrix passed Bun
  resolution using the real PATH Bun and proceeded as far as `git rev-parse`
  (which then failed because the test PATH deliberately omitted Git). Thus the
  candidate that was existence-checked was not the executable that was run.
- `HYDRA_BUN` should be rejected unless absolute, or canonicalized to an
  absolute path before either execution. With no usable configured/home
  candidate, the current script does fail loudly and does not fall back to bare
  PATH; that separate case is solid.

### 3. High: failed matrix builds leave stale artifacts and manifests usable

- Location: `kit/hydra-ts/scripts/build-matrix.ts:163-188` and `:223-247`.
- A failed `execFileSync` returns `null` without removing an existing
  `dist/<target>/hydra-cli` or `dist/<target>/manifest.json`. When every selected
  target fails, `built.length` is zero and the previous `dist/manifest.json` is
  not rewritten or removed either.
- Concrete scenario: run a successful matrix for commit A, then run the same
  target at commit B when Bun's cross-runtime download is unavailable. The
  command exits non-zero and prints that the target is omitted, but the target
  directory still contains commit A's binary and per-target manifest. If all
  targets fail, the aggregate manifest from A also remains. A packaging step
  that gathers `dist/<target>` or reads an existing aggregate can publish stale
  commit-A output after a commit-B failure.
- Failed targets need their prior binary and per-target manifest removed before
  or on failure, and a run with zero successes must not leave an old aggregate
  looking current. An atomic temporary outfile would further avoid exposing a
  partially replaced artifact.

### 4. High: `routes-drift` can silently miss real routes

- Location: `kit/hydra-ts/scripts/blackbox-compiled.ts:216-220` and `:277-295`.
- The parser recognizes only single-quoted keys matching
  `/'([a-z0-9-]+)':/`. If all keys are reformatted to double quotes, parsing
  returns `null`; the harness treats that exactly like an absent source tree,
  prints a note, falls back to the embedded table, and can still exit zero. If
  one newly added route uses double quotes or an unquoted identifier while
  existing routes retain single quotes, the parser returns the old 34 names,
  `routes-drift` passes, and the new route is never smoke-tested.
- In-memory reproduction against the current `cli.ts`:

  ```json
  {"current_count":34,"all_double_quotes":null,
   "added_double_route_count":34,"added_route_seen":false}
  ```

- Reordering current keys is safe because both lists are sorted. Changing an
  existing single-quoted key alone generally creates a hard false-positive,
  but whole-object reformatting or a differently styled new key creates the
  worse false-pass described above. A source-present parse failure must be a
  hard failure; preferably derive the route list structurally rather than with
  this formatting-dependent regex.

### 5. Medium: `hydra_resolve_bin()` accepts directories and relative overrides

- Location: `kit/hydra/scripts/lib.sh:127-143`.
- The ordinary cases requested by the review are correct: both a missing path
  and an existing non-executable regular file fail `-x`, emit the warning, and
  fall back to TS. However, `-x` is true for a searchable directory. The helper
  also does not enforce the accepted plan's absolute-path requirement.
- Concrete reproductions:
  - `HYDRA_BIN=/tmp` passes resolution, then `status.sh:15` exits 126 with raw
    Bash messages (`/tmp: is a directory` and `cannot execute`) instead of the
    warning plus TS fallback.
  - `HYDRA_BIN=../../../../../tmp/hydra-review-0041-cli` is accepted and run,
    so an override can change meaning with the caller's cwd.
- Require a regular executable file and an absolute path before returning
  success. The warning should say "missing or not executable" rather than
  "not found" for an existing non-executable file.

### 6. Medium: the accumulated diff mutates the frozen Bash lane

- Locations: `kit/hydra/scripts/dispatch.sh:120,328,363`,
  `kit/hydra/scripts/review-dispatch.sh:109`, and the shared Bash helper message
  at `kit/hydra/scripts/lib.sh:151`.
- The actual diff shows 26 wrapper Bash bodies unchanged, but `dispatch.sh` and
  `review-dispatch.sh` changed `HYDRA_HERDR_PANES`'s default from `0` to `1`.
  `hydra_repo_root()` also changed its emitted error text for every Bash caller.
  These edits came from commits `1930ecb`/`d537090` in the reviewed range, not
  from the mechanical preamble commit, but the accumulated rollback lane is
  therefore not byte-identical to `f34de42`.
- Concrete scenario: with `HYDRA_HARNESS=bash`, `HYDRA_HERDR_PANES` unset, and
  live Herdr, `dispatch.sh` now uses `run_worker_in_herdr_pane()` and
  `review-dispatch.sh` now calls `launch_in_pane()`; at `f34de42` both ran the
  inline path. This changes process topology, output hosting, and timeout flow
  in the supposedly frozen emergency fallback.
- Either revert these changes from the frozen lane or explicitly revise the
  accepted freeze/rollback contract and test the new Bash behavior as a scoped
  change. It cannot currently be claimed byte-identical.

## Wrapper-by-wrapper diff review

I read the actual per-file diff for all 28 wrappers. Every wrapper has exactly
one `hydra_resolve_bin` call and exactly one `src/cli.ts` route; all 28 bin and TS
subcommand literals equal the wrapper basename. No wrapper retains a direct
`src/<name>.ts` launch. `cli.ts` forwards `argv.slice(1)` to the selected
`main(args)`, so wrapper arguments after the subcommand remain unchanged.

The following 11 were individually cross-checked against their exported
`main()` shape and their actual wrapper diff (more than the required eight):

| Wrapper | TypeScript main shape / public arguments | Diff result |
|---|---|---|
| `aggregate-usage.sh` | sync; zero arguments valid | correct `aggregate-usage` in bin and TS |
| `allocate.sh` | sync; role, task type, optional risk/exclusion | correct `allocate`; `"$@"` preserved |
| `cancel-task.sh` | async; two positionals plus optional wait flag | correct `cancel-task`; `"$@"` preserved |
| `dispatch.sh` | async; run, task, optional background | routing correct; Bash body changed as finding 6 |
| `freshness-gate.sh` | sync; run and task | standard preamble, correct name; no special-case breakage |
| `graph-impact.sh` | sync; run and task | correct `graph-impact`; `"$@"` preserved |
| `otel-env.sh` | sync; zero arguments | correct `otel-env`; `"$@"` preserved |
| `promote.sh` | async; three CLI arguments (plus injected options internally) | correct `promote`; `"$@"` preserved |
| `review-dispatch.sh` | sync; four positionals plus optional image | routing correct; Bash body changed as finding 6 |
| `status.sh` | sync; two positionals plus flags | correct `status`; `"$@"` preserved |
| `verify.sh` | async; two positionals plus optional output | correct `verify`; `"$@"` preserved |

The other 17 wrapper diffs have the same correct basename mapping. Aside from
findings 1, 5, and 6, the mechanical three-state routing is solid.

## Build and black-box checks found solid

- `kit/hydra-ts/package.json:13` contains both exact hardening flags,
  `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`; the entry is
  `src/cli.ts`, not `src/bin-cli.ts`. The outfile is `dist/hydra-cli`.
- `build-matrix.ts` uses those flags for every target, records SHA-256, size,
  source SHA, Bun version and target, omits failed targets from the newly
  generated aggregate, and exits non-zero when any requested build fails.
- With `HYDRA_BUN=/definitely/missing`, an unusable home, and a PATH containing
  no Bun, matrix resolution exited 1 with the intended controlled-location
  error. There is no implicit bare-PATH fallback when the candidates themselves
  are absolute; finding 2 is specifically the unvalidated relative override.
- `blackbox-compiled.ts` builds a new child environment rather than spreading
  `process.env`. `PATH` is an empty scratch directory, and `NODE_PATH`,
  `NODE_OPTIONS`, `BUN_BE_BUN`, `HYDRA_BIN`, `HYDRA_HARNESS`, API keys, and the
  host state roots are not inherited. The binary path is resolved to absolute
  before spawn. No host-PATH leak was found. A program with a deliberately
  hard-coded absolute host executable could bypass any PATH-only test, but the
  reviewed harness does not accidentally provide such a path.
- The lead's post-integration evidence is internally consistent: native Darwin
  arm64 and both Linux glibc architectures passed; Darwin x64's one exact-stderr
  failure under Rosetta is caused by Bun's pre-entry AVX warning. It remains a
  real-hardware coverage gap, not evidence of a Hydra routing defect.

## Verification performed

- Built the real router with Bun 1.3.14 to `/tmp/hydra-review-0041-cli` using
  both no-autoload flags: pass (46 modules, 63,759,842-byte arm64 executable).
- Ran `blackbox-compiled.ts` against that artifact: 45/45 pass, including the
  current-format `routes-drift` check, all smoke commands, cwd independence,
  unknown-subcommand, and ENOENT checks.
- Ran `otel-env.sh`, `status.sh review-missing task`, and
  `freshness-gate.sh review-missing task` under each of `HYDRA_HARNESS=bash`,
  `ts`, and `bin` (real compiled binary). For each invocation, all three lanes
  had identical exit code, stdout, and stderr: respectively exit 0, exit 1, and
  exit 1 with the expected output.
- Ran the inherited-`BUN_BE_BUN=1` wrapper reproduction: fail as finding 1.
- Ran missing, non-executable-file, directory, and relative `HYDRA_BIN` probes:
  the first two fell back correctly; directory and relative cases reproduced
  finding 5.
- Ran `bash -n` over all 29 shell files (28 wrappers plus `lib.sh`): 29/29 pass.
- Ran `cd kit/hydra-ts && npm test` with resolver-selected Node 24.16.0. The
  concurrent lane discovered 808 tests: 805 pass, 3 fail, 0 cancelled. The
  three failures are exactly the already documented macOS `ps`-visibility
  cases in `status.sh.test.ts`; no new failure name appeared. Because the
  package script uses `&&`, promotion did not run after that non-zero baseline
  lane. I ran `npm run test:promote` separately: 27/27 pass. This reproduces the
  established advisory baseline and provides no evidence of a new TypeScript
  semantic regression from this Bash/build-tooling lane.

## Required disposition

At minimum, acceptance requires fixing findings 1 through 5 and deciding the
frozen-lane contract in finding 6. Regression coverage should include the real
`BUN_BE_BUN=1` wrapper launch, relative and directory overrides for both Bun
resolvers, a successful-build-then-failed-build stale-artifact sequence, and
route declarations formatted without single-quoted keys.
