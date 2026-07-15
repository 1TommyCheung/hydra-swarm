# Hydra-Swarm standalone Bun binary migration plan

## Scope and decision

This is a plan, not an implementation. The target is a standalone `hydra`
executable built with `bun build --compile`. Operators must not need Node.js or
Bun installed to run the normal Hydra command surface. Bun remains a pinned
build/CI dependency; vendor CLIs, Git, Bash, Herdr, Graphify/GitNexus, and the
platform sandbox remain separate runtime dependencies.

**Decision: build one executable, not one executable per script or adapter.**
The executable exposes the existing script names as public subcommands
(`dispatch`, `promote`, `squash`, `integrate`, `status`, `cancel-task`, and all
other `kit/hydra/scripts/*.sh` counterparts), plus the wider `doctor` preflight
surface. It also has a deliberately undocumented internal command:

```text
hydra __adapter <claude|codex|opencode|kimi|stub> <adapter-verb> <adapter-args...>
```

Dispatch preserves today's subprocess isolation by spawning the same absolute
executable with `__adapter`; it does not call an adapter in-process. It does not
change `argv[0]` to pretend to be another program, and it never shells out to
`bun run`. A plain subcommand is easier to test and inspect than argv-zero
dispatch, and it leaves the adapter process visible in `ps` output.

One executable is preferable because:

- every current operator wrapper has the same three-line switch shape, for
  example `kit/hydra/scripts/dispatch.sh:20-22`,
  `kit/hydra/scripts/promote.sh:28-30`, and
  `kit/hydra/scripts/status.sh:14-16`; one router can serve all of them;
- all TypeScript modules already expose callable functions and have thin
  `process.argv` entry blocks (for example `dispatch.ts:1092-1096,1278-1285`,
  `review-dispatch.ts:311-317,457-474`, and
  `adapter-claude.ts:359-386`);
- four production adapter executables plus a test-stub executable would carry
  duplicate Bun runtimes, require independent install/signing/version checks,
  and could drift from the dispatcher; and
- self-re-exec gives the same failure, timeout, signal, and output boundary as
  today's separate adapter files without requiring those `.ts` files on disk.

## What is known from reading the repository

The following statements are source observations, not Bun assumptions.

1. The stable operator surface is still the shell scripts. Every non-library
   file under `kit/hydra/scripts/` selects TypeScript unless
   `HYDRA_HARNESS=bash`, resolves Node, and executes one source file with
   `--experimental-strip-types`; representative references are listed above.
   `skills/hydra-swarm/references/ts-bash-switch.md:1-29` documents the same
   contract and the deliberate isolation of `promote.test.ts`.
2. Dispatch currently derives `'bash' | 'ts'` from
   `HYDRA_ADAPTER_RUNTIME`, then `HYDRA_HARNESS`, at
   `kit/hydra-ts/src/dispatch.ts:1105-1110`. It resolves adapter files relative
   to `import.meta.url` at `dispatch.ts:1111-1123`.
3. Plain workers run either the Bash adapter directly or
   `node --experimental-strip-types adapter-<vendor>.ts ...` at
   `dispatch.ts:800-823`. The Node executable defaults to `process.execPath` at
   `dispatch.ts:1192-1207`; tests assert that exact behavior at
   `test/dispatch.test.ts:352-377,429-462`.
4. Herdr workers are not just ordinary `spawn` calls. Dispatch assembles a
   quoted shell command at `dispatch.ts:896-956`, and `RealHerdrClient` places
   it after `herdr agent start ... -- bash -lc` at `dispatch.ts:147-160`.
   The wrapper records the shell PID, optionally tails live progress, runs the
   adapter, and writes the exit sentinel. The supervisor polls that sentinel,
   activity files, and PID at `dispatch.ts:992-1061`.
5. `safeRecordUsage` is already an in-process call, not another Node child
   (`dispatch.ts:1064-1089`). It needs no binary hop. The only worker runtime
   boundary that must change is the adapter launch.
