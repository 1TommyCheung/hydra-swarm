# Bun migration Stage 4 fixes: build/CI tooling

Run 0042, task `fix-build-tooling`. Fixes the three HIGH build-tooling bugs
from the adversarial Stage 4 review
(`docs/bun-migration-stage4-review-bash-build.md`, "Real bugs found" #2, #3,
#4). Files changed:

- `kit/hydra-ts/scripts/build-matrix.ts` — findings 2 and 3
- `kit/hydra-ts/scripts/blackbox-compiled.ts` — finding 4

No `src/` or `test/` files were touched.

## Finding 2 (HIGH): relative `HYDRA_BUN` escaped controlled resolution to PATH

### Bug

`resolveBun()` accepted `HYDRA_BUN` without requiring an absolute path. For a
bare value like `bun`, `existsSync("bun")` / `accessSync("bun", X_OK)`
existence-checked `./bun` relative to the caller's cwd, but
`execFileSync("bun", ...)` — both for the `--version` assertion and for the
actual build — resolved through `PATH`. The binary that was checked was not
necessarily the binary that ran, which is exactly the PATH-shadowing escape
the "pin/resolve/assert-version, invoke that absolute path" discipline in
`docs/bun-migration-plan-codex.md` exists to prevent.

### Reproduction (before fix)

Fixture (same shape as the review): cwd `/tmp/hydra-0042-f2` containing an
executable decoy `./bun` whose `--version` prints `9.9.9-DECOY`; a stub `git`
on PATH so the run proceeds past `rev-parse`; `HOME` pointed at an empty dir
so the `~/.bun/bin/bun` candidate is absent.

```text
$ cd /tmp/hydra-0042-f2 && env -i HYDRA_BUN=bun \
    PATH=/tmp/hydra-0042-f2/pathbin:/Users/tommycheung/.bun/bin \
    HOME=/tmp/hydra-0042-f2/nohome \
    node --experimental-strip-types .../scripts/build-matrix.ts \
    --targets=bun-darwin-arm64
build-matrix: bun 1.3.14 (bun), source aaaaaaaaaaaa, targets: bun-darwin-arm64
[build] bun-darwin-arm64 -> dist/bun-darwin-arm64/hydra-cli
 [118ms] compile  .../kit/hydra-ts/dist/bun-darwin-arm64/hydra-cli
[build] bun-darwin-arm64 ok: 63759842 bytes, sha256 65d26de0…
EXIT=0
```

The decoy `./bun` (version `9.9.9-DECOY`) is what got existence-checked, but
the recorded version is `1.3.14` — the PATH bun — and the build itself ran
via PATH resolution. The manifests then recorded the escape as provenance:

```json
"bun_version": "1.3.14",
"bun_path": "bun"
```

`bun_path: "bun"` is a bare, PATH-dependent string recorded as if it were a
pinned toolchain path.

### Fix

Reject, don't canonicalize. `resolveBun()` now dies loudly when `HYDRA_BUN`
is set but not absolute (`kit/hydra-ts/scripts/build-matrix.ts`):

```text
build-matrix: error: HYDRA_BUN must be an absolute path, got "bun". A
relative value is existence-checked against the caller's cwd but executed via
PATH resolution, so the binary that is checked is not necessarily the binary
that runs (PATH-shadowing escape).
```

Rationale for reject-over-canonicalize: a relative override is an operator
mistake, and silently resolving it against a cwd the operator may not have
meant hides that mistake; the script's existing error contract already tells
operators to "set HYDRA_BUN to an absolute path", so rejection is the
behavior the text always promised. The other candidate,
`join(homedir(), '.bun', 'bin', 'bun')`, is absolute by construction
(`homedir()` returns an absolute path), so after this change EVERY candidate
is absolute and the invariant holds structurally: the exact path string that
is existence-checked and version-asserted is the string `execFileSync`
invokes for the build, with no PATH-dependent resolution possible in between.

### Verification (after fix)

```text
HYDRA_BUN=bun            -> error above, exit 1 (before any execution)
HYDRA_BUN=../f2/bun      -> same error, exit 1
HYDRA_BUN=/tmp/.../bun   -> accepted; header shows "bun 9.9.9-DECOY
                            (/tmp/.../bun)" — the checked binary IS the
                            executed binary (decoy's own version string)
HYDRA_BUN unset, home candidate absent, PATH has no bun
                         -> the original controlled-location error, exit 1;
                            still no bare-PATH fallback
```

## Finding 3 (HIGH): failed matrix builds left stale artifacts and manifests usable

### Bug

A failed build returned `null` without removing an existing
`dist/<target>/hydra-cli` or `dist/<target>/manifest.json`, and when every
requested target failed, the aggregate `dist/manifest.json` was not rewritten
or removed either. A packaging step reading `dist/` after a failed run could
silently ship the previous run's binaries.

### Reproduction (before fix)

Deterministic stub `bun` (handles `--version`; writes `STUB-BINARY-<tag>` to
`--outfile` on build; exits 1 when `STUB_FAIL=1`):

```text
RUN A: HYDRA_BUN=/tmp/.../bun STUB_TAG=A build-matrix --targets=bun-darwin-arm64
       exit 0; dist/ = {bun-darwin-arm64/hydra-cli (=STUB-BINARY-A),
                        bun-darwin-arm64/manifest.json, manifest.json}
RUN B: same but STUB_TAG=B STUB_FAIL=1
       exit 1, prints "omitted from the manifest" and
       "manifests: 0 per-target + 0 aggregate under dist/"
       BUT dist/ afterwards = {bun-darwin-arm64/hydra-cli (=STUB-BINARY-A),
                               bun-darwin-arm64/manifest.json, manifest.json}
       — commit-A artifacts all still present and indistinguishable from a
       fresh run; the "0 aggregate" summary line was literally false.
```

### Fix

Three parts (`kit/hydra-ts/scripts/build-matrix.ts`):

1. **Remove-before-build**: at the start of each target's build, any
   prior-run `dist/<target>/hydra-cli` and `dist/<target>/manifest.json` are
   deleted, so a failure can never leave an old artifact looking like a
   product of this run. A failed target's directory is left empty (no
   failure-marker file — absence is the marker, and it cannot be mistaken
   for a shippable artifact by a packaging glob).
