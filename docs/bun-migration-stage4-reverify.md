# Bun migration Stage 4 — re-verification of the three fix lanes

Run 0043, task `reverify-fixes`, branch `hydra/0043/reverify-fixes`
(base `ad6ab52490e5c2700280f2e4550d9f47b3ec3ee4`).

This is the second (independent) adversarial pass over the Stage 4 Bun
single-binary migration. Round 1 (run 0041) issued two REJECT verdicts covering
eight real findings. Three fix lanes (run 0042, all squashed into this branch:
`198b59a` compiled-dispatch, `8f09846` bash-wrapper-hijack, `ad6ab52`
build-tooling) claim to close all eight plus the finding-6 documentation
clarification. This run does NOT re-litigate round 1 — it verifies each
specific fix actually closes its gap and hunts for anything new the fixes
themselves introduced.

## Verdict: ACCEPT for cutover consideration

All eight original findings are **confirmed fixed**. Every fix was exercised
against the real merged code, and — unlike the three fix lanes, which had no
`bun` and could not build binaries — this sandbox had **Bun 1.3.14**, so I
built a real 63,759,842-byte arm64 `hydra-cli`, reproduced every
round-1 scenario against it, ran the previously-deferred compiled-binary
end-to-end dispatch test (it ran, not skipped, and passed), and ran the full
black-box suite against the real binary. The full `kit/hydra-ts` suite is
green: **847 test executions, 0 failures**.

No new issue introduced by the fixes warrants blocking cutover. One benign
edge case (`hydra_resolve_bin` trailing-slash) and one process/doc-provenance
note (below) are recorded as non-blocking follow-ups.

## Environment (stronger than the fix lanes' sandboxes)

- Machine default `node` is v22.14.0 on PATH (`which node`), and v24.16.0 is
  also installed under nvm. No nvm dance was needed.
- **`bun` 1.3.14 is available at `~/.bun/bin/bun`** — the fix lanes
  (runtime + build lanes) explicitly could NOT build binaries and had to defer
  the compiled-binary evidence. I could, and did.
- The documented in-worktree `.git`-write EPERM that produced the fix lanes'
  72 environmental failures **does not reproduce on this host** (macOS
  26.5.2); `git init` under the worktree works, so every git-fixture test
  runs to completion here.
- `tsc` is still NOT installed (`kit/hydra-ts/node_modules/.bin/tsc` absent),
  so `npm run typecheck` cannot run — consistent with the fix lanes; not
  faked.

## Process / provenance note (non-blocking)

The task spec states both round-1 reviews
(`docs/bun-migration-stage4-review-runtime.md` and
`docs/bun-migration-stage4-review-bash-build.md`) were "merged to master".
They are **not**:

- Neither file exists in `master`, in this branch's base (`ad6ab52`), or in
  any branch head (`git for-each-ref` / `git ls-tree -r` over every ref finds
  no `stage4-review*` path).
- The **runtime** review survives only as a dangling/unreachable commit
  (`4ea9cd9`, not reachable from any ref): recovered via
  `git show 4ea9cd9:docs/bun-migration-stage4-review-runtime.md` and read in
  full. Its three findings match the task spec and the runtime fix lane's
  before/after evidence.
- The **bash-build** review is absent from the entire object database — no
  ref, no reachable commit, no dangling/unreachable object contains it
  (`git fsck --unreachable` probe + every-ref `ls-tree` both empty). Its five
  findings were therefore reconstructed from the task spec's enumeration and
  the bash/build fix lanes' self-reported before/after evidence.

The runtime fix lane already flagged this mismatch (lines 9-15 of
`docs/bun-migration-stage4-fixes-runtime.md`). It does not weaken this
verification: all eight findings are independently verifiable from the code,
the three fix docs describe each before/after concretely, and I confirmed
each against the actual merged source plus real-binary reproductions. But the
"merged to master" claim is inaccurate and the bash-build review's
provenance cannot be confirmed from the repo — recorded so the lead can
re-attach or re-publish both review docs if the audit trail matters.

## Per-finding verdicts

### Finding 1 (runtime, HIGH, was the merge blocker): compiled `dispatch` can now launch an adapter — CONFIRMED FIXED

`kit/hydra-ts/src/dispatch.ts`.

- **Selection (`resolveAdapterRuntime`, dispatch.ts:119-127):** precedence is
  `explicit 'bash' override` > `explicit 'compiled' override OR real compiled
  binary` > legacy mapping. Traced every combination: with `compiled=true`,
  `HYDRA_HARNESS=bin` → `'compiled'` (not `'ts'`); `HYDRA_ADAPTER_RUNTIME=ts`
  → `'compiled'` (a compiled binary physically cannot run the `'ts'` path);
  only an explicit `HYDRA_ADAPTER_RUNTIME=bash` forces `'bash'`. The broken
  `'ts'` path is unreachable from a real compiled binary. Wired at
  dispatch.ts:1137-1141 with `isCompiledBinary()`.