6. Resume support is currently discovered by reading adapter source and looking
   for an exported `resume` symbol (`dispatch.ts:460-483`). That cannot be the
   production mechanism once source files are bundled. The current source says
   Claude supports start/resume (`adapter-claude.ts:208-215,229-261,318-348`),
   while Codex accepts only start (`adapter-codex.ts:359`), Kimi's CLI block
   accepts visual/start (`adapter-kimi.ts:655-683`), and OpenCode accepts
   start/explore/review (`adapter-opencode.ts:605-631`).
7. Each adapter then starts the real vendor/tool CLI as its own child. Examples
   are Claude's `spawnSync` at `adapter-claude.ts:55-75`, Codex's
   `execFileSync`/`spawnSync` at `adapter-codex.ts:135-180`, Kimi's streamed
   `spawn` at `adapter-kimi.ts:330-370`, and OpenCode's streamed `spawn` at
   `adapter-opencode.ts:100-181`. Compilation removes the Node child; it does
   not remove those external vendor processes or their PATH/config risks.
8. Review dispatch does not invoke the worker adapter modules. It directly
   builds `codex`, `kimi`, `claude`, or `opencode` reviewer commands at
   `review-dispatch.ts:120-174`, wraps them with PID/raw-output/sentinel writes
   at `review-dispatch.ts:345-352`, and runs the wrapper through Herdr or a local
   `bash -lc` at `review-dispatch.ts:359-425`. Its parent runtime changes to the
   executable, but its vendor command boundary remains.
9. Several commands locate kit-owned data or scripts relative to source
   `import.meta.url`: profiles (`allocate.ts:22-31`), `WAVE`
   (`create-worktree.ts:102-104`), the freshness shell script
   (`graph-impact.ts:30-32`), result/review schemas
   (`promote.ts:23-30`, `record-review.ts:21-23`), and verification/review
   policies (`integrate.ts:36-38`, `review-required.ts:20-22`). These paths will
   not automatically describe the checkout layout inside a standalone bundle.
10. The source uses Node compatibility APIs extensively: synchronous and
    asynchronous `node:child_process`, synchronous `node:fs`, `node:path`,
    `node:url`, `node:os`, `node:crypto`, `node:net`, and `node:process`.
    Representative high-risk behavior includes recursive process termination
    and delayed SIGKILL (`lib.ts:205-229`), spawn-and-timeout handling
    (`lib.ts:237-266`), Unix-socket Herdr reporting (`lib.ts:380-412`), dispatch
    signals/timers (`dispatch.ts:96-114,373-389,864-878`), and review signal
    exit-code mapping (`review-dispatch.ts:60-89`). There is no
    `node:worker_threads` import and no `Worker` construction in
    `kit/hydra-ts/src`; timers are used, worker threads are not.
11. The local Node failure is concrete. The runtime reference records
    `/usr/local/bin/node` v17.4.0 shadowing nvm Node v22.14.0 in Herdr login
    shells and sandboxed verification shells, causing `bad option` for
    `--experimental-strip-types`/`--test`
    (`skills/hydra-swarm/references/ts-bash-switch.md:31`). The resolver tests
    PATH, nvm installs, and Homebrew paths (`kit/hydra/scripts/lib.sh:19-117`).
    `docs/operations.md:90-94,168` records the same observed failure and remedy.
12. The frozen Bash fallback is not entirely Node-free. Its `promote.sh` invokes
    bare `node` for `jsonschema.mjs` at `kit/hydra/scripts/promote.sh:55-60`,
    and `record-review.sh` does the same at
    `kit/hydra/scripts/record-review.sh:28-37`. These are the two bare-Node
    executable calls in the frozen Bash bodies, separate from the TypeScript
    switch preambles.
13. `doctor` is wider than the current TypeScript harness. The slash command
    invokes `kit/scripts/doctor.sh` for normal and JSON diagnostics
    (`commands/hydra-doctor.md:1-8,27-35`) and reserves `doctor-fix.sh` for
    explicitly confirmed, one-at-a-time remediation
    (`commands/hydra-doctor.md:37-47`). There is no corresponding
    `kit/hydra-ts/src/doctor.ts` today, so "one binary for the whole CLI" needs
    an explicit diagnostic port rather than an assumed import.

