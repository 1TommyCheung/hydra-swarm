# Bun migration Stage 4 — runtime bug fixes (dispatch compiled runtime, herdr-push env strip, isCompiledBinary)

Run 0042, task `fix-compiled-dispatch`, branch `hydra/0042/fix-compiled-dispatch`
(base `446a3f4de06cac62a740f07db1c6b8e5f3119656`).

Fixes the three real bugs from the adversarial runtime review,
`docs/bun-migration-stage4-review-runtime.md` (run 0041).

**Finding about the review doc's location:** the task spec said the review was
"already merged to master", but it is NOT present at this branch's base
(`446a3f4`). It exists on the sibling branch `hydra/0041/review-runtime-changes`
at commit `4ea9cd9`; it was read from git (`git show
4ea9cd9:docs/bun-migration-stage4-review-runtime.md`) and treated as the spec
for the three bugs. No content from it was acted on beyond the task spec's own
instructions.

Environment notes for all verification below: machine-default `node` is v17
(cannot run the TypeScript test lane), so every test run used nvm Node
**v22.14.0** explicitly — the same version the review used. `bun` is NOT
available in this sandbox, and `tsc` is not installed (`npm run typecheck`
fails with `tsc: command not found`, same as the review recorded); neither was
faked.

## Bug 3 (fixed first — the other fixes depend on a trustworthy detector)

**Before** (`kit-assets.ts:37-39`): `isCompiledBinary()` decided solely from
`import.meta.url.startsWith('file:///$bunfs/')`. The review reproduced the
collision: a plain-Node checkout physically rooted at a root-level
`/$bunfs/...` path (legal, e.g. in a root-run container) produces module URLs
with the same prefix, so all 34 `!isCompiledBinary()` direct-invocation guards
were suppressed under ordinary Node.

**After** (`kit-assets.ts:36-56`): both conditions must hold —

```ts
export function isCompiledBinary(
  url: string = import.meta.url,
  versions: NodeJS.ProcessVersions = process.versions,
): boolean {
  return url.startsWith('file:///$bunfs/') && typeof versions.bun === 'string';
}
```

`process.versions.bun` is the Bun-specific runtime marker plain Node can never
satisfy, and it is Bun's OWN documented discriminator ("Check
`process.versions.bun` to detect whether code is running in Bun" —
<https://bun.com/docs/guides/util/detect-bun>, fetched 2026-07-15; bun was not
available in the sandbox to probe directly, so the fact was verified from Bun's
official documentation as the spec allowed). The zero-arg call signature is
unchanged for all 34 guard call sites; the parameters exist so tests can
simulate the exact collision without root access.

**Tests** (`test/kit-assets.test.ts:167-208`): the review's collision scenario
(`file:///$bunfs/checkout/...` URL + absent `versions.bun` → false), the real
compiled-binary shape (`/$bunfs` URL + `versions.bun` → true), and a Bun
runtime WITHOUT the synthetic prefix (ordinary `bun script.ts` → false).
Mutation check: against the pre-fix `kit-assets.ts` the BOTH-conditions test
fails; with the fix all 23 kit-assets tests pass.

## Bug 1 (the merge blocker): compiled dispatch can now launch an adapter

**Before** — the review's exact failing scenario, reproduced analytically and
against the pre-fix expression (output captured from a driver run, below):

1. `adapterRuntime` type was only `'bash' | 'ts'`; selection mapped every
   non-bash case — including `HYDRA_HARNESS=bin` — to `'ts'`
   (`resolveAdapterRuntime(undefined, 'bin', true)` equivalent: **`ts`**).
2. The `'ts'` path derived `adapter-<vendor>.ts` from
   `dirname(fileURLToPath(import.meta.url))` = the synthetic `/$bunfs/root`
   inside a compiled binary → `isFile()` false → `die("no adapter for vendor
   'claude': /$bunfs/root/adapter-claude.ts")`.
3. Even had the file existed, the spawn was `<process.execPath>
   --experimental-strip-types <adapterPath> ...`, and inside a compiled binary
   `process.execPath` IS the hydra-cli executable — so `cli.ts`'s router would
   have rejected `--experimental-strip-types` as an unknown subcommand.

**After** (`src/dispatch.ts`):

- New `AdapterRuntime = 'bash' | 'ts' | 'compiled'` (dispatch.ts:87), used by
  `DispatchOptions.adapterRuntime` and `WorkerContext.adapterRuntime`.
- New exported `resolveAdapterRuntime(override, harness, compiled)`
  (dispatch.ts:119), called from `dispatch()` with
  `isCompiledBinary()` (dispatch.ts:1137-1142). Precedence:
  1. an explicit `'bash'` override always wins — an operator may force the
     bash adapters even from a compiled binary (migration override-precedence
     convention);
  2. a real compiled binary, or an explicit `'compiled'` override, selects
     `'compiled'` — inside a compiled binary `'ts'` can never work, regardless
     of `HYDRA_HARNESS`/`HYDRA_ADAPTER_RUNTIME`;
  3. otherwise the legacy mapping applies verbatim (unknown values coerce to
     `'ts'`).
