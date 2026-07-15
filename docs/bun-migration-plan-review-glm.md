# Cross-vendor review: Bun single-binary migration plans for `kit/hydra-ts`

> Reviewer: GLM (run 0030, task `bun-plan-review-glm`).
> Base commit: `066e92266875e680094a8e7c7ecaef49d2e0dad7`.
> Plans reviewed:
> - `docs/bun-migration-plan-codex.md` (Codex, 578 lines)
> - `docs/bun-migration-plan-kimi.md` (Kimi, 371 lines)
>
> Every code claim below was verified against the actual source at the base
> commit. Where a plan's line number is off by a few lines, I note the actual
> location; where a claim is substantively wrong, I say so and quote the code.

---

## 1. Where the two plans AGREE (convergent conclusions)

Both plans independently converged on the same core architecture. Because these
are independent vendors working from the same codebase, convergence is a
stronger signal than either plan alone.

### 1.1 One binary, not one per script or adapter

Both choose a single compiled `hydra` executable with subcommands. Codex states
this as an explicit decision at the top ("Decision: build one executable, not
one executable per script or adapter"). Kimi reaches the same conclusion in its
Section 0 ("Chosen boundary: a single compiled binary").

The reasoning converges: dispatch already spawns adapters as child processes
(`dispatch.ts:800-823`), and in a compiled world there is no ambient `node` to
run a separate compiled adapter file. Self-re-exec of the same binary via a
subcommand avoids a "find my sibling binary" deployment problem.

### 1.2 Self-re-exec via a subcommand for adapter isolation

Both propose that dispatch spawns the same binary with an adapter subcommand to
preserve subprocess isolation. Codex calls it `hydra __adapter <vendor>
<verb> <args>`; Kimi calls it `hydra adapter <vendor> <verb> <args>`. The
mechanism is identical; only the subcommand name differs (see Section 2).

Both correctly identify that this preserves the existing failure, timeout,
signal, and output boundary because the adapter child gets its own PID and the
supervisor's existing kill-tree logic (`lib.ts:196-230`) continues to work.

### 1.3 Three-state `HYDRA_HARNESS` switch with staged rollout

Both extend the current binary-state `HYDRA_HARNESS` preamble
(`kit/hydra/scripts/dispatch.sh:20-23`: if not `bash`, exec Node with
`--experimental-strip-types`) into a three-state switch: `bash` / `ts` / new
compiled value. Both retain `ts` as the initial default and flip to the
compiled binary only after a soak period.

Both preserve the existing `HYDRA_ADAPTER_RUNTIME` override semantics verified
at `dispatch.ts:1106-1110` (priority: option > `HYDRA_ADAPTER_RUNTIME` >
`HYDRA_HARNESS`).

### 1.4 macOS arm64 + x64 as first targets, Linux/Windows deferred

Both scope initial builds to `bun-darwin-arm64` and `bun-darwin-x64`, deferring
Linux and Windows. This aligns with the Homebrew/nvm resolver in
`kit/hydra/scripts/lib.sh:67-118` which only checks macOS Node paths.

### 1.5 `import.meta.url` / `isMain` as the core bundling problem

Both identify that the `isMain` guard pattern
(`process.argv[1] !== undefined && import.meta.url ===
pathToFileURL(resolve(process.argv[1])).href`, used in 30+ source files per my
grep) will not survive bundling. Both propose removing/neutralizing these guards
and replacing them with a single router entry point. This is correct: my grep
found 43 `import.meta.url` references across `kit/hydra-ts/src/`, most in
`isMain` checks.

### 1.6 `process.execPath` as the critical spike unknown

Both flag `process.execPath` behavior inside a compiled binary as the #1 spike
unknown. The self-re-exec architecture depends on `process.execPath` being the
compiled binary itself. The current code defaults to it at
`dispatch.ts:1206` (`nodeExecutable: options.nodeExecutable ?? process.execPath`).

---

## 2. Where they DISAGREE, and which is correct

### 2.1 Subcommand naming: `__adapter` (Codex) vs `adapter` (Kimi)

**Codex wins.** Codex deliberately uses a double-underscore prefix to signal
"internal, undocumented command" and keep it out of operator-facing help text.
Kimi exposes `adapter` as a plain subcommand. The adapter invocation is an
internal implementation detail of dispatch's child-spawning; making it a
visible public subcommand invites operators to call it directly, bypassing the
dispatch supervision (timeout, sentinel, ledger, concurrency cap). Codex's
choice is safer.

### 2.2 `HYDRA_HARNESS` value: `bin` (Codex) vs `binary` (Kimi)

Minor, but Codex's `bin` is more ergonomic for a shell env var and aligns with
the existing short-value convention (`ts`, `bash`). Kimi's `binary` works but is
unnecessarily verbose. Not a substantive error either way.

### 2.3 Kit asset embedding: detailed (Codex) vs barely mentioned (Kimi)

**Codex wins decisively.** Codex identifies eight specific source-relative path
dependencies that would break inside a compiled bundle: profiles
(`allocate.ts:22-25`), WAVE (`create-worktree.ts:103`), freshness shell script
(`graph-impact.ts:30-33`), result/review schemas (`promote.ts:24-30`,
`record-review.ts:22-23`), and verification/review policies (`integrate.ts:37`,
`review-required.ts:21`). I verified all of these; they all call
`dirname(fileURLToPath(import.meta.url))` and then walk the checkout tree to
find kit-owned data files. Inside a compiled binary, `import.meta.url` points
to a synthetic `/$bunfs/` path, not the source tree, so these would silently
fail.

Kimi mentions resource bundling only as spike item #10 ("Verify that no dynamic
`import()` or runtime file reads ... are broken by the bundler") without
identifying any of the specific affected files. This is a critical gap: these
are not unknowns, they are known breakages that need explicit asset-embedding
design.

### 2.4 `BUN_BE_BUN` / dotenv / bunfig autoload risk

**Codex identifies this; Kimi does not.** Codex warns that `BUN_BE_BUN=1` can
cause a standalone executable to "ignore its bundled entry point," proposes
`env -u BUN_BE_BUN` in every wrapper and self-re-exec path, and recommends
`--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Kimi's plan
contains no mention of these flags or this risk.

This matters: a target repository's `.env` or `bunfig.toml` could silently
change harness behavior if autoload is not disabled. Codex's concern is
legitimate and its mitigation is the correct first approach.

### 2.5 `doctor` command scope

**Codex identifies this; Kimi does not.** Codex correctly notes there is no
`kit/hydra-ts/src/doctor.ts` (confirmed by glob), and that `doctor` is currently
`kit/scripts/doctor.sh` invoked via `commands/hydra-doctor.md:1-8`. Codex
proposes porting the read-only checks into the binary while leaving
`doctor-fix.sh` as a separate mutation surface. Kimi's plan lists `hydra
doctor` as a subcommand without noting that no TypeScript implementation exists
to compile.

### 2.6 Resume capability detection breakage

**Codex identifies this; Kimi does not.** At `dispatch.ts:460-484`, the
`determineDelivery` function reads the adapter source file from disk and
regex-matches for an exported `resume` symbol:

```ts
const source = readFileSync(adapterPath, 'utf8');
if (extname(adapterPath) === '.ts') {
  supportsResume = /^\s*export\s+(?:(?:async\s+)?function|(?:const|let|var))\s+resume\b/m.test(source)
    || /^\s*export\s*\{[^}]*\bresume\b[^}]*\}/m.test(source);
}
```

In a compiled binary, the adapter `.ts` files are not on disk; this
`readFileSync` would throw (caught as "no resume support"), silently degrading
all resume-capable vendors to cold restart. Codex proposes replacing this with
a static adapter registry. Kimi's plan does not mention this issue at all.

### 2.7 Signing / notarization

Codex discusses macOS Gatekeeper, signing, notarization, and JIT entitlements
as a real distribution risk and includes it in the spike list. Kimi does not
mention signing at all. For a project that runs on macOS developer machines,
this is a real concern: downloaded unsigned executables can be blocked by
Gatekeeper.

---

## 3. Factual errors proven wrong by reading the code

### 3.1 Kimi: wrong base commit

Kimi's plan header states it was "grounded in the code that exists at base
commit `6a1d2b1608c2540503e808c0a0dfa1322f10e13b`." The actual base commit for
this run is `066e92266875e680094a8e7c7ecaef49d2e0dad7`. This may explain why
some of Kimi's line numbers have small drift. It doesn't invalidate the plan's
conclusions, but the grounding claim is inaccurate.

### 3.2 Kimi: herdr pane wrapper description is incomplete

Kimi's Section 4 (line 156 of the plan) presents a single herdr pane wrapper
string with `set +e`, `touch progress`, `tail -f progress`, `RC=$?`, and
`kill TPID`. This is only the `usesLiveProgressPane` variant (codex/kimi) from
`dispatch.ts:939-949`. The actual code has a second, simpler form for
claude/opencode at `dispatch.ts:951-956`:

```ts
inner = [
  `echo $$ > ${shellQuote(pidfile)}`,
  `cat ${shellQuote(bannerPath)} 2>/dev/null`,
  `${adapterArgs}`,
  `printf '%s' $? > ${shellQuote(sentinel)}`,
].join('; ');
```

No `set +e`, no progress tail, no `TPID`. Kimi's omission isn't a fatal error
(the progress-pane form is the more complex one worth showing), but it means
Kimi's proposed wrapper replacement doesn't account for the non-progress
vendors.

### 3.3 Kimi: proposed `adapterRuntime` code change would break the TS path

Kimi's Section 2 proposes replacing the adapter command construction at
`dispatch.ts:814-817` with:

```ts
const command = ctx.adapterRuntime === 'binary' ? process.execPath : ctx.adapterPath;
const args = ctx.adapterRuntime === 'binary'
  ? ['adapter', ctx.vendor, ...adapterArgs]
  : adapterArgs;