## Target command and adapter architecture

### Public router

Add one build entry point, conceptually `kit/hydra-ts/src/cli.ts`, with a static
command table. It must cover every current TypeScript-backed script:

```text
aggregate-usage  allocate            amend-task       audit-ownership
cancel-task      code-intel          create-worktree  dispatch
freshness-gate   graph-impact        graphify-baseline
graphify-investigate                 graphify-repo     herdr-push
index-candidate  integrate           ledger-view      measure-divergence
otel-env         promote             record-review    record-usage
review-dispatch  review-required     run-init          squash
status           verify
doctor
```

The router forwards arguments without changing current exit codes, stdout, or
stderr. Refactor the scattered module-level `isMain` blocks into exported
`main(args)` functions where necessary, while retaining direct source entry
points for the TS rollback lane during rollout. The build must have only one
top-level entry side effect; do not assume bundled `import.meta.url` comparisons
will keep every imported module's current `isMain` block dormant.

The executable also provides `--version`/`doctor runtime` output containing the
source revision, pinned Bun version, target triple, and build mode. This is
needed to diagnose a stale executable even when Node/Bun are absent.

Port the read-only `doctor` and `doctor --json` checks into the router while
preserving their PASS/WARN/FAIL and structured-output contract. Update the
meaning of its runtime checks: the selected binary's existence, checksum,
target architecture, signature/quarantine status, and `--version` self-test are
required; Node >=22.6 is only a warning for the `HYDRA_HARNESS=ts` rollback and
source-development lane; Bun is not an operator prerequisite and is checked
only in build/development mode. Keep auto-remediation out of the first binary:
the existing `doctor-fix.sh` remains the explicitly confirmed mechanism, since
`commands/hydra-doctor.md:27-62` gives it a different mutation/approval
contract. Moving fixes into `hydra doctor` would require its own security and
confirmation design, not a compilation side effect.

### Adapter registry and self-re-exec

Replace source-file discovery with a static registry imported into the binary:

```text
vendor     handler              supported verbs
claude     adapterClaudeMain    start, resume
codex      adapterCodexMain     start
opencode   adapterOpencodeMain  start, explore, review
kimi       adapterKimiMain      start, visual
stub       adapterStubMain      start, resume (test-only build or test gate)
```

The registry is the authoritative capability source for `determineDelivery`.
Production dispatch validates the vendor and verb against it; tests may inject
a registry. It must no longer read an adapter `.ts` file or regex its exports.

At executable startup, resolve and retain an absolute self path. Prefer the
compiled runtime's verified `process.execPath`; if the spike shows different
behavior, use a realpath of the startup executable argument. Expose it to
dispatch as `selfExecutable`, replacing `nodeExecutable`. Never resolve a bare
`hydra` through PATH for a worker. Plain dispatch becomes equivalent to:

```text
/absolute/plugin/bin/hydra __adapter claude start <task-spec> <worktree> \
  <inbox> <sessions> <agent-run-id> <prior-session>
```

This preserves a distinct adapter PID and lets the existing parent supervise,
timeout, signal, and record usage exactly where it does today. The adapter child
then spawns the vendor CLI as today. Do not set `BUN_BE_BUN=1`, invoke `bun`, or
use the compiled executable as a generic Bun script runner: those options make
runtime behavior depend on Bun CLI semantics and weaken the intended boundary.

## Herdr pane hosting after compilation

`RealHerdrClient` may continue to ask Herdr for `bash -lc`; the standalone goal
removes Node/Bun, not Bash or Herdr. Keep the current PID and sentinel protocol,
shell quoting, progress tail, exit-code capture, and pane-close policy. Only the
adapter command changes. For Claude, the non-progress form is conceptually:

```bash
bash -lc 'echo $$ > '\''<pidfile>'\''; \
  cat '\''<banner>'\'' 2>/dev/null; \
  env -u BUN_BE_BUN '\''/absolute/plugin/bin/hydra'\'' \
    '\''__adapter'\'' '\''claude'\'' '\''start'\'' ...; \
  printf '\''%s'\'' $? > '\''<sentinel>'\'''
```