- **Self-reexec argv contract — traced both sides AND proven by a real
  binary.** `runWorkerPlain` (dispatch.ts:819-828) spawns
  `[process.execPath, 'adapter-<vendor>', verb, taskSpec, worktree, inbox,
  sessions, agentRunId, priorSession]`. Receiving side: `cli.ts:172`
  `route(process.argv.slice(2))`; inside a `bun build --compile` binary
  `process.argv = [execPath, <virtual-entry>, ...userArgs]` (the convention
  Stage 0's `bin-cli.ts` already relies on — `subcommand = process.argv[2]`,
  `selfReexec([...])`), so `slice(2)` yields
  `['adapter-<vendor>', verb, ...]`, `route` does `fn(argv.slice(1))`, and the
  adapter `main(args)` receives `[verb, taskSpec, worktree, inbox, sessions,
  agentRunId, priorSession]` — exactly the sequence
  `adapter-stub.ts:14`/`adapter-claude.ts:213-215` document. The 7-element
  verb-first order matches on both ends.
- **Empirical proof (the deferred test, now run):** built `dist/hydra-cli`
  with `bun build --compile` (63,759,842 bytes, matches the matrix size).
  `test/dispatch.test.ts:628-700` (the compiled-binary e2e fixture the
  runtime lane had to leave as SKIP) **ran and passed**: `HYDRA_HARNESS=bin
  <binary> dispatch <run> <task>` (vendor stub, herdr absent → plain
  self-reexec path) → exit 0, agent-run id on stdout, ledger
  `agent_exited exit_code 0`, and `result.json` drop `vendor:stub,
  status:completed`. The self-reexec reaches adapter-stub end-to-end.
- **Both spawn paths:** `runWorkerPlain` (dispatch.ts:819-828) AND
  `runWorkerInHerdrPane` (dispatch.ts:940-944) both carry the `'compiled'`
  branch (`[process.execPath, 'adapter-<vendor>']`); the Herdr unit test
  (dispatch.test.ts:600-607) asserts the pane command contains
  `'<self>' 'adapter-claude' 'start'` and never `--experimental-strip-types`.
- **`COMPILED_ADAPTERS` (dispatch.ts:98-105) consistency** — spot-checked all
  five against the real verb parsers: claude `start|resume` (✓ resume:true),
  stub `start|resume` (✓ resume:true), codex `only 'start'`
  (adapter-codex.ts:367, ✓ resume:false), kimi `start`+`visual` no resume
  (adapter-kimi.ts:663-672, ✓ resume:false), opencode
  `start`/`explore`/`review` no resume (adapter-opencode.ts:615-636,
  ✓ resume:false). 1:1 with cli.ts's `adapter-<vendor>` routes
  (cli.ts:68-72). `determineDelivery` (dispatch.ts:548-551) takes resume from
  this registry for the compiled runtime, with no source-file probe.
- Vendor gate (dispatch.ts:1152-1161): unknown vendor dies with no file
  probe, naming exactly the five routed adapters.

### Finding 2 (runtime, MEDIUM): `herdr-push.ts` `BUN_BE_BUN` strip — CONFIRMED FIXED

`kit/hydra-ts/src/herdr-push.ts:60-77`. `execFileSync` is now called in
exactly ONE place — `defaultExec` — which forces
`env: { ...process.env, ...options?.env, BUN_BE_BUN: undefined }`. Grep
confirms every herdr call site (status :221, pane list :252, pane rename
:276, notification :298, agent list :320) plus the git call (:242) routes
through `exec` (herdr-push.ts:194 `options.exec ?? defaultExec`); there is no
raw `execFileSync` bypass anywhere in the file. One chokepoint covers all the
round-1 sites. The real-runner test (herdr-push.test.ts) drives a stub herdr
recording `BUN_BE_BUN` observability per call with the parent env deliberately
poisoned `BUN_BE_BUN=1`; all five sites fire and every child sees it absent
(passed in the focused run).

### Finding 3 (runtime, LOW): `isCompiledBinary()` false positive — CONFIRMED FIXED (and no new false negative)

`kit/hydra-ts/src/kit-assets.ts:51-56`: now requires BOTH
`url.startsWith('file:///$bunfs/')` AND `typeof versions.bun === 'string'`.

- **Collision eliminated:** plain Node at a `/$bunfs/...` checkout produces
  the URL prefix but not `versions.bun` → `false`. Verified by unit test
  (kit-assets.test.ts) and by the empirical probe below.