```

The existing code is a two-way ternary: `'ts'` uses `nodeExecutable` +
`--experimental-strip-types` + `.ts` path; everything else (`'bash'`) uses the
adapter path directly. Kimi's replacement is also two-way: `'binary'` vs
everything else. But "everything else" now includes `'ts'`, which would fall
into the `ctx.adapterPath` branch—running a `.ts` file as a bare command
without Node. This is broken. The fix requires a three-way switch, not a
two-way replacement. Codex's description of the same change avoids this by
describing it structurally ("change `WorkerContext.adapterRuntime` type from
`'bash' | 'ts'` to `'bash' | 'ts' | 'binary'`") rather than showing broken
pseudocode.

### 3.4 Kimi: `adapter-kimi.ts` `isMain` inconsistency not noted

`adapter-kimi.ts:655-656` uses `pathToFileURL(process.argv[1]).href` WITHOUT
`resolve()`, unlike every other adapter which uses
`pathToFileURL(resolve(process.argv[1])).href`. This inconsistency is relevant
to bundling because the missing `resolve()` means the comparison uses a
relative path, which could behave differently under a compiled binary's
synthetic paths. Neither plan mentions this, but Codex's broader "treat
compiled values of `import.meta.url`, `process.argv`, and `process.execPath`
as spike results" covers it implicitly.

### 3.5 Codex: minor line-number drift (not errors, but worth noting)

Codex's line references are consistently accurate but occasionally off by a
few lines, likely due to small commits between Codex's base and this run's
base:

- `dispatch.ts:1105-1110` → actual: 1106-1110 (off by 1 at start)
- `dispatch.ts:147-160` → actual: 147-166 (off by 6 at end)
- `lib.ts:205-229` → actual: 196-230 (off by ~9 at start)
- `adapter-claude.ts:55-75` → actual: 60-76 (off by ~5)

None of these affect the substance of Codex's claims; the referenced code is
at or immediately adjacent to the cited lines.

---

## 4. Gaps neither plan addressed

### 4.1 (CRITICAL) Test suite's pervasive `process.execPath` usage

Both plans mention updating test assertions in `dispatch.test.ts` and
`review-dispatch.test.ts`. But `process.execPath` appears in **14 test files
across 26 locations** (per my grep of `kit/hydra-ts/test/`). The scope is far
wider than either plan acknowledges:

**Assertion updates** (mock-based unit tests that check what command was
spawned):
- `dispatch.test.ts:358, 371, 406, 425` — assert spawned command is
  `process.execPath` with `--experimental-strip-types` + `.ts` path
- `adapter-claude.test.ts:217, 234`
- `e2e.full-loop.test.ts:188`

**Real subprocess spawns** (integration tests that actually execute Node to
run TS source):
- `dispatch.test.ts:879` — `spawnSync(process.execPath,
  ['--experimental-strip-types', dispatch.ts])` to test CLI usage errors
- `dispatch.test.ts:1376` — `spawn(process.execPath,
  ['--experimental-strip-types', helperPath, ...])` for background dispatch
- `status.test.ts:585` — `spawnSync(process.execPath,
  ['--experimental-strip-types', status.ts])` for status CLI tests
- `e2e.full-loop.test.ts:162-194` — asserts the TS adapter step spawns only
  `process.execPath` (Node), with explicit comment: "TS adapter step must
  spawn only node"

**nodeExecutable injection** (tests that pass `process.execPath` as the
`nodeExecutable` option to verify TS adapter behavior):
- `allocate.test.ts:272, 298, 315, 338`
- `aggregate-usage.test.ts:414, 439`
- `herdr-push.test.ts:832, 854`
- `verify.test.ts:114`
- `integrate.test.ts:519`
- `measure-divergence.test.ts:313, 331`
- `record-review.test.ts:367`
- `review-required.test.ts:153`
- `graphify-baseline.test.ts:180`
- `review-dispatch.test.ts:684`

In a compiled binary, `process.execPath` would be the binary itself, not Node.
The `--experimental-strip-types` flag would not exist. The integration tests
that spawn real Node subprocesses to run TS source cannot work without
fundamentally different fixtures—they need to either (a) spawn the compiled
binary's subcommand instead, or (b) retain a separate Node-spawning test lane.
Neither plan quantifies this scope or proposes a concrete fixture strategy.

This is the single largest undocumented migration cost.

### 4.2 The 673-test suite itself cannot run under `bun test`

Both plans propose adding a `bun test` lane, but `package.json:10-11` runs
tests via `node --experimental-strip-types --test $(find test -name
'*.test.ts' ...)`. The tests import `node:test` and `node:assert/strict`.
Bun's `node:test` support is documented as partial. Neither plan quantifies
how many of the 673 tests would actually run under `bun test`, or what the
runner-adapter shim would look like. Codex at least flags this as spike item
#9; Kimi mentions it as spike item #5 without noting that the test runner
itself is the gating dependency for the entire transition.

### 4.3 Bash adapter files as a deployment dependency

Both plans say `HYDRA_HARNESS=bash` remains as a frozen fallback. But the bash
vendor adapters (`kit/hydra/adapters/claude.sh`, `codex.sh`, `kimi.sh`,
`opencode.sh`) invoke vendor CLIs, `jq`, `git`, and other external tools. If
the compiled binary is distributed as a standalone file without the kit tree,
the `HYDRA_ADAPTER_RUNTIME=bash` rollback path would fail with "no adapter for
vendor." Neither plan addresses this: the compiled binary's "one file, no kit
tree" value proposition and the bash fallback's "needs adapter files on disk"
requirement are in tension.

Codex partially addresses this by saying "An explicit mixed
`HYDRA_ADAPTER_RUNTIME=bash` may still locate checkout-owned shell adapters;
validate that path and emit a clear error if the executable was distributed
without the kit tree." But this still means bash fallback is not a true
no-kit rollback, weakening the rollback story.

### 4.4 `promote.sh` and `record-review.sh` bare `node` calls in bash mode

Codex catches this (point 12: `promote.sh:58` calls bare `node` for
`jsonschema.mjs`, `record-review.sh:33` does the same). I verified both. This
means `HYDRA_HARNESS=bash` is NOT a Node-free path. The compiled binary's
`promote` and `record-review` subcommands would need to implement JSON schema
validation internally (or embed a validator). Neither plan proposes a concrete
solution for this; Codex at least documents it as a known limitation.

### 4.5 Process-group and signal semantics under Bun

Both plans list signal handling as a spike item, but neither addresses a
specific subtlety: `killTree` (`lib.ts:196-230`) uses `pgrep -P` to find
children, then signals them recursively. This is a macOS/Linux process-group
operation that depends on OS behavior, not Node/Bun behavior. It should work
identically under Bun. But `dispatch.ts:386-388` installs `SIGINT`/`SIGTERM`/
`SIGHUP` handlers via `process.on(name, onSignal)` and calls `process.exit(130)`.
Bun's signal handler behavior in a compiled binary needs specific verification
for the exit-code-preservation contract (the sentinel and ledger must be
written before exit). This is release-blocking and neither plan prioritizes it
sufficiently.

---

## 5. Recommended path forward

### 5.1 Follow Codex's architecture

Codex's plan is substantially stronger. It is more thorough, identifies more
real issues (resume detection, BUN_BE_BUN, embedded assets, doctor port,
signing, autoload risk), has a more detailed CI/rollout plan, and its line
references are consistently accurate. Kimi's plan is a competent high-level
design doc but reads as a first pass—it misses several issues that are
directly visible in the source code and proposes at least one broken code
change (Section 3.3 above).

**Use Codex's plan as the implementation blueprint.** Borrow Kimi's cleaner
`HYDRA_HARNESS` preamble example (it's more readable) and Kimi's point about
the stale-node PATH-shadowing bug being the motivating problem (Section 9 of
Kimi's plan is well-articulated and correct).

### 5.2 Concrete first spike: `process.execPath` + self-re-exec + `__adapter` subcommand

**The highest-leverage spike is verifying that `process.execPath` inside a
`bun build --compile` binary points to the binary itself, and that the binary
can spawn itself with a subcommand.** This is spike items #1 and #4 from
Codex's list (and #2 and #3 from Kimi's), and it is the foundation of the
entire architecture.

If `process.execPath` is NOT the binary, the self-re-exec design collapses,
and the migration needs a fundamentally different approach (separate adapter
binaries, or in-process adapter calls losing subprocess isolation). Every
other spike—embedded assets, signal handling, Unix sockets, `node:test`
parity—is solvable with known techniques. The self-re-exec mechanism is the
load-bearing wall.

**Specific spike scope:**
1. Build a trivial `cli.ts` that prints `process.execPath`, `process.argv[0]`,
   `process.argv[1]`, and `import.meta.url`.
2. Compile with `bun build --compile --target bun-darwin-arm64 --outfile
   /tmp/hydra-spike`.
3. Run it normally, via symlink, and after `cp` to a different directory.
4. Add a `__adapter` subcommand that prints its argv.
5. Have the main path `spawn(process.execPath, ['__adapter', 'stub', 'test'])`
   and verify the child's argv, exit code, and PID relationship.
6. Set `BUN_BE_BUN=1` and re-run to verify Codex's concern.

**Estimated effort:** 1-2 hours. **Uncertainty retired:** the entire
self-re-exec architecture (or a definitive "this doesn't work, use plan B").

---

## 6. Go / no-go recommendation

### **Conditional GO: proceed with the spike, defer production migration.**

**Why GO for the spike:** The stale-node PATH-shadowing bug is real and
documented (`ts-bash-switch.md:31`), and a compiled binary genuinely solves it.
The architecture is sound on paper, and both independent vendors converged on
the same design. The spike cost is trivial (hours) and retires the biggest
unknown.

**Why NOT GO for production migration yet:** Three factors give pause:

1. **dispatch.ts's child-spawning behavior is the heart of the system.** The
   entire dispatch → adapter → vendor CLI chain depends on `spawn`/`spawnSync`
   semantics, signal propagation, PID tracking, sentinel files, and kill-tree
   escalation working identically under Bun. There are 673 tests, and as
   shown in Section 4.1, at least 26 test locations use `process.execPath` in
   ways that would need reworking. The migration touches the most
   safety-critical code in the harness.

2. **The test runner problem is unsolved.** The 673-test suite uses
   `node:test`, which Bun only partially supports. Until the test count
   matches under `bun test`, there is no automated regression guard for the
   compiled binary. This is a prerequisite, not a follow-up.

3. **Kit-asset embedding is underdesigned.** Eight commands derive paths from
   `import.meta.url` to find kit-owned data files. Codex proposes embedding
   them, but the `/$bunfs/` read behavior, especially for YAML files read with
   synchronous `node:fs`, is unverified. A failure here would cause silent
   data corruption (e.g., allocation profiles not found → degraded
   allocation), not a crash.

**Recommendation:** Do the spike (Section 5.2). If `process.execPath`
self-re-exec works, do a Stage 0 implementation behind `HYDRA_HARNESS=bin`
(Codex's Stage 0) covering only the stub adapter and a handful of read-only
subcommands (`status`, `doctor`). Run it alongside the TS harness for at least
one full run cycle before expanding to real vendor adapters. **Do not flip the
default until the 673-test suite has a passing Bun-compiled lane.**

---

## Appendix: claim verification summary

| Plan | Claim | Verified against | Result |
|------|-------|-----------------|--------|
| Codex | `dispatch.ts:1106-1110` derives `'bash'\|'ts'` from env | `dispatch.ts:1106-1110` | Correct |
| Codex | `dispatch.ts:1115-1122` resolves adapters via `import.meta.url` | `dispatch.ts:1115-1122` | Correct |
| Codex | `dispatch.ts:800-823` plain worker spawn | `dispatch.ts:800-823` | Correct |
| Codex | `dispatch.ts:1206` defaults `nodeExecutable` to `process.execPath` | `dispatch.ts:1206` | Correct |
| Codex | `dispatch.ts:896-957` herdr pane wrapper assembly | `dispatch.ts:896-957` | Correct |
| Codex | `dispatch.ts:460-484` resume detection reads adapter source | `dispatch.ts:460-484` | Correct |
| Codex | `lib.ts:196-230` `killTree` recursive + delayed SIGKILL | `lib.ts:196-230` | Correct (cited as 205-229) |
| Codex | `lib.ts:379-412` Unix-socket Herdr state | `lib.ts:379-412` | Correct |
| Codex | `promote.sh:58` bare `node` for `jsonschema.mjs` | `promote.sh:58` | Correct |
| Codex | `record-review.sh:33` bare `node` for `jsonschema.mjs` | `record-review.sh:33` | Correct |
| Codex | `graph-impact.ts:30-33` locates `freshness-gate.sh` via `import.meta.url` | `graph-impact.ts:30-33` | Correct |
| Codex | No `doctor.ts` exists | glob `kit/hydra-ts/src/doctor.ts` → no match | Correct |
| Codex | `dispatch.sh:20-22` TS preamble | `dispatch.sh:20-23` | Correct |
| Kimi | `dispatch.ts:814-817` adapter command construction | `dispatch.ts:814-817` | Correct |
| Kimi | `dispatch.ts:925-935` herdr pane adapterArgs | `dispatch.ts:925-935` | Correct |
| Kimi | `dispatch.ts:1278` `isMain` | `dispatch.ts:1278` | Correct |
| Kimi | `dispatch.ts:819` `detached: false` | `dispatch.ts:819` | Correct |
| Kimi | `dispatch.ts:386-388` SIGINT/SIGTERM/SIGHUP handlers | `dispatch.ts:386-388` | Correct |
| Kimi | `lib.sh:67-118` `hydra_resolve_node` | `lib.sh:67-118` | Correct |
| Kimi | Base commit `6a1d2b16...` | Actual base: `066e9226...` | **Wrong** |
| Kimi | Section 2 proposed code replacement is valid | `dispatch.ts:814-817` existing code | **Broken** (see 3.3) |
| Kimi | Section 4 wrapper is the single herdr form | `dispatch.ts:939-956` has two forms | **Incomplete** |
