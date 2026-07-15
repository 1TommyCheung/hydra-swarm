# Bun migration testing spike — results (items #9, #10, #11, #13)

Ran 2026-07-15 on branch `hydra/0035/bun-spike-testing` (base
`7eaf9b4602e3e29b77adc5f9a342e03dd286703e`), covering spike items #9, #10, #11
and #13 from `docs/bun-migration-plan-codex.md` ("Needs a `bun build --compile`
spike to verify"). Environment: macOS arm64, Bun `1.3.14`
(`~/.bun/bin/bun`, not on default PATH), Node `v24.16.0` and `v22.14.0` (nvm;
the default `/usr/local/bin/node` is v17.4.0 — the PATH-shadowing problem from
`skills/hydra-swarm/references/ts-bash-switch.md:31` is alive on this machine).

All scratch artifacts (probe sources, compiled binaries, armed fixture
directories) were kept under `/tmp/bun-spike-0035/` so the repository stayed
read-only outside this document.

## Environment caveats that shape the numbers (read first)

This sandbox denies three things the test suite depends on, and they explain
almost all baseline redness in BOTH runtimes (verified identical signatures
under Node 24.16.0 and Node 22.14.0, so not a version fluke):

- **`git init` inside the worktree fails with EPERM.** Template-hook copy and
  `.git/config` creation are blocked ("Operation not permitted") anywhere under
  `/Users/tommycheung/worktrees/...`; `git init` in `/tmp` works fine. Every
  test that builds a fixture git repo under `kit/hydra-ts/test/tmp-*` fails at
  setup (~90 tests across adapter-claude, adapter-kimi, audit-ownership,
  integrate, index-candidate, squash, freshness-gate, lib, promote).