- **No new false negative — proven with a real compiled binary.** Built a
  tiny probe binary; inside it
  `import.meta.url = file:///$bunfs/root/probe-bin`,
  `typeof process.versions.bun = 'string'` (value `"1.3.14"`), so the detector
  returns `true`. Under `bun` source (non-compiled) the URL is an ordinary
  `file:///...` so it returns `false`; under `node` source `versions.bun` is
  `undefined` so it returns `false`. `process.versions.bun` is Bun's own
  documented discriminator and is present in a real 1.3.14 compiled binary,
  so a genuine compiled binary cannot fail the check.

### Finding 4 (bash, BLOCKER): `BUN_BE_BUN` wrapper hijack — CONFIRMED FIXED (all 28, individually)

Every one of the 28 `kit/hydra/scripts/*.sh` wrappers (excluding `lib.sh`)
was checked individually, not sampled. Each has exactly one
`exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" <name> "$@"` line, **zero** bare
`exec "$HYDRA_BIN_PATH"` lines, and its `ts`-mode exec line untouched:

```
aggregate-usage.sh  allocate.sh  amend-task.sh  audit-ownership.sh
cancel-task.sh  code-intel.sh  create-worktree.sh  dispatch.sh
freshness-gate.sh  graph-impact.sh  graphify-baseline.sh
graphify-investigate.sh  graphify-repo.sh  herdr-push.sh
index-candidate.sh  integrate.sh  ledger-view.sh  measure-divergence.sh
otel-env.sh  promote.sh  record-review.sh  record-usage.sh
review-dispatch.sh  review-required.sh  run-init.sh  squash.sh
status.sh  verify.sh
```