2. **Temp + atomic rename**: the binary is built to
   `dist/<target>/hydra-cli.tmp-<pid>` and `renameSync()`ed onto the final
   path only after a successful, non-empty build (partial output from a
   failed bun invocation is removed). Per-target and aggregate manifests are
   written the same way (`writeFileAtomic`). This was the review's optional
   suggestion and is a clean fit: bun controls how it writes the outfile, so
   only a rename guarantees the final path never appears partial; it also
   makes the killed-mid-build case leave either the old artifact or the new
   one, never a stub.
3. **Zero-success aggregate handling**: the aggregate `dist/manifest.json`
   continues to be written from THIS run's successes only (verified: it is
   built from the `built` array, which failed targets never enter). When zero
   targets succeed, any prior-run aggregate is now REMOVED with a stderr
   warning, rather than renamed `.stale` or left in place — removal gives a
   packaging step a loud ENOENT, while a `.stale` file could still be picked
   up by a naive `dist/**` glob and a left-in-place file is the original bug.

### Verification (after fix)

Zero-success sequence (same stub, tag A then forced-fail tag B):

```text
RUN B exit 1; stderr adds:
  build-matrix: warning: all targets failed; removed stale prior-run
  dist/manifest.json so it cannot be packaged as if it were a product of
  this run
dist/ afterwards: only the empty directory dist/bun-darwin-arm64/
  — no binary, no per-target manifest, no aggregate. Nothing stale.
```

Partial-failure sequence (`--targets=bun-darwin-arm64,bun-linux-x64`, stub
fails only `bun-linux-x64`, tag A run then tag B run):

```text
RUN B exit 1; summary: OK bun-darwin-arm64 / FAIL bun-linux-x64
dist/ = {bun-darwin-arm64/hydra-cli (=STUB-BINARY-B, freshly rebuilt),
         bun-darwin-arm64/manifest.json, manifest.json}
dist/bun-linux-x64/ is EMPTY (its tag-A binary+manifest were removed)
aggregate manifest.json lists ONLY bun-darwin-arm64 from this run
no *.tmp-* files left anywhere under dist/
```

Real-toolchain sanity: a native `bun-darwin-arm64` build with the real Bun
1.3.14 via default home-candidate resolution succeeds end to end (the bun
compile log shows it writing the `.tmp-<pid>` path, published by rename), and
the produced binary passes the full black-box suite (below).

## Finding 4 (HIGH): `routes-drift` could silently miss real routes

### Bug