- **`ps`/`top`/`/usr/bin/time -l` are blocked** ("Operation not permitted"),
  which fails the 3 `status.sh.test.ts` process-visibility tests (the same 3
  the plan's advisory run recorded) and forced the RSS methodology in item #13.
- **Writing `.bash_profile` fixtures fails with EPERM**, failing 2
  review-dispatch tests (`records 127 when the vendor executable is missing`,
  `runs the CLI entry point through a login shell`) under BOTH runtimes.

Also: `~/.config/herdr/herdr.sock` exists but has no healthy listener
(connects fail), which matters for item #9's runner-gap analysis.

Because of this, Bun attribution below is done by **same-environment
differential** (what fails under Bun but not under Node, and vice versa),
which is cleaner than comparing against the plan's older 673-test advisory.

## Item #9 — the test suite under `bun test`

### Commands and headline output

Baseline (Node 24.16.0, the repo's split npm scripts):

```
$ PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" npm run test:concurrent
ℹ tests 706     ℹ suites 88     ℹ pass 631     ℹ fail 72
ℹ cancelled 3   ℹ skipped 0     ℹ duration_ms 13921.39
$ npm run test:promote
ℹ tests 27      ℹ suites 1      ℹ pass 2       ℹ fail 25
```

Node 22.14.0 concurrent re-run (TAP reporter): identical `# tests 706 /
# pass 631 / # fail 72 / # cancelled 3`.

Bun (whole suite in one shot, as `bun test` discovers all 41 files):

```
$ cd kit/hydra-ts
$ PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" \
    bun test --timeout 30000
 630 pass
 105 fail
 1 error
Ran 735 tests across 41 files. [31.88s]   (exit code 1)
```

### Discovery and counting

- `bun test` **does discover and run all 41 `*.test.ts` files**, including the
  `node:test`-based ones: `describe`/`it`/`before`/`after`/`afterEach` imports
  from `node:test` are mapped to Bun's runner and execute. 735 tests ran, so
  nothing was silently undiscovered.
- Node discovers 733 (706 + 27). The +2 delta under Bun is fully explained by
  `test/bin-cli.test.ts`: without `bun` on PATH (Node baseline) it registers 1
  placeholder skip test; under `bun test` it registers the 3 real compiled-
  binary tests (which **passed** — the Stage 0 binary builds and self-re-execs
  under the Bun lane). 733 − 1 + 3 = 735.
- Accounting differences: Node reports a failing `before` hook as 1 hook
  failure + 3 "cancelled" subtests (`lib.test.ts` deriveDropFromGit); Bun
  reports it as 1 test fail + 1 separate "error". Same root cause (git EPERM),
  different ledger shape.

### Failure classification (the part that matters)

**Shared failures — environmental, NOT Bun-attributable (97 under Node,
same ~97 signature under Bun):** git-init EPERM fixture failures (~90), 2
`.bash_profile` EPERM, 3 `ps`-visibility, and the lib hook error/cancellations.

**Bun-only failures: 8 instances (7 distinct tests), split as follows.**

*Genuine Bun runtime incompatibilities (same code, different behavior) — 3:*

1. **`spawnSync` ENOENT result shape.** `defaultExec > returns 127 when the
   executable is missing` (`test/review-dispatch.test.ts:1065`) passes under
   Node, fails under Bun. Node returns `status: null` + `error.code: ENOENT`;
   Bun omits `status` entirely (`undefined`) with `error.code: ENOENT`.
   `src/review-dispatch.ts:76` does `if (result.status !== null)`, which is
   true for `undefined`, so the compiled binary would compute
   `exitCode = undefined` instead of 127 for a missing vendor CLI — silently
   corrupt exit codes, not just a test nit. Micro-probe (both runtimes, same
   script): Node `{"status":null,"signal":null,"error_code":"ENOENT"}` vs Bun
   `{"signal":null,"error_code":"ENOENT"}` (no `status` key).
2. **`fs` error-code mapping: bogus `EFAULT`.** `dispatch Bash parity > async
   foundation > cleans up the temp file when atomic write fails to rename`
   (`test/dispatch.test.ts:1179`) expects a rejection matching
   `/cross-device|ENOTEMPTY|EISDIR|ENAMETOOLONG/i`. Micro-probe:
   `rmSync(dirPath, {force:true})` on an existing directory throws
   `ERR_FS_EISDIR` under Node but **`EFAULT` ("bad address in system call
   argument", errno −14)** under Bun — a wrong error code that escapes the
   regex. (`renameSync(file, existingDir)` → `EISDIR` under both; that part is
   compatible.)
3. **In-process `process.env` mutations are not inherited by spawned
   children.** `auditOwnership > throws when the worktree is not a git
   repository` sets `process.env.GIT_CEILING_DIRECTORIES` then expects
   `git rev-parse` to stop discovering the parent repo. Under Bun the spawn
   sees the **launch-time OS environ**, not later JS-side mutations, so the
   ceiling never reaches git and the expected throw never happens.
   Micro-probe (`sh -c 'echo $VAR'` after `process.env.VAR=...`):
   Node `"mutated-after-start"`, Bun `""`; and a delete is equally invisible
   (Bun child still sees the launch-time value). Explicit
   `env: {...process.env}` **does** work under Bun.

*Bun test-runner gaps (runner behavior, not runtime semantics) — 4:*

4. The four review-dispatch progress-tail tests (`live-tails codex/kimi
   progress events...`, `does not create a live progress tail for claude/
   opencode reviewer panes`) fail only under `bun test`, with
   `error: connect ENOENT ~/.config/herdr/herdr.sock` from `herdrState`
   (`src/lib.ts:441`) reported as uncaught — despite the
   `client.on('error', () => {})` handler at `lib.ts:448`. Isolated
   reproduction: the identical `herdrState` code wrapped in one `it()` fails
   under `bun test` but the **same script passes under plain `bun` AND under
   `node --test`** (2/2 pass). So Bun's `node:test` shim reports handled
   socket `error` events to the runner as failures; the compiled-binary
   runtime path handles the error correctly. This is a Bun-runner quirk, not a
   `node:net` incompatibility (and note the connect error codes differ per
   runtime here — EPERM under Node, ENOENT under Bun — because the sandbox
   kills the connect attempt; both are delivered asynchronously and swallowed
   correctly outside the test runner).

**Promotion isolation question:** inconclusive in this sandbox. `bun test`
ran all 41 files together and every promote test died at git-EPERM fixture
setup, before the concurrency-sensitive code ran; the signature matches the
isolated Node promote run exactly. Re-check on an unrestricted machine, but
nothing in the Bun run suggests a *new* promote concurrency failure mode.

**Verdict:** does not block Stage 1, but the 3 runtime incompatibilities are
real and land exactly in the plan's flagged risk areas (child_process ENOENT
mapping, fs error codes, env inheritance). #1 and #2 have one-line defensive
fixes; #3 needs a spawn-site audit (any code that mutates `process.env` and
relies on implicit inheritance misbehaves under Bun — see item #10 for the
security-relevant consequence). `bun test` is a useful advisory lane but
cannot replace the Node oracle (4 tests un-runnable due to runner quirk +
counting differences). The suite has also grown to 733 Node-discovered tests
(the "673" baseline in the plan is stale).

## Item #10 — can `BUN_BE_BUN` be disabled at compile time? Is `env -u` enough?

### Documentation/flag search (Bun 1.3.14)

- `bun build --compile --help` lists every compile flag (reproduced: the
  `--compile-*` family covers `exec-argv`, `autoload-dotenv`, `autoload-bunfig`,
  `autoload-tsconfig`, `autoload-package-json`, `executable-path`, Windows
  metadata). **No flag mentions `BUN_BE_BUN` or any opt-out.**
- The official executables doc (<https://bun.sh/docs/bundler/executables>,
  "Act as the Bun CLI", new in v1.2.16) documents the behavior but no way to
  turn it off. The Bun 1.3 release blog presents `BUN_BE_BUN=1` as a debugging
  *feature* for compiled executables. No compile-time disable exists in the
  1.3.x line as of 1.3.14.

### Empirical verification (fresh build of the real Stage 0 binary)

Built fresh: `bun build --compile --outfile /tmp/bun-spike-0035/bin/hydra-bin-stage0
kit/hydra-ts/src/bin-cli.ts` (Bun 1.3.14).

Parent-level hijack — independently re-confirmed (Stage 0's finding stands):

```
$ BUN_BE_BUN=1 ./hydra-bin-stage0 status ; echo exit=$?
error: Script not found "status"
exit=1                      # entry point never ran; Bun's generic CLI did
```

`env -u` immediately before exec — sufficient for the process it wraps:

```
$ BUN_BE_BUN=1 env -u BUN_BE_BUN ./hydra-bin-stage0 status
{"ok":true,"runtime":"bun-cli-stage0","selfReexecCheck":{"argv":["bun",
"/$bunfs/root/hydra-bin-stage0","__adapter","stub","spike-check"],"execPath":
"/private/tmp/bun-spike-0035/bin/hydra-bin-stage0", ...}}
```

Child-level mitigation — the load-bearing new check. A probe binary that sets
`BUN_BE_BUN=1` *after* its own start (simulating a leak arriving between
parent start and child spawn — if it arrives before exec, the parent is
hijacked and nothing runs) and then self-re-execs:

```
$ ./probe-env spawn-inherit   # child spawned with BUN_BE_BUN=1 in env
{"mode":"spawn-inherit","child_status":1,
 "child_stderr_first_line":"error: Script not found \"child\""}   # child HIJACKED

$ ./probe-env spawn-strip     # bin-cli.ts's exact pattern: env: {...process.env, BUN_BE_BUN: undefined}
{"mode":"spawn-strip","child_status":0,
 "child_stdout_first_line":"{\"marker\":\"PROBE_CHILD_RAN\",
 \"beBun_seen_by_child\":null,\"beBun_type\":\"undefined\"}"}      # child RAN
```

So `env: { ...process.env, BUN_BE_BUN: undefined }` (what
`kit/hydra-ts/src/bin-cli.ts:26-29` does in `selfReexec`) genuinely works:
**Bun's spawn omits env keys whose value is `undefined` entirely** — the child
sees the variable as absent. This omission behavior is itself load-bearing:
the value matrix below shows the literal string `"undefined"` *does* hijack,
so if Bun stringified the value the mitigation would silently fail.

Hijack-trigger value matrix (`BUN_BE_BUN=<v> ./hydra-bin-stage0 __adapter stub probe`):

| value | result |
|---|---|
| `1`, `2`, `yes`, `undefined` | **HIJACKED** (Bun CLI answers; exit 1 for unknown args) |
| `0`, `""` (empty), `false` | runs normally |

One caveat that falls out of item #9's env finding: `bin-cli.ts`'s own
`delete process.env.BUN_BE_BUN` at startup would NOT, by itself, protect
children spawned with default (implicit) env under Bun — deletes don't
propagate. The explicit `env` option in `selfReexec` is what actually
protects the self-re-exec path. Every spawn site in the eventual router must
use the explicit-strip pattern (or `env -u` in shell wrappers); an in-process
delete alone is decorative under Bun.

**Verdict:** solvable known issue. No compile-time disable exists → treat
`env -u BUN_BE_BUN` in every wrapper/Herdr command line and the explicit
`BUN_BE_BUN: undefined` strip in every spawn as release-blocking requirements
(as Stage 0 already concluded), and add the spawn-site audit to Stage 1. The
parent-direct-invocation case (operator's own shell exports `BUN_BE_BUN=1`)
remains hijackable by design; Bun gives no defense beyond failing noisily
(exit 1, `Script not found`) rather than silently doing damage.

## Item #11 — do `--no-compile-autoload-dotenv` / `--no-compile-autoload-bunfig` work?

Setup: a probe binary printing `process.env.SPIKE_DOTENV_MARKER` and
`process.env.BUN_BE_BUN`, compiled twice (defaults vs both `--no-compile-*`
flags); an "armed" cwd containing a `.env` and a `bunfig.toml`; a clean cwd as
control. Bun's documented defaults (and `bun build --compile --help`
confirm): `.env` and `bunfig.toml` autoload are **enabled** by default in
standalone executables; tsconfig/package.json are disabled.

Results:

| scenario | outcome |
|---|---|
| default binary, clean cwd | `{"SPIKE_DOTENV_MARKER":null,"BUN_BE_BUN":null}` |
| default binary, armed cwd (`.env` with marker) | `{"SPIKE_DOTENV_MARKER":"autoloaded-from-dotenv", ...}` — **`.env` autoload confirmed** |
| default binary, armed cwd with **malformed** `bunfig.toml` | **hard crash at startup**: `error: Expected t_equal ... at bunfig.toml:2:6 ... SyntaxError`, exit 1 — the program never runs |
| default binary, `.env` containing `BUN_BE_BUN=1` | program runs (no hijack — the `BUN_BE_BUN` check happens before `.env` autoload) but `process.env.BUN_BE_BUN === "1"` **inside** the program |
| `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` binary, armed cwd (`.env` + malformed `bunfig.toml`) | runs cleanly: `{"SPIKE_DOTENV_MARKER":null,"BUN_BE_BUN":null}` — **both files fully ignored** |

**Verdict:** the flags work exactly as the plan recommends, and they are
mandatory hardening, not optional: without them, any target repository whose
cwd contains a malformed `bunfig.toml` kills the compiled `hydra` at startup,
and any `.env` silently mutates its environment (including injecting
`BUN_BE_BUN=1`, which item #10 shows would hijack *children* spawned without
the explicit strip). Note `kit/hydra-ts/package.json`'s current
`build:bin` script does not yet include the flags — add them in Stage 1.

## Item #13 — size, startup latency, RSS (freshly measured)

Binary rebuilt this session from `kit/hydra-ts/src/bin-cli.ts` with Bun
1.3.14 (no stale numbers; Stage 0's earlier figures were from a near-empty
`cli.ts`).

**Size:**

```
$ ls -l hydra-bin-stage0          63446114 bytes  (60.5 MiB; `du -h` → 61M)
```

**Cold/warm startup** (bash `time` loops, warm page cache — the sandbox offers
no cache purge; per-invocation means):

| operation | compiled binary | `node --experimental-strip-types src/bin-cli.ts` |
|---|---|---|
| bare startup (usage path, 30 runs) | 0.589s → **~19.6ms** | 1.925s → **~64.2ms** |
| `status` (incl. self-re-exec, 20 runs) | 0.728s → **~36.4ms** | 1.892s → **~94.6ms** |

The compiled binary starts ~3.3× faster bare and ~2.6× faster for the
self-re-exec operation. (Node `status` runs the same parent+child spawn shape;
its child fails to re-exec meaningfully since `process.execPath` is the Node
binary — a measurement caveat only, the wall-clock comparison stands.)

**Peak RSS** (self-reported `process.resourceUsage().maxRSS` from a probe
replicating the exact `status` workload — `ps`/`top`/`time -l` are all blocked
in this sandbox; 5 runs, values stable ±2%):

| runtime | parent | self-re-exec child |
|---|---|---|
| compiled binary | 27,508,736 bytes ≈ **26.2 MiB** | ~25.1 MB ≈ **24 MiB** |
| Node 24 strip-types | 72,240 KiB ≈ **70.6 MiB** | ~70 MiB |

(Bun reports `maxRSS` in bytes, Node in KiB — resolved by magnitude: a Bun
runtime can't be 27 GB or 27 KB. That unit divergence in
`process.resourceUsage()` is itself a minor compat note.) The binary uses
~2.7× less memory for the same operation.

**One binary vs N per-adapter binaries** — measured, not extrapolated: every
binary compiled this session is *byte-identical* at 63,446,114 bytes,
including one built from the real `src/adapter-claude.ts` entry and one from a
6-line probe. The embedded runtime dominates completely; application code is
noise at this granularity. The plan's registry (claude, codex, opencode, kimi,
stub) as separate binaries would cost **5 × 60.5 MiB ≈ 302.5 MiB** versus
**60.5 MiB** for the single router binary (the extra bundled source is
invisible at this precision). Per-adapter binaries buy no isolation anyway —
isolation comes from self-re-exec, which the Stage 0 spike already proved.

**Verdict:** already fine, and favorable to the migration. 60.5 MiB / ~20ms /
~26 MiB RSS with a 2.6–3.3× startup and ~2.7× RSS advantage over the Node
source path; the one-binary architecture is clearly right on size grounds.

## Bottom line for Stage 1

| item | verdict |
|---|---|
| #9 `bun test` | 735/735 discovered; 630 pass. 3 genuine runtime incompatibilities (spawn ENOENT `status` shape, `EFAULT` fs error code, env-mutation inheritance) — all narrow, all in flagged risk areas, none a Stage 1 blocker; 4 failures are bun-runner quirks only. Keep Node as the semantic oracle; Bun lane advisory. |
| #10 `BUN_BE_BUN` | No compile-time disable exists (1.3.14). Parent hijack re-confirmed; `env -u` + explicit `BUN_BE_BUN: undefined` spawn env independently re-verified as sufficient for children. Solvable known issue; mitigations are release-blocking, plus a Stage 1 spawn-site audit (implicit env inheritance doesn't propagate mutations under Bun). |
| #11 autoload flags | Both flags work; defaults are ON and dangerous (malformed `bunfig.toml` in cwd crashes the binary at startup; `.env` silently mutates env). Make the flags mandatory in the build script. Already fine once adopted. |
| #13 size/startup/RSS | 60.5 MiB, ~19.6ms bare / ~36.4ms status, ~26 MiB RSS — all better than the Node path. One binary beats 5 × 60.5 MiB. Already fine. |
