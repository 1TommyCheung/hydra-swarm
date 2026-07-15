# Bun migration — Stage 2 spawn/env audit (run 0038, task spawn-env-audit)

Stage 1 Phase 2, lane 2 of 3 (accepted plan: `docs/bun-migration-plan-codex.md`).
This lane fixes the two independently-confirmed Bun runtime issues from the
spike rounds:

- **Part A** — `docs/bun-migration-spike-testing.md` item **#10.3**: under Bun,
  in-process `process.env` mutations are *not* inherited by spawned children
  (only the launch-time OS environ is), unless the call site passes an explicit
  `env:` option. Under Node, explicit `env: { ...process.env }` is
  behavior-identical to the implicit case.
- **Part B** — `docs/bun-migration-spike-results.md`: a compiled Bun binary run
  with `BUN_BE_BUN=1` in its environment never runs its own entry point — it
  runs Bun's generic CLI instead (total silent hijack). Mitigation pattern
  (already proven by `src/bin-cli.ts:25-30` and the spike's `spawn-strip`
  probe): pass `env: { ...process.env, BUN_BE_BUN: undefined }`; Bun omits
  `undefined`-valued env keys entirely, and this audit independently confirmed
  Node ≥22 does the same (probe output below).

Scope exclusions honored: `kit-assets.ts`, `kit/hydra/scripts/*.sh`,
`package.json` `build:bin` flags, and `src/graph-impact.ts` (parallel lanes own
those; graph-impact.ts's only spawn call is being removed by lane 1 in this
same run).

## Method

Every `spawn` / `spawnSync` / `execFileSync` call site in the nine writable
`src/` files was inventoried by grep, then each was classified:

- **Strip `BUN_BE_BUN`?** Needed where the spawned program could plausibly be a
  Bun-compiled executable: any vendor CLI (claude/codex/kimi/opencode), any
  self-invocation of hydra tooling (herdr, compiled adapter binaries), and
  external tool CLIs (graphify). Not needed for pure `git`/`pgrep`/system-binary
  calls — those cannot be hijacked by `BUN_BE_BUN`, and adding the option there
  would be pointless churn.