For Codex/Kimi, retain the current `set +e`, progress-file `tail`, `RC=$?`, tail
termination, and sentinel sequence from `dispatch.ts:937-949`; substitute the
absolute binary plus `__adapter <vendor>` at the current adapter position.
Continue to quote every argument with the existing single-quote escaping rule
at `dispatch.ts:896-897`.

The PID file intentionally remains the wrapper shell PID. Existing `killTree`
recurses through children before signaling the parent (`lib.ts:205-229`), so the
self-re-executed adapter and vendor grandchild remain in the same termination
tree. A compiled spike must demonstrate this with a real process tree and
SIGTERM/SIGKILL timeout test; it is not enough to assert that the command string
looks correct.

Review dispatch keeps its current direct vendor wrapper. Its compiled tests must
still cover raw output, sentinel creation, signal-derived exit codes, and the
Herdr-to-inline fallback. Consider replacing its external `sleep` subprocess
(`review-dispatch.ts:303-305`) with an async timer as a cleanup, but do not mix
that semantic change into the first compilation spike unless Bun shows a real
compatibility problem.

## Kit assets and source-relative paths

A single code bundle is insufficient unless kit-owned runtime assets are
handled deliberately.

1. Embed immutable data used by the compiled path: `WAVE`, the four profile
   YAML files, `result.schema.json`, `review.schema.json`,
   `verification.yaml`, and `review-policy.yaml`. Bun documents file imports for
   standalone executables and says the resulting `/$bunfs/` paths are readable
   with Node `fs`; use explicit file imports or generated string constants, not
   paths computed by walking from bundled `import.meta.url`.
2. Preserve the existing test/config path overrides. An operator-supplied
   `HYDRA_VERIFY_POLICY` remains an external file. Defaults come from embedded
   assets and must be read-only; mutable run state remains under
   `HYDRA_STATE_ROOT` as it is now.
3. Remove the compiled `graph-impact` command's dependency on executing
   `kit/hydra/scripts/freshness-gate.sh` by calling the imported TypeScript
   freshness-gate function. The Bash rollback keeps its shell call graph.
4. Compiled dispatch does not need adapter sources or Bash adapters for its
   default `bin` adapter mode. An explicit mixed
   `HYDRA_ADAPTER_RUNTIME=bash` may still locate checkout-owned shell adapters;
   validate that path and emit a clear error if the executable was distributed
   without the kit tree.

Official Bun executable documentation is the design reference for bundling,
cross-targets, and embedded assets:
<https://bun.sh/docs/bundler/executables>. Asset behavior, especially sync
`readFileSync`, still needs the repository spike below.

## Node API and Bun compatibility risk register