The parser in `blackbox-compiled.ts` recognized only single-quoted keys
(`/'([a-z0-9-]+)':/`) and returned `null` both for "source tree absent" and
for "parse failure"; the harness treated both as graceful degradation to the
embedded expectation table. Two failure modes, both reproduced before the fix
with the ACTUAL extracted `readRoutesFromSource()` run in-memory against
fixture texts (the review's technique), plus end-to-end harness runs of a
fixture tree (copied script + fixture `src/cli.ts` + a fake binary):

```json
{"real": {"count": 34},
 "all_double": null,
 "added_double_route": {"count": 34, "has_zeta": false},
 "all_unquoted": null,
 "no_routes_object": null}
```

- `all_double` (all keys reformatted to double quotes): harness printed the
  "src/cli.ts not reachable" note — false, the source was present — and ran
  NO drift check at all.
- `added_double_route` (34 single-quoted keys + one double-quoted new route):
  harness printed `PASS routes-drift — table matches all 34 routes in
  src/cli.ts` while the fixture source had 35 routes — a false PASS, and the
  new route was never smoke-tested.

### Fix

Two parts (`kit/hydra-ts/scripts/blackbox-compiled.ts`):

1. **Source-present anomalies are hard FAILs.** `readRoutesFromSource()` now
   returns `null` ONLY when `src/cli.ts` does not exist. An unreadable file,
   a missing routes-object literal, an unrecognized line inside the object,
   or zero parsed keys all throw, and `main()` records `routes-drift` as a
   hard FAIL with a "refusing to fall back to the embedded expectation table
   while the source tree is present" message. The embedded-table fallback
   with its explanatory note is preserved, but is now strictly conditional on
   source ABSENCE (the Stage 3 Docker binary-only-container scenario).
2. **Structurally robust parsing.** cli.ts's routes object is flat, one
   route per line, so the object body is parsed line by line: every
   non-blank, non-comment line inside the object must match
   `/^\s*['"]?([a-z0-9-]+)['"]?\s*:/` — single-quoted, double-quoted, and
   unquoted identifier keys all parse — and any line that does not match (a
   new formatting style, a computed key, a multi-line value) is a loud parse
   error rather than a silent skip. This is deliberately stricter than a
   "match what you can" regex: with a match-what-you-can parser, a route
   whose key uses some FOURTH style would parse as absent, compare clean
   old-vs-old, and escape smoke-testing — the exact false-PASS this finding
   is about. With the line guard, a route can only escape the parser by
   failing the whole check loudly first.

Note on count drift: a parse that yields a different route COUNT than the
expectation table is already a hard FAIL through the existing
missing/extra name-set comparison (route names are unique keys, so a count
difference necessarily produces a missing or extra name); the name-set check
subsumes the count check.

### Verification (after fix)

Same in-memory probe against the fixed parser:

```json
{"real": {"count": 34},
 "all_double": {"count": 34},
 "added_double_route": {"count": 35, "has_zeta": true},
 "all_unquoted": {"count": 34},
 "no_routes_object": {"threw": "could not locate the routes object literal in src/cli.ts"}}
```

End-to-end harness runs (fixture tree, fixed script):

```text
real cli.ts content      -> PASS routes-drift — table matches all 34 routes
all_double               -> PASS routes-drift (all 34 parse; reformatting
                            alone is correctly NOT a failure — routes match)
added_double_route       -> FAIL routes-drift — expectation table does not
                            match src/cli.ts routes (missing from table:
                            [zeta-new-route], not routed: [])
no_routes_object         -> FAIL routes-drift — src/cli.ts IS present but
                            its routes could not be parsed: could not locate
                            the routes object literal ... refusing to fall
                            back to the embedded expectation table
src/cli.ts absent        -> note: src/cli.ts not reachable ... using the
                            embedded expectation table (fallback preserved)
```

## Testing convention note

`kit/hydra-ts/test/` covers `src/` modules only; nothing tests `scripts/`
(verified by inspection: no test file references `build-matrix` or
`blackbox-compiled`, and `tsconfig.json` includes only `src/**` and
`test/**`). The task also made `test/` read-only, so per the task spec the
fixes above are covered by the comment-documented manual verification
transcripts in this doc instead of new unit tests.

## Full verification performed

- Full `kit/hydra-ts` suite, before and after the fix, identical results:
  `npm run test:concurrent` 808 tests / 805 pass / 3 fail; the 3 failures are
  exactly the documented macOS `ps`-visibility cases in `status.sh.test.ts`
  ("does not report disagreement ... live validated dispatch process",
  "reports disagreement ... wrong run/task", "reports disagreement ... killed
  while queued"); `npm run test:promote` 27/27 pass. Zero regressions.
  - Environment caveat: this sandbox denies creating nested `.git`
    directories inside the worktree (`git init` under `test/tmp-*` fails
    EPERM), so in-worktree the suite cannot build its fixtures. Both runs
    were therefore executed in an exact replica of the worktree at
    `/tmp/hydra-0042-repo` (full rsync minus `.git`/`dist`/`node_modules`,
    `git init` + one baseline commit; the after-run had the two fixed scripts
    copied in). The replica's pre-fix results matched the run-0041 review's
    recorded baseline exactly (805/808 + 27/27), validating the technique.
- Real Bun 1.3.14 native build via the fixed `build-matrix.ts`
  (`--targets=bun-darwin-arm64`, default `~/.bun/bin/bun` resolution): exit 0,
  63,759,842-byte binary.
- Full black-box suite via the fixed `blackbox-compiled.ts` against that
  binary: **45/45 checks passed**, including the normal-path
  `PASS routes-drift — table matches all 34 routes in src/cli.ts`.
- All three findings reproduced before the fix and re-run after the fix, as
  transcribed above.