- **Explicit `env` passthrough?** Needed where correctness depends on
  in-process `process.env` mutations reaching the child (the #10.3 gap). Not
  needed where no such dependency exists.

## Call-site audit table

Line numbers are post-change, from grep on the edited tree.

| # | Site (file:line) | Spawned program | Strip `BUN_BE_BUN`? | Explicit `env` passthrough? | Action |
|---|---|---|---|---|---|
| 1 | `audit-ownership.ts:101` (`run` helper → `execFileSync`, env at :109) | `git -C <wt> rev-parse --git-dir` | **No** — git is not a Bun binary | **Yes** — the #10.3 finding: `GIT_CEILING_DIRECTORIES` set in-process must reach git or the not-a-git-worktree guard silently passes | **Fixed:** `env: { ...process.env }` added |
| 2 | `audit-ownership.ts:134` (`diff --name-status`, env at :139) | `git` | No — git | Yes — same gap class as #1; all git calls in one audit run must see a consistent environment (e.g. the same ceiling), otherwise results diverge between runtimes | **Fixed:** `env: { ...process.env }` added |
| 3 | `audit-ownership.ts:157` (`ls-tree`, env at :165) | `git` | No — git | Yes — same reasoning as #2 | **Fixed:** `env: { ...process.env }` added |
| 4 | `audit-ownership.ts:177` (`ls-files`, env at :188) | `git` | No — git | Yes — same reasoning as #2 | **Fixed:** `env: { ...process.env }` added |
| 5 | `audit-ownership.ts:195` (`diff --name-only`, env at :209) | `git` | No — git | Yes — same reasoning as #2 | **Fixed:** `env: { ...process.env }` added |
| 6 | `adapter-claude.ts:65` (`defaultRunCommand` → `spawnSync`, env at :70) | `claude` vendor CLI | **Yes** — vendor CLI may be Bun-compiled | n/a — env is now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 7 | `adapter-codex.ts:140` (`defaultExec` → `execFileSync`) | `git` only (callers at :270, :283, :296, :389 and `deriveDropFromGitWithExec`; the codex CLI flows through `defaultSpawn`, #8) | **No** — pure-git runner in this file | No — no caller depends on in-process env mutations | Left unchanged (documented) |
| 8 | `adapter-codex.ts:164` (`defaultSpawn` → `spawnSync`, env at :169) | `codex` vendor CLI (`runSpawn('codex', ...)` at :401) | **Yes** — vendor CLI | n/a — env now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 9 | `adapter-kimi.ts:58` (`defaultCommandExists` → `execFileSync`) | `/bin/sh -c 'command -v …'` | **No** — system binary, not Bun-compiled | No — no env-mutation dependency | Left unchanged (documented) |
| 10 | `adapter-kimi.ts:344` (`runStreaming` → `options.spawn`, env at :349) | `kimi` CLI directly (:434) and `srt -s … -c <kimi…>` (:569) — srt inherits this env, so the strip covers the wrapped kimi child too | **Yes** — vendor CLI (direct and srt-wrapped) | n/a — env now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 11 | `adapter-kimi.ts:503` (`exec` → `execFileSync`) | `git rev-parse --git-common-dir` | **No** — git | No — no env-mutation dependency | Left unchanged (documented) |
| 12 | `adapter-opencode.ts:129` (`runStreaming` → `options.spawn`, env at :133) | `opencode` vendor CLI (:347, :504) | **Yes** — vendor CLI | n/a — env now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 13 | `dispatch.ts:141` (`RealHerdrClient.isLive` → `run('herdr', …)`, env at :144) | `herdr` (hydra's own pane tooling; `agent start` hosts the vendor worker inside the pane and herdr's env propagates to it) | **Yes** — self-invocation of hydra tooling | n/a — env now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 14 | `dispatch.ts:154` (`focusedWorkspace`, env at :157) | `herdr pane list` | **Yes** — same as #13 | n/a | **Fixed:** same pattern |
| 15 | `dispatch.ts:178` (`agentStart`, env at :181) | `herdr agent start … -- bash -lc <worker command>` — the pane path that hosts vendor CLIs | **Yes** — same as #13; highest-value site (vendor child inherits herdr's env) | n/a | **Fixed:** same pattern |
| 16 | `dispatch.ts:192` (`paneClose`, env at :195) | `herdr pane close` | **Yes** — same as #13 | n/a | **Fixed:** same pattern |
| 17 | `dispatch.ts:253` (`discoverRepoRoot`) | `git rev-parse --show-toplevel` | **No** — git | No — no env-mutation dependency | Left unchanged (documented) |
| 18 | `dispatch.ts:757` (`runWorkerPlain` → `ctx.spawn`, worker process) | `node --experimental-strip-types <adapter.ts>` (ts runtime) **or the adapter path directly** (bin runtime = compiled binary, i.e. hydra self-invocation) | **Yes** — self-invocation when `adapterRuntime: 'bin'` | Already explicit (`env: ctx.env`); the strip had to preserve object identity — `dispatch.test.ts:345` asserts `mock.calls[0].options?.env === options.env` by reference | **Fixed:** `delete env.BUN_BE_BUN` in place at `dispatch.ts:1051`, right where `env` is resolved (`options.env ?? process.env`); mirrors `bin-cli.ts`'s startup delete and is effective under Bun because the spawn passes the object explicitly |
| 19 | `graphify-repo.ts:117` (`defaultRunCommand` → `spawn`, env at :122) | `graphify` external CLI (:262, all verbs) **and** `git` (:269, :295) through the same shared runner | **Yes** — runner is not git-only; `graphify` is an external, not-fully-trusted CLI that could be Bun-compiled | Already explicit (`env: options.env`); extended, not replaced | **Fixed:** `env: { ...options.env, BUN_BE_BUN: undefined }` |
| 20 | `lib.ts:35` (`repoRoot`) | `git rev-parse --show-toplevel` | **No** — git | No | Left unchanged (documented) |
| 21 | `lib.ts:136, :147, :158` (`worktreeChanged` helpers) | `git rev-parse` / `git diff` | **No** — git | No | Left unchanged (documented) |
| 22 | `lib.ts:199` (`killTree`) | `pgrep -P` | **No** — pgrep | No | Left unchanged (documented) |
| 23 | `lib.ts:243` (`withTimeout` → `spawn(command, args, { stdio: 'inherit' })`) | arbitrary caller-supplied command | **No** — generic exported helper with **no production callers** anywhere in `src/` (only re-exported at `lib.ts:569`); no vendor/self invocation flows through it today | No — implicit env retained to avoid behavior churn for an unused-in-production helper | Left unchanged (documented); revisit if a production caller appears |
| 24 | `verify.ts:145` (`defaultRunCommand` → `spawn('env', ['-i', …, 'bash', …])`) | `env`/`bash` running sandboxed verify commands | **No** — the child env is already a scrubbed allowlist (`verify.ts:99-108`: PATH/HOME/LANG + `HYDRA_SANDBOX`/`NO_NETWORK`, passed via `env -i`), so `BUN_BE_BUN` cannot propagate through the default path | No — env is explicit and scrubbed by design | Left unchanged (documented) |
| 25 | `review-dispatch.ts:69` (`defaultExec` → `spawnSync`, env at :74) | `herdr` (:254, :277, :298, :456 — hydra self-tooling) and `bash -lc <vendor CLI>` (:467 — wraps claude/codex/kimi/opencode commands built by `vendorCommand`) | **Yes** — vendor CLIs via the bash wrapper, plus herdr self-invocation | n/a — env now explicit via the strip | **Fixed:** `env: { ...process.env, BUN_BE_BUN: undefined }` added |
| 26 | `review-dispatch.ts:314` (`spawnSync('sleep', …)`) | `sleep` system binary | **No** — system binary, not Bun-compiled | No | Left unchanged (documented) |

## Part A — resolution of spike item #10.3

`auditOwnership`'s `git rev-parse --git-dir` probe (site #1) now passes
`env: { ...process.env }`, so in-process mutations such as
`GIT_CEILING_DIRECTORIES` reach the git child under Bun exactly as they do
under Node. Sites #2–#5 received the same option so every git invocation in a
single audit run sees a consistent environment across runtimes (the
`ExecLike` options type gained `env?: NodeJS.ProcessEnv`; test-injected exec
mocks remain assignable and simply pass the option through). **No** `BUN_BE_BUN`
strip was added here: git cannot be hijacked by it (spec: pure-git call sites
must be left alone).

Confirmation:

- `node --experimental-strip-types --test --test-name-pattern="not a git repository" test/audit-ownership.test.ts`
  → `ok 1 - throws when the worktree is not a git repository` (1 pass / 0 fail)
  — the security-relevant throw still happens.
- Manual micro-probe (same methodology as the spike's `sh -c 'echo $VAR'`
  probe; mutates `process.env` after process start, then spawns a child):

```json
{"probe":"env-passthrough","runtime":"v22.14.0","with_explicit_env":"mutated-after-start","implicit_env":"mutated-after-start"}
{"probe":"bun-be-bun-strip","child_sees":"unset"}
```

  Read: with `env: { ...process.env }` the child sees the post-start mutation
  (`mutated-after-start`), identical to Node's implicit behavior — so the fix
  is a no-op under Node and closes the Bun gap. And
  `env: { ...process.env, BUN_BE_BUN: undefined }` with `BUN_BE_BUN=1` set
  in-process leaves the child seeing `unset` — Node omits `undefined`-valued
  env keys exactly as Bun does, so the strip pattern is safe cross-runtime.

## Part B — strip coverage summary

All vendor CLI spawns (claude #6, codex #8, kimi direct+srt-wrapped #10,
opencode #12, plus the `bash -lc` vendor wrapper and herdr calls in
review-dispatch #25), all herdr self-tooling calls (#13–#16), the dispatch
worker-process spawn (#18), and the external `graphify` runner (#19) now strip
`BUN_BE_BUN` via the `bin-cli.ts` pattern. Existing env customization was
extended, never clobbered (`graphify-repo.ts` spreads `options.env`;
`dispatch.ts` keeps passing `ctx.env` by reference). Pure `git`/`pgrep`/
system-binary sites (#1–#5, #7, #9, #11, #17, #20–#22, #26), the scrubbed-env
verify runner (#24), and the callerless `withTimeout` helper (#23) were
deliberately left alone with reasons above.

Residual note for the router lane: `dispatch.ts:1051`'s in-place delete covers
the worker spawn because `runWorkerPlain` passes that exact object; the herdr
pane path is covered by the explicit per-call strips (#13–#16). When the
compiled router lands, keep `bin-cli.ts`'s startup `delete process.env.BUN_BE_BUN`
as the outermost belt to these suspenders.

## Verification performed

Full suite: `cd kit/hydra-ts && npm test`
(`node --experimental-strip-types --test …`, Node v22.14.0).

- **Environment caveat:** this worker's shell sandbox blocks writes to
  `**/.git/config` and `**/.git/hooks/**` inside the worktree (deliberate
  harness guard), so every test that runs `git init` fails with
  `fatal: could not write config file … Operation not permitted` /
  `cannot copy …/templates/hooks/* … Operation not permitted` — at the base
  commit, with no edits. Baseline: 787 tests discovered by `test:concurrent`
  (plus promote tests in `test:promote`; the spec's 789 total), 712 pass,
  72 fail, 3 cancelled, failing suites: adapter-claude, kimiStart,
  auditOwnership, freshnessGate, indexCandidate, integrate, deriveDropFromGit,
  reviewDispatch, squash, status.sh bash fallback — all git-init-dependent.
- **After the changes: identical totals and identical failing suites**
  (787 / 712 / 72 / 3). For the four failing suites whose source files this
  lane edited (adapter-claude, adapter-kimi, audit-ownership, review-dispatch),
  subtest-level failure lists were captured before and after
  (`git checkout` baseline vs edited tree) and `diff`ed: **byte-identical — zero
  regressions and zero collateral fixes**. All suites this lane touched that
  can run in the sandbox (dispatch, adapter-codex, adapter-opencode,
  graphify-repo, verify, lib) pass in full.
- The item-#10.3 test was additionally run standalone and passes (above).
- `npm run typecheck` could not run here: the worktree has no `node_modules`
  and the npm registry returns 403 in this sandbox; installing would also have
  polluted the worktree outside this lane's writable paths. All edits are
  type-conservative (`env?: NodeJS.ProcessEnv` already accepted by every
  touched options type) and are exercised at runtime by the suite.