- New exported `COMPILED_ADAPTERS` static capability registry
  (dispatch.ts:98-105) mirroring cli.ts's fixed compile-time
  `adapter-<vendor>` route set 1:1 (`claude, codex, kimi, opencode, stub`)
  with each adapter's resume capability taken from its verb parser
  (`claude`/`stub`: start|resume; `codex`/`kimi`/`opencode`: no resume).
- Vendor gate (dispatch.ts:1153-1161): for the compiled runtime there is NO
  adapter file probe (nothing to stat at `/$bunfs/root`); an unknown vendor
  dies with `no adapter for vendor '<v>': the compiled binary only routes
  adapter-claude, adapter-codex, adapter-kimi, adapter-opencode, adapter-stub`.
- `runWorkerPlain` (dispatch.ts:811-825): the compiled branch spawns
  `process.execPath` with argv `['adapter-<vendor>', <verb>, <taskSpec>,
  <worktree>, <inbox>, <sessions>, <agentRunId>, <priorSession>]` — the same
  argument sequence the `'ts'` runtime builds, routed through cli.ts's
  ALREADY-EXISTING `adapter-<vendor>` subcommand (self-reexec premise shared
  with Stage 0's `bin-cli.ts` `selfReexec`). The spawn keeps `env: ctx.env`,
  so the in-place `delete env.BUN_BE_BUN` at dispatch.ts:1131 covers the
  self-reexec: a leaked `BUN_BE_BUN=1` would hijack the re-exec'd binary into
  Bun's own CLI instead of Hydra.
- `runWorkerInHerdrPane` (dispatch.ts:936-949): substitutes the shell-quoted
  `'<self>' 'adapter-<vendor>'` pair for the adapter file path in the SAME
  pane command structure (pidfile/banner/sentinel protocol, progress tail,
  and verb/args sequence unchanged — plan-codex: "Only the adapter command
  changes"). The pane command is delivered through `RealHerdrClient`, whose
  calls already strip `BUN_BE_BUN` (Stage 2).
- `determineDelivery` (dispatch.ts:540-568): for the compiled runtime, resume
  capability comes from the `COMPILED_ADAPTERS` registry instead of
  grep'ing an adapter source file that does not exist; the
  verb/prior-session semantics for the ts/bash runtimes are byte-for-byte
  unchanged.

**Before/after walkthrough of the review's scenario** (driver output, Node
v22.14.0, compiled shape simulated via `resolveAdapterRuntime`'s `compiled`
parameter and the fixed detector):

```text
OLD selection (compiled binary, HYDRA_HARNESS=bin): ts
OLD next hop: isFile(/$bunfs/root/adapter-claude.ts) -> false -> die "no adapter for vendor claude"
OLD fallback hop had it existed: spawn(dist/hydra-cli, ["--experimental-strip-types", ...]) -> cli.ts rejects unknown subcommand
---
NEW selection (compiled binary, HYDRA_HARNESS=bin): compiled
NEW selection (compiled binary, operator forces bash): bash
NEW argv (plain): [process.execPath, "adapter-claude", "start", <taskSpec> <worktree> <inbox> <sessions> <agentRunId> <priorSession>]
```

**Tests** (`test/dispatch.test.ts:466-672`): the `resolveAdapterRuntime`
precedence matrix (compiled detection beats `HYDRA_HARNESS`/`HYDRA_ADAPTER_RUNTIME`,
explicit bash force wins, legacy mapping unchanged incl. empty/garbage
coercion); plain-spawn argv for the compiled runtime including the exact
`adapter-claude start ...` sequence, `process.execPath` as command, env-object
identity and `BUN_BE_BUN` absence (parent env deliberately poisoned with
`BUN_BE_BUN=1`); per-vendor routing via `HYDRA_ADAPTER_RUNTIME=compiled`;
unknown-vendor rejection with no file probe (fixture adapter files exist and
are ignored); resume taken from the static registry (claude → `resume`,
codex → `start`); herdr-hosted pane command contains
`'<self>' 'adapter-claude' 'start'` and never `--experimental-strip-types`.
Mutation check: against the pre-fix `dispatch.ts` the new test file does not
even load (`resolveAdapterRuntime` not exported).

**Deferred end-to-end piece (not faked):** a real compiled-binary
dispatch-through-stub-adapter black-box run requires `bun build --compile`
output, which cannot be produced in this sandbox (no bun). The fixture IS
written — `test/dispatch.test.ts:608-672`, modeled on
`scripts/blackbox-compiled.ts`'s invocation style: it replays the review's
exact failing scenario (`HYDRA_HARNESS=bin <binary> dispatch <run> <task>`,
vendor stub, real git worktree, herdr absent → plain self-reexec path) and
asserts exit 0, the agent-run id on stdout, `agent_exited` with `exit_code 0`
in the ledger, and the stub `result.json` drop. It activates automatically
when `HYDRA_COMPILED_BINARY` or `dist/hydra-cli` exists and skips loudly
otherwise (`ok ... # SKIP no compiled binary at ... — run npm run build:bin
(requires bun)`). A follow-up task with bun access only has to build the
binary; no test changes needed.

## Bug 2: `herdr-push.ts` joins the `BUN_BE_BUN` spawn audit

**Before**: `defaultExec` (herdr-push.ts:60-65) passed no explicit env, so
every herdr call site (`status` probe :210, `pane list` :241, `pane rename`
:265, `notification show` :288, `agent list` :309) implicitly inherited a
possibly-poisoned `BUN_BE_BUN` — the review's scenario: with `BUN_BE_BUN=1`
and a Bun-compiled herdr, the probe child acts as the Bun CLI, the probe
fails, and Hydra silently falls back to `herdr-panes.json`. The Stage 2 audit
fixed this pattern in `dispatch.ts:142-196` and `review-dispatch.ts:70-75` but
missed this file.

**After** (herdr-push.ts:60-77): `defaultExec` extends whatever env the call
already builds and forces the strip, exactly the Stage 2 pattern:

```ts
env: { ...process.env, ...options?.env, BUN_BE_BUN: undefined },
```

One fix in `defaultExec` covers all five herdr call sites (and the git call)
because they all route through it.

**Test** (`test/herdr-push.test.ts:802-866`): no exec injection — the REAL
default runner drives a stub `herdr` executable on PATH that records, per
invocation, whether `BUN_BE_BUN` is observable in its environment, while the
parent env deliberately sets `BUN_BE_BUN=1`. The test asserts all five call
sites fired (`status`, `pane list`, `pane rename`, `notification show`,
`agent list`) and every child saw `BUN_BE_BUN` as absent. Mutation check:
against the pre-fix `herdr-push.ts` the test fails with `child saw BUN_BE_BUN:
status BUN_BE_BUN=present`; with the fix all 27 herdr-push tests pass.

## Verification (all runs: Node v22.14.0 via nvm, `kit/hydra-ts`)

This sandbox exhibits the environment-specific `.git`-write signature the
Stage 2 report documented: any `git init` under the worktree path fails with
`Operation not permitted` (macOS sandbox; `/tmp` works), so the suites with
in-worktree git fixtures fail independent of any code change. Baseline was
captured BEFORE any edit and the after-run failing-subtest lists diff
**IDENTICAL** in both lanes — zero regressions:

| Lane | Baseline (pre-fix) | After fix |
|---|---|---|
| concurrent (`test:concurrent`) | 808 tests / 733 pass / 72 fail / 3 cancelled | 818 tests / 742 pass / 72 fail / 3 cancelled / 1 skipped |
| promote (`test:promote`) | 27 tests / 2 pass / 25 fail | 27 tests / 2 pass / 25 fail |

The 10 new tests are all in the concurrent lane (7 dispatch + 2 kit-assets +
1 herdr-push); 9 pass and 1 (the compiled-binary e2e fixture) skips by design
— accounting exactly for 818/742/+1-skipped. The 72+3 and 25 failures are the
pre-existing environmental git-write cases; suites touching the changed files
are fully green: `dispatch Bash parity` (63), `herdrPush`+CLI (27),
kit-assets (23), cli router/route/end-to-end. `git diff --check` clean.
`npm run typecheck` unavailable (`tsc` not installed — recorded, not faked).

Mutation checks (each new test fails against its pre-fix source, passes after):
bug 1 (`resolveAdapterRuntime` missing pre-fix), bug 2 (`BUN_BE_BUN=present`
observed by the child pre-fix), bug 3 (BOTH-conditions test fails pre-fix).

## Follow-ups

- **Compiled-binary end-to-end dispatch black-box run** — the fixture at
  `test/dispatch.test.ts:608-672` needs a bun-built `dist/hydra-cli` (and
  should then also run under the herdr wrapper shape, plus the lead's Linux
  matrix from `docs/bun-migration-stage3-build-matrix.md`). Deferred to the
  lead / a follow-up task with Docker+bun access, exactly as the spec
  anticipated.
- **Whole-tree spawn-audit test** (review's "required next verification" for
  finding 2): a guard test so any NEW vendor/Hydra/Herdr child-spawn site
  cannot omit the explicit `BUN_BE_BUN` strip unnoticed. Not added here —
  outside this task's bug scope.
- **`COMPILED_ADAPTERS` drift**: the registry mirrors cli.ts's
  `adapter-<vendor>` routes and the adapters' verb parsers by construction;
  if a sixth adapter route is ever added, update the registry in the same
  change (a drift-guard test would be a reasonable addition with that change).
