# Bun migration — Stage 1, Phase 1b: single-entry CLI router (`src/cli.ts`)

Run 0037, task `build-cli-router`, branch `hydra/0037/build-cli-router`
(base `0d9b6920270c8e0903068b9f23aee3be581d9830`).

Builds the single real entry point required by `docs/bun-migration-plan-codex.md`
("Public router") and the spike #2 finding (`docs/bun-migration-spike-adapters.md`):
under `bun build --compile` every module-level `isMain` guard in a bundle
evaluates **true** simultaneously, so the tree can never be compiled unmodified —
an explicit argv router is mandatory. Phase 1a (runs 0036, groups 1–3) already
normalized every CLI module to export `main(args): number | Promise<number>`;
this phase wires all of them into `kit/hydra-ts/src/cli.ts`.

Scope limits honored: `kit/hydra/scripts/*.sh` and the `HYDRA_HARNESS` switch
are **untouched**; `cli.ts` is exercised standalone via
`node --experimental-strip-types`. Compiled-binary testing is Phase 3.

## Subcommand table

Subcommand = module basename without `.ts`, invoked as
`cli.ts <subcommand> [args...]` with `process.argv.slice(3)` passed through
unchanged. Signatures per the Phase 1a group docs, re-verified by grep against
each source file.

| Subcommand | File | main() |
|---|---|---|
| `adapter-claude` | `src/adapter-claude.ts` | sync |
| `adapter-codex` | `src/adapter-codex.ts` | async |
| `adapter-kimi` | `src/adapter-kimi.ts` | async |
| `adapter-opencode` | `src/adapter-opencode.ts` | async |
| `adapter-stub` | `src/adapter-stub.ts` | sync |
| `aggregate-usage` | `src/aggregate-usage.ts` | sync |
| `allocate` | `src/allocate.ts` | sync |
| `amend-task` | `src/amend-task.ts` | async |
| `audit-ownership` | `src/audit-ownership.ts` | sync |
| `build-worker-prompt` | `src/build-worker-prompt.ts` | sync |
| `cancel-task` | `src/cancel-task.ts` | async |
| `code-intel` | `src/code-intel.ts` | sync |
| `create-worktree` | `src/create-worktree.ts` | sync |
| `dispatch` | `src/dispatch.ts` | async |
| `freshness-gate` | `src/freshness-gate.ts` | sync |
| `graph-impact` | `src/graph-impact.ts` | sync |
| `graphify-baseline` | `src/graphify-baseline.ts` | sync |
| `graphify-investigate` | `src/graphify-investigate.ts` | sync |
| `graphify-repo` | `src/graphify-repo.ts` | async |
| `herdr-push` | `src/herdr-push.ts` | sync |
| `index-candidate` | `src/index-candidate.ts` | sync |
| `integrate` | `src/integrate.ts` | async |
| `ledger-view` | `src/ledger-view.ts` | sync |
| `measure-divergence` | `src/measure-divergence.ts` | sync |
| `otel-env` | `src/otel-env.ts` | sync |
| `promote` | `src/promote.ts` | async (`main(args, options = {})` — router passes only `args`) |
| `record-review` | `src/record-review.ts` | sync |
| `record-usage` | `src/record-usage.ts` | sync |
| `review-dispatch` | `src/review-dispatch.ts` | sync |
| `review-required` | `src/review-required.ts` | sync |
| `run-init` | `src/run-init.ts` | sync |
| `squash` | `src/squash.ts` | sync |
| `status` | `src/status.ts` | sync |
| `verify` | `src/verify.ts` | async |

**Count note:** the task spec says "33 files" but its own list enumerates
**34** names (29 non-adapter + 5 adapters); all 34 exist in `src/` with a
conformant exported `main()`, and all 34 are routed.

## Adapter special-casing