**Reproduced round-1's exact scenario against a freshly built binary:**
control `HYDRA_HARNESS=bin HYDRA_BIN=<abs> status.sh …` reaches Hydra
(`instantiated task spec not found` — Hydra's own error); the hijack attempt
`BUN_BE_BUN=1 HYDRA_HARNESS=bin HYDRA_BIN=<abs> status.sh …` reaches Hydra
**identically** (no `error: Script not found "status"`). `otel-env.sh` exits
0 both clean and with `BUN_BE_BUN=1`. Confirmed that the raw unstripped
binary DOES still hijack (`env BUN_BE_BUN=1 <binary> status` →
`error: Script not found "status"`), so the fix — not luck — is what
prevents it.

### Finding 5 (build, HIGH): `HYDRA_BUN` PATH escape — CONFIRMED FIXED

`kit/hydra-ts/scripts/build-matrix.ts:116-153`. `resolveBun()` now `die`s
when `HYDRA_BUN` is set but not `isAbsolute()`. The only other candidate,
`join(homedir(), '.bun', 'bin', 'bun')`, is absolute by construction, so
**every** candidate is absolute: the path string existence/version-checked
is exactly the string `execFileSync` invokes for the build. Reproduced with a
stub `bun` + decoy: relative `HYDRA_BUN=bun` → loud error, no build;
absolute `HYDRA_BUN=/tmp/.../absbun` with a `7.7.7-DECOY` version → accepted
and the header/manifest record the **decoy's own** version, proving
checked==executed. No other Bun-candidate resolution path exists in the file
(`git rev-parse` is git, not bun; the build uses `bun.path`).

### Finding 6 (build, HIGH): stale artifact retention — CONFIRMED FIXED (reproduced with a stub)

`build-matrix.ts`: per target, `rmSync` of prior `dist/<t>/hydra-cli` +
`manifest.json` + leftover `.tmp-<pid>` before building
(build-matrix.ts:216-218); build into `hydra-cli.tmp-<pid>` then
`renameSync` only on success (249); partial output dropped on failure (236);
aggregate `dist/manifest.json` written from this run's `built` array only,
and a zero-success run removes any prior aggregate with a loud warning
(302-311). Reproduced round-1's scenario: RUN A (stub tag A, success) leaves
`STUB-BINARY-A` + per-target manifest + aggregate; RUN B (tag B, forced
`STUB_FAIL=1`) → binary `NONE`, per-target manifest gone, aggregate gone,
warning printed, `manifests: 0 per-target + 0 aggregate`. No
misleadingly-current stale artifact survives; no `.tmp-*` left behind. (The
empty `dist/<target>/` directory is left intentionally — it cannot be matched
by a packaging `**/hydra-cli` glob, so it is not a shippable-looking
artifact.)

### Finding 7 (build, HIGH): `routes-drift` false-pass — CONFIRMED FIXED (incl. new adversarial cases)

`kit/hydra-ts/scripts/blackbox-compiled.ts:239-259,315-347`.
`readRoutesFromSource()` returns `null` **only** on genuine source absence
(`!existsSync(SRC_CLI)`). Any anomaly while the source is present — missing
routes-object block, an unrecognized line, zero keys — throws, and `main()`
records `routes-drift` as a hard FAIL "refusing to fall back to the embedded
expectation table." The line regex
`/^\s*['"]?([a-z0-9-]+)['"]?\s*:/` accepts single/double/unquoted keys and
rejects anything else inside the block. In-memory probe of the parser:

| fixture | result |
|---|---|
| real single-quoted | count=4 ✓ |
| all_double | count=4 ✓ (reformatting alone is NOT a fail) |
| added_double_route (zeta) | count=5 ✓ (new route detected → hard FAIL via missing-from-table) |
| all_unquoted | count=4 ✓ |
| empty body | THROW `no route keys parsed` ✓ |
| **NEW** computed/spread `...otherRoutes,` | THROW `unrecognized line` ✓ |
| **NEW** underscore key `foo_bar:` | THROW `unrecognized line` ✓ |
| **NEW** multi-line orphan `orphanToken,` | THROW `unrecognized line` ✓ |

End-to-end: full black-box suite against the real binary →
`PASS routes-drift — table matches all 34 routes in src/cli.ts`,
**45/45 checks passed**. Source-absent fallback (Stage 3 Docker) is preserved
as a `note:` with no drift detection.

### Finding 8 (bash, MEDIUM): `hydra_resolve_bin()` hardening — CONFIRMED FIXED

`kit/hydra/scripts/lib.sh:124-158`. New `_hydra_bin_is_usable()` (absolute
via `case /*`, then `[ -f ] && [ -x ]`) is applied to BOTH the `HYDRA_BIN`
override branch (143) and the default-candidate branch (152). Reproduced all
four round-1 cases plus extras against the real binary — each now warns
`… is missing, not a regular file, or not executable, falling back to ts`
then reaches Hydra's normal error (never the old exit-126 raw crash):

| `HYDRA_BIN` | before | after |
|---|---|---|
| directory `/tmp/.../adir` | exit 126 crash | warn + ts fallback ✓ |
| relative `../../tmp/.../hydra-cli` | accepted & run | warn + ts fallback ✓ |
| non-executable regular file | (new) | warn + ts fallback ✓ |
| missing | warn + fallback | warn + ts fallback ✓ |
| symlink → directory | (new) | warn + ts fallback ✓ (−f follows to dir → false) |
| absolute regular executable | runs | runs ✓ (positive regression) |
| symlink → real binary | (new) | runs ✓ (correct) |
| trailing slash `hydra-cli/` | (new) | warn + ts fallback (benign — see below) |

**Non-blocking edge (not flagged as a defect):** a trailing slash on an
otherwise-valid absolute binary path (`HYDRA_BIN=/path/hydra-cli/`) is
rejected, because bash `[ -f ]` treats a trailing slash as directory-only.
This is a cosmetic false negative: it requires an unusual operator input,
the fallback to the `ts` lane is safe (no crash), and the warning text is
clear. Not worth blocking cutover; noted only for completeness.

## Independent full test-suite run (this sandbox)

Node v22.14.0, `kit/hydra-ts`, real `dist/hydra-cli` present (so the
compiled-binary e2e fixture executes instead of skipping):

| Lane | Command (this run) | Result |
|---|---|---|
| concurrent | `node --experimental-strip-types --test $(find test -name '*.test.ts' ! -name promote.test.ts)` | **820 tests / 820 pass / 0 fail / 0 skipped** |
| promote | `node --experimental-strip-types --test test/promote.test.ts` | **27 tests / 27 pass / 0 fail** |
| black-box | `node --experimental-strip-types scripts/blackbox-compiled.ts dist/hydra-cli` | **45/45 checks passed** |

Total **847 test executions, 0 failures.** This is strictly stronger than the
fix lanes' evidence: they recorded 72 in-worktree `.git`-write EPERM failures
and a skipped compiled-binary e2e fixture; on this host neither applies, so
every test — including the previously-deferred compiled dispatch e2e — runs
and passes. `npm run typecheck` remains unavailable (`tsc` not installed),
unchanged from the fix lanes.

## New issues introduced by the fixes

None that block cutover. The only artifact is the benign trailing-slash
false-negative in finding 8 (safe `ts` fallback, clear warning). All eight
fixes are tight: no regression in the full suite, no new false-pass path in
the routes parser, no new false negative in the compiled-binary detector
(proven with a real binary), and the `HYDRA_ADAPTER_RUNTIME=ts`-under-compiled-binary
silent upgrade to `'compiled'` is the intended, documented behavior (the `ts`
path is physically impossible inside a compiled binary).

## Conclusion

All eight round-1 findings are genuinely closed, verified against the real
merged code and a real compiled binary. The Stage 4 Bun single-binary
migration's blocker (compiled dispatch) is resolved end-to-end. Recommend
**accept for cutover consideration**. The only follow-ups are cosmetic /
process-level: the trailing-slash `hydra_resolve_bin` edge, and re-attaching
the two round-1 review docs to the audit trail (or correcting the "merged to
master" claim) so future reviewers can find the baseline.