Bun's current compatibility page
(<https://bun.sh/docs/runtime/nodejs-compat>) describes `node:fs`, `node:os`,
`node:path`, `node:url`, and `node:net` as implemented, but it does not make the
Hydra behavior proven. In particular, it lists limitations in
`node:child_process`, `node:crypto`, `node:worker_threads`, and `node:test`.

| Area | Hydra usage known from code | Migration assessment |
|---|---|---|
| `node:child_process` | `spawn`, `spawnSync`, and `execFileSync` are used across the router, adapters, verification, Git operations, and Herdr. Hydra uses stdio arrays, file descriptors, detached flags, exit/error/signal events, and inherited environments. | Bun's documented missing uid/gid and socket-handle IPC features are not used here. Exact stdio EOF ordering, signal status, ENOENT/EACCES mapping, and process-tree behavior are high-risk and require black-box tests. |
| `node:fs` and embedded files | State uses sync reads/writes/appends/renames/removes/stats; embedded defaults would be read with `readFileSync`. | Ordinary filesystem calls are expected to be compatible. Verify atomic rename, append concurrency, symlink/stat behavior, file-descriptor stdio, and `/$bunfs/` reads. Never try to write an embedded asset. |
| `node:crypto` | Dispatch and the loop detector use `randomBytes`; the loop detector also uses `createHash` (`dispatch.ts:1137-1138`, `loop-detector.ts:1`). | Bun's documented missing crypto calls are unrelated, but compare hash bytes/encoding and random-byte failure behavior in the suite. |
| `node:net` | `herdrState` opens a Unix socket with timeout and event handlers (`lib.ts:380-412`). | Documented as implemented; verify connect/data/timeout/error ordering against a real or fixture Herdr socket. Windows named-pipe behavior is deferred with Windows support. |
| OS/process/signals | CPU count sets concurrency; signal constants map review exits; dispatch installs SIGINT/SIGTERM/SIGHUP handlers and uses `process.kill(pid, 0)`. | Verify on both macOS targets. Signal semantics and child exit codes are release blockers because they affect cancellation and ledger truth. |
| timers | Global timers drive kill escalation, verification timeouts, graphify timeouts, dispatch polling, and cancellation sleeps. | No worker-thread dependency exists. Exercise fake-clock unit tests plus real compiled timeout tests; do not infer correctness from Bun's timer API presence. |
| `import.meta.url` / main detection | Many files use it for CLI detection; eight commands also derive kit paths from it. | Refactor to one router and embedded assets. Treat compiled values of `import.meta.url`, `process.argv`, and `process.execPath` as spike results, not design assumptions. |
| `node:worker_threads` | No usage in `kit/hydra-ts/src`. | No migration work. Do not add workers merely for compilation. If later introduced, Bun standalone builds require explicit worker entrypoints and Bun documents unsupported Worker options. |
| `node:test` | The whole suite imports Node's runner and is launched by Node. | Bun documents only partial `node:test` support. Keep Node as the semantic oracle during transition and add a separate Bun/compiled lane; do not silently replace the runner. |

Compile with runtime auto-loading disabled
(`--no-compile-autoload-dotenv --no-compile-autoload-bunfig`) so a target
repository's `.env` or `bunfig.toml` cannot silently change harness behavior.
Also test and defensively remove `BUN_BE_BUN` in shell launchers: Bun documents
that this environment variable can cause a standalone executable to ignore its
bundled entry point. Whether a compile-time option can disable that behavior is
an explicit unknown.

## Shell switch and Bash fallback

During rollout, change each script preamble from the current two-state implicit
test to an explicit three-state switch while keeping the script path and
arguments stable:

```bash
case "${HYDRA_HARNESS:-ts}" in
  bin)
    HYDRA_BIN="${HYDRA_BIN:-$SELF_DIR/../../hydra-ts/dist/hydra}"
    [ -x "$HYDRA_BIN" ] || hydra_die "compiled Hydra binary unavailable: $HYDRA_BIN"
    exec env -u BUN_BE_BUN "$HYDRA_BIN" "$(basename "$0" .sh)" "$@"
    ;;
  ts|'')
    HYDRA_NODE="$(hydra_resolve_node)"
    exec "$HYDRA_NODE" --experimental-strip-types \
      "$SELF_DIR/../../hydra-ts/src/<name>.ts" "$@"
    ;;
  bash) ;; # continue into the frozen body
  *) hydra_die "HYDRA_HARNESS must be bin, ts, or bash" ;;
esac
```

Do not name the compiled selection `bun`: normal execution does not require Bun.
`HYDRA_BIN` must be an absolute, executable override after resolution. Normal
wrappers use the plugin-relative absolute path, so an older `hydra` elsewhere on
PATH cannot shadow it.

Extend the lower-level adapter switch to `bin | ts | bash` with strict parsing:

- compiled harness + unset `HYDRA_ADAPTER_RUNTIME` -> `bin` self-re-exec;
- TS harness + unset override -> today's `ts` behavior;
- `bash` -> the frozen shell adapter;
- explicit `ts` under compiled harness -> diagnostic mixed mode that requires a
  qualifying Node and source checkout; and
- explicit `bin` under TS harness -> the configured standalone executable.

Keep `HYDRA_ADAPTER_RUNTIME` higher priority than the harness default, matching
today's tests at `test/dispatch.test.ts:393-427`. Reject invalid values instead
of silently mapping everything non-Bash to TypeScript as
`dispatch.ts:1106-1110` does now.

Keep `HYDRA_HARNESS=bash` frozen as historical reference and emergency
fallback; do not attempt to compile shell bodies. Explicitly document that it is
not a complete Node-free path because `promote.sh` and `record-review.sh` call
the JS schema validator with bare Node. Changing those bodies would violate the
frozen-reference premise. The no-Node rollback is a previous known-good
versioned executable selected with `HYDRA_BIN`; `HYDRA_HARNESS=ts` is an
additional rollback when qualifying Node is available.

## Build and CI plan

### Reproducible build

Add a pinned Bun version and lockfile plus scripts conceptually equivalent to:

```text
bun build src/cli.ts --compile --target=bun-darwin-arm64 \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile dist/darwin-arm64/hydra

bun build src/cli.ts --compile --target=bun-darwin-x64 \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile dist/darwin-x64/hydra
```

The official target table includes Darwin arm64/x64, Linux glibc/musl
arm64/x64, and Windows arm64/x64. This repository currently operates on macOS
developer machines (also reflected by the Homebrew/nvm resolver and macOS
operational notes), so phase 1 ships only `bun-darwin-arm64` and
`bun-darwin-x64`. Linux and Windows distribution are explicitly deferred, not
claimed from a successful cross-compile. Linux needs sandbox, libc, process,
and shell test matrices; Windows needs a design for Bash, Unix sockets, signals,
paths, and vendor sandboxes.

Produce one manifest per artifact containing source SHA, pinned Bun version,
target, size, and SHA-256. Build the two macOS targets in clean CI, smoke each
on matching hardware, and retain at least one previous known-good version.
Before making the binary default, define the install/update mechanism as an
atomic versioned directory plus a stable link (or equivalent manifest pointer),
so rollback is a pointer/`HYDRA_BIN` change rather than a rebuild.

Because macOS Gatekeeper can reject downloaded executables, determine signing,
notarization, quarantine, and JIT entitlement requirements in the spike. Bun's
documentation describes code signing and JIT entitlements, but the repository
has no established compiled-artifact signing policy. An unsigned local CI build
is not distribution proof.

Bun itself has a PATH-shadowing risk only at build time if CI invokes a bare,
unversioned `bun`. Pin the version, install it in a controlled location, invoke
that absolute path, assert `bun --version`, and record it in the artifact. At
runtime the compiled executable contains Bun's runtime and never resolves
`bun`; therefore stale Node or Bun cannot intercept adapter startup. The
analogous runtime risk is a stale `hydra` binary on PATH, avoided by the
plugin-relative absolute path and observable build metadata.

### CI gates

For each supported target, require in order:

1. TypeScript `tsc --noEmit`.
2. The existing Node semantic suite, preserving its split execution.
3. A Bun-runtime compatibility lane over the source tests, initially advisory
   until its `node:test` differences are understood.
4. `bun build --compile` with warnings/errors fatal and an artifact manifest.
5. Compiled black-box tests on the matching OS/architecture with Node and Bun
   removed from PATH.
6. macOS signing/notarization verification for distributable artifacts.
7. A no-network smoke test that invokes every public subcommand's usage/help
   path, `doctor`/`doctor --json`, and the internal stub adapter, plus targeted
   fixture vendor tests.

## Test strategy

The task baseline is the existing 673-test suite under `kit/hydra-ts/test`.
`package.json:9-11` currently runs all non-promotion `.test.ts` files first and
then `promote.test.ts` alone to avoid its known concurrent-load flake. Preserve
that exact separation and count in the Node lane. Node continues to execute the
TypeScript source with `--experimental-strip-types`; it does not and cannot
validate the Bun executable by running "pre-compiled source."

The baseline must be made green before it is used for Bun attribution. During
this plan's advisory verification, the resolver-selected Node 24.16.0 run
reported 673 tests, 670 passing, and three failures in the Bash fallback status
process-discovery cases (`test/status.sh.test.ts:182-256`); a targeted run under
the historically documented Node 22.14.0 reproduced the same three failures.
The TypeScript `status` suite passed in that run. Treat this as a pre-existing
baseline/environment investigation, not as evidence for or against Bun, and do
not let a Bun migration hide it by resetting the expected count.

During transition, run both source-runtime and artifact tests:

- **Canonical semantic lane:** the unchanged split `npm test` under a pinned
  supported Node, plus `npm run typecheck`. This detects behavior drift
  independently of Bun.
- **Bun source lane:** attempt the same split file sets under Bun, because the
  tests import `node:test`. Keep it advisory at first; Bun documents partial
  `node:test` support at <https://bun.sh/reference/node/test>. If incompatibility
  is runner-only, add a small runner adapter or dedicated Bun tests rather than
  rewriting assertions and accidentally changing semantics.
- **Compiled artifact lane:** execute the built file as a black box. This lane is
  release-blocking from the first opt-in release and runs with PATH fixtures
  that intentionally contain stale/failing `node` and `bun` shims.

Update/add tests in these concrete areas during implementation:

1. Change dispatch expectations at
   `test/dispatch.test.ts:352-377,429-462` from Node plus a `.ts` path to an
   injected absolute `selfExecutable` plus
   `__adapter <vendor>`. Preserve separate assertions for plain and Herdr paths.
2. Replace source-file resume fixtures with injected adapter-registry
   capabilities; verify Claude resumes and the other production workers cold
   restart exactly as the current capability set dictates.
3. Keep all existing Herdr wrapper tests, including command ordering/progress
   tail/PID/sentinel/pane-close behavior. Add a real compiled wrapper test whose
   child is killed and whose ledger exit code matches observation.
4. Replace the CLI helper's Node launch at
   `test/review-dispatch.test.ts:683-699` with the built executable's
   `review-dispatch` command in the artifact lane; keep the source form in the
   Node lane.
5. For every embedded default, run the executable from an unrelated temporary
   working directory and after moving it away from the checkout. This proves it
   is standalone and not accidentally finding `kit/hydra` beside the source.
6. Run promote, record-review, allocate, create-worktree, integrate,
   review-required, and graph-impact fixture tests specifically, because they
   cover all known source-relative assets.
7. Exercise `spawn`/`spawnSync`/`execFileSync` error mapping (ENOENT, EACCES,
   signal, non-zero), streamed stdout/stderr EOF, file-descriptor redirection,
   kill escalation, Unix-socket timeout, signal handlers, and concurrent ledger
   append/atomic rename.
8. Verify `BUN_BE_BUN=1`, `.env`, and `bunfig.toml` cannot divert or configure
   the shipped command, and verify the executable starts when `node`/`bun` are
   absent or deliberately broken on PATH.
9. Run an opt-in end-to-end stub loop, then credentialed canaries for each real
   adapter vendor. The unit suite's injected spawns are necessary but cannot
   prove actual vendor CLI stdio and signal behavior under Bun.

Do not delete the Node lane when the Bun lane first turns green. Retire it only
after the compiled default has completed a defined soak period and the team has
explicitly accepted Bun as the sole semantic runtime; until then it is the
independent oracle and the TS rollback validation.

## Staged rollout and rollback

### Stage 0 — spike, no operator switch

Build a minimal router plus one stub adapter, settle the unknowns below, and
prove movable/no-Node execution on both supported macOS architectures. Keep the
current default (`HYDRA_HARNESS=ts`). No production vendor dispatch uses the
binary.

### Stage 1 — explicit opt-in

Ship a versioned, signed artifact and the three-state preamble. Operators/canary
CI opt in with `HYDRA_HARNESS=bin`. Unset remains `ts`. Keep
`HYDRA_ADAPTER_RUNTIME` unset for normal canaries so the compiled parent also
uses compiled self-reexec adapters. Compare ledger/output/state artifacts from
equivalent stub and safe vendor runs.

Rollback order is:

1. set `HYDRA_BIN` to the retained previous known-good absolute executable
   (works without Node/Bun);
2. set `HYDRA_HARNESS=ts` to return to the current Node source harness when a
   qualifying Node is installed; or
3. set `HYDRA_HARNESS=bash` for the frozen historical body, accepting its
   documented Node limitation for promote/record-review.

### Stage 2 — binary default with explicit fallbacks

After the full 673-test Node lane, Bun lane, artifact matrix, vendor canaries,
and soak criteria pass, change the wrapper default from `ts` to `bin`. Do not
remove the TS sources, Node test scripts, or Bash bodies. Alert clearly if the
default artifact is missing/corrupt; never silently select another runtime for
state-mutating commands.

### Stage 3 — simplify only after evidence

After a second soak window, decide separately whether to retire the TS operator
lane. Keep Bash frozen as reference until the project's broader migration policy
changes. Cross-platform binaries and removal of the two Bash bare-Node validator
calls are separate scoped projects, not hidden Stage 3 work.

## Needs a `bun build --compile` spike to verify

None of the following can be resolved confidently by reading this source or Bun
marketing/API tables alone. Record each result with the exact pinned Bun version
and target:

1. What do `process.execPath`, `process.argv[0]`, `process.argv[1]`,
   `import.meta.url`, and symlinked/moved invocation paths contain inside the
   compiled executable? Which value remains a reliable absolute self-reexec path?
2. Do imported modules' current `isMain` checks remain false after bundling, or
   can multiple CLI blocks execute? The final design avoids relying on this, but
   the transition wrappers must be tested.
3. Do embedded YAML/JSON/text assets work with synchronous `node:fs` reads,
   survive moving the executable away from the repository, and remain
   discoverable after macOS signing/notarization?
4. Does a self-reexecuted `__adapter` preserve exact argv (including empty prior
   session and quotes/newlines), environment, cwd, stdio, PID relationships,
   signals, exit codes, and stream EOF ordering for all four adapters?
5. Does the Herdr `bash -lc` wrapper kill the shell, self-reexecuted adapter, and
   vendor grandchild without orphans on timeout/cancel? Does PID reuse protection
   behave identically?
6. Are `spawnSync` file-descriptor stdio arrays, async stream events,
   ENOENT/EACCES errors, signal-derived status, `process.kill(pid, 0)`, and
   detached/process-group behavior equivalent in the exact Bun version?
7. Do concurrent ledger append, atomic rename, symlink/lstat/readlink checks,
   permissions, and temp-file cleanup preserve the trust-boundary behavior?
8. Does `node:net` match the Herdr Unix-socket connect/data/error/timeout ordering
   used by `herdrState`?
9. How many of the 673 `node:test` tests run unchanged with Bun, and are any
   failures actual runtime incompatibilities versus Bun runner gaps? Does the
   promotion isolation still matter under Bun?
10. Can `BUN_BE_BUN` be disabled at compile time? If not, is `env -u` sufficient
    for every wrapper/Herdr/self-reexec path, and what guard is possible for a
    direct executable invocation?
11. Does disabling dotenv/bunfig autoload fully prevent target-repository config
    from changing the standalone runtime?
12. What macOS signing/notarization/JIT entitlements are required, and does the
    signed artifact run on both Apple Silicon and Intel machines supported by
    the project?
13. What binary size/startup/RSS cost results from one runtime versus separate
    adapter binaries? The architectural choice remains one binary unless the
    spike finds a functional blocker, not merely a size preference.
14. Do real installed Claude, Codex, OpenCode, Kimi, `srt`, Herdr, Git, and shell
    tools behave under the compiled parent's inherited environment? Unit fakes
    cannot answer this.

## Completion criteria for the future implementation

The migration is complete only when the compiled artifact:

- implements every public wrapper command and the internal adapter registry;
- runs from outside the checkout with embedded immutable defaults;
- self-reexecutes all vendor adapters without Node or Bun on PATH;
- preserves Herdr PID/progress/sentinel, cancellation, timeout, ledger, trust,
  and exit-code behavior;
- passes the source semantic suite and target-specific compiled black-box suite;
- is reproducibly built, identified, signed, and retained with a known-good
  rollback artifact; and
- has completed the opt-in and default soak stages without removing the explicit
  TS and Bash rollback selections.