The five `adapter-*.ts` modules are not invoked by subcommand name anywhere in
the harness today: `dispatch.ts` selects `adapter-<vendor>.ts` by vendor
(`dispatch.ts:1046-1048`) and spawns it standalone as
`node --experimental-strip-types adapter-<vendor>.ts <verb> <args...>`
(`dispatch.ts:731-743`, `:851-853`), i.e. the verb is `args[0]` inside each
adapter's `main()`. The router preserves that exact shape with zero
indirection:

```
cli.ts adapter-claude start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session_id]
cli.ts adapter-codex  start <task_spec> <worktree> <inbox> <sessions> <agent_run_id>
cli.ts adapter-kimi   visual|start ...
cli.ts adapter-opencode explore|review|start ...
cli.ts adapter-stub   start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]
```

No `__adapter <vendor> <verb>` form was invented: nothing in the existing code
expects one (the `__adapter` stub in `src/bin-cli.ts` is the Stage 0
self-re-exec spike harness, not a real adapter dispatch path, and is left
untouched).

## Script-name cross-check vs `kit/hydra/scripts/*.sh`

`kit/hydra/scripts/` holds 28 subcommand wrappers (plus non-CLI support files
`lib.sh` and `jsonschema.mjs`). All 28 names line up 1:1 with routed
subcommands. Findings on the exceptions:

- **`build-worker-prompt`** has **no** `kit/hydra/scripts/build-worker-prompt.sh`.
  Its bash wrapper lives at `kit/hydra/adapters/build-worker-prompt.sh` and is
  called internally by the vendor adapters (`adapters/claude.sh:34`,
  `codex.sh:26`, `opencode.sh:55`, `kimi.sh:88`) and by
  `scripts/dispatch.sh:142` — it is a library-style helper, never a top-level
  operator subcommand. It is still routed (spec list includes it), which is
  harmless and keeps the table complete.
- The accepted plan's router table (`bun-migration-plan-codex.md:135-145`) also
  lists a **`doctor`** subcommand; no `src/doctor.ts` exists yet, so it is out
  of this task's 34-file list and is expected to arrive with the later
  doctor-port phase.

## isMain-guard count in `cli.ts`

`cli.ts` has **exactly one** top-level `isMain` guard, in the Phase 1a
reference shape (`import.meta.url === pathToFileURL(resolve(process.argv[1])).href`,
guard body `process.exitCode = await route(process.argv.slice(2))`).

Verified empirically under Node v24.16.0 (non-compiled, per the task's step 5 —
the compile step itself is Phase 3 scope):

- Direct run routes correctly: `node --experimental-strip-types
  kit/hydra-ts/src/cli.ts status --help` from the repo root prints
  **status.ts's own** usage error (`hydra: error: usage: status <run_id>
  <task_id> [--lines N] [--json]`, exit 1), not the router's usage banner —
  the guard fires for `cli.ts` and dispatch reaches `status.ts`'s `main()`.
- The 34 imported modules' guards stay dormant under Node because `argv[1]` is
  `cli.ts`, so their `import.meta.url` comparisons are false (confirmed by the
  byte-identical stdout/stderr diffs in the verification section — no module
  ran its guard body at import).
- Imported as a module (the test suite), `cli.ts`'s own guard is dormant:
  `import { route } from '../src/cli.ts'` produces no CLI output and no exit
  code mutation.

Consequence for Phase 3 (already implied by plan line 150-152, "do not assume
bundled `import.meta.url` comparisons will keep every imported module's current
`isMain` block dormant"): in a compiled bundle **all 35** guards (34 modules +
`cli.ts`) will evaluate true per spike #2. `cli.ts`'s own guard firing is
desired; the other 34 firing their `process.exitCode = main()` bodies at import
time is not, so a build-time guard neutralization step remains required before
`bun build --compile`. This task does not attempt it.

## Router behavior contract

- `route(argv, registry?)` (exported for tests): looks up `argv[0]`, calls the
  slot with `argv.slice(1)`, awaits sync or async results, returns the numeric
  exit code. The guard assigns it to `process.exitCode`.
- Unknown or missing subcommand: prints `Usage: hydra <subcommand>
  [args...]` plus the full 34-name listing to **stderr**, returns **1**
  (spec-mandated; note the Stage 0 `bin-cli.ts` spike used 2 — different
  program, deliberately not copied).
- Import-time side effects: none added; Phase 1a group docs audited all 34
  modules for dormant imports, so importing all of them in one module is safe.

## package.json

Added one script, none removed or changed:
`"build:cli-check": "node --experimental-strip-types src/cli.ts"` (prints the
usage listing and exits 1 — a fast smoke check that the router module loads
and all 34 imports resolve).

## Verification performed (advisory; harness re-verifies)

Environment: Node v24.16.0 via nvm (`/usr/local/bin/node` is v17.4.0 and
cannot run the suite — pre-existing PATH-shadowing note from the group docs),
macOS arm64, sandboxed worktree.

1. **Full suite, zero regressions** — `npm test` in `kit/hydra-ts`:
   - Baseline before any edit: **706 tests / 631 pass / 72 fail / 3 cancelled**.
     The spec's "708/708" does not reproduce in this sandbox: the 72 failures +
     3 cancellations are the pre-existing environmental signature documented in
     `docs/bun-migration-spike-testing.md` and both prior group docs (worktree
     `.git`-write EPERM in fixtures, `ps` visibility blocked, `.bash_profile`
     writes denied). Identical counts were reported by group 3's worker here.
     Because `test:concurrent` exits non-zero, `npm test` never reaches
     `test:promote` — also pre-existing.
   - After adding `test/cli.test.ts`: **787 tests / 712 pass / 72 fail /
     3 cancelled** = baseline + 81 new tests, all 81 passing. Failing-test name
     sets diffed before/after: **byte-identical**, zero regressions.
2. **`test/cli.test.ts` standalone** — 81/81 pass:
   - 34 table-identity tests (`routes[name] ===` the `main` imported from
     `<name>.ts`, cross-checked independently of cli.ts's own imports).
   - 34 dispatch tests (spy registry: the right slot receives
     `argv.slice(1)` unchanged, returns its code, and no other slot is
     called), plus sync/async return passthrough, unknown-subcommand (usage to
     stderr, exit 1), missing-subcommand, and usage-listing completeness.
   - 7 real child-process end-to-end tests cross-checking
     `node --experimental-strip-types src/cli.ts <sub> <args>` against direct
     `src/<file>.ts <args>` invocation byte-for-byte (stdout, stderr, exit
     code): `status` (sync, usage error), `otel-env` (sync, success output),
     `allocate` (sync, success JSON), `verify` (async, usage error),
     `adapter-claude` (sync adapter, usage error), `adapter-codex` (async
     adapter, usage error), and the unknown-subcommand case.
3. **Manual spot checks (spec step: 5+ subcommands, 2+ adapters)** — 9
   subcommands run both ways with stdout/stderr diffed and exit codes compared,
   9/9 identical: `status --lines not-a-number` (sync, exit 1), `otel-env`
   (sync, exit 0), `allocate implementer code_review high` (sync, exit 0,
   1002-byte JSON), `verify` (async, exit 1), `dispatch` (async, exit 1),
   `promote` (async, exit 2), `adapter-claude` (sync adapter, exit 1),
   `adapter-codex` (async adapter, exit 1), `adapter-stub` (sync adapter,
   exit 1).
4. **Unknown/missing subcommand** — `cli.ts bogus-cmd` and bare `cli.ts` both
   print the full 34-name usage listing to stderr, empty stdout, exit 1.
5. `npm run typecheck` not run: `node_modules` absent and the npm registry is
   unreachable from this sandbox (pre-existing restriction, same as groups
   1–3). All new code is loaded and exercised by the test runs above.
