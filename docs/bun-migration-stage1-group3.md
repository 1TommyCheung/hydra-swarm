# Bun migration Stage 1 — router normalization, group 3

Run 0036, task `router-normalize-group3`, branch `hydra/0036/router-normalize-group3`
(base `20cf6e014a079bb9a30ae8bc027ae2577b64583e`).

Mechanical normalization of the group-3 CLI modules so a future single CLI
router (a later task) can import every module and call an exported `main()`
instead of relying on guard-triggered side effects at import time. Background:
`docs/bun-migration-spike-adapters.md` spike #2 proved that under
`bun build --compile` every `isMain` guard in a bundle evaluates **true**, so
exporting a callable `main()` per file is mandatory. This change is a pure
refactor: zero behavior change under the existing Node lane
(`node --experimental-strip-types <file>.ts ...` and the bash wrappers).

Reference patterns followed exactly:

- synchronous: `kit/hydra-ts/src/status.ts:489-535`
- asynchronous: `kit/hydra-ts/src/promote.ts:507-528`

## Per-file results

| file | disposition | final exported `main` signature |
|---|---|---|
| `src/measure-divergence.ts` | **extracted** (argv/dispatch logic was inline in the guard) | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/review-dispatch.ts` | **extracted** + latent-bug fix (below) | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/otel-env.ts` | **signature alignment only** (see note) | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/promote.ts` | already conformant (reference pattern) | `export async function main(args: string[] = process.argv.slice(2), options: PromoteOptions = {}): Promise<number>` |
| `src/record-review.ts` | already conformant | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/record-usage.ts` | already conformant | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/review-required.ts` | already conformant | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/run-init.ts` | already conformant | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/squash.ts` | already conformant | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/status.ts` | already conformant (reference pattern) | `export function main(args: string[] = process.argv.slice(2)): number` (sync) |
| `src/verify.ts` | already conformant | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` |

Every conformant file was verified to return a numeric exit code (never calls
`process.exit()` internally) and to use the two-line guard
`if (isMain) { process.exitCode = main(); }` (or `await main()` for the async
pair). All argument parsing, flags, error texts, and exit codes are unchanged;
in the extracted files the only motion is that `process.argv.slice(2)` moved
into the `args` default and `process.exitCode = 1` in the inline catch became
`return 1` assigned by the same `process.exitCode = main()` guard.

### Note on `otel-env.ts`

It already exported `main(): number` — it takes no command-line arguments, so
the reference `args` parameter was absent. The signature was aligned to
`main(args: string[] = process.argv.slice(2)): number` so every group-3 module
exposes the identical router-callable shape. The parameter is intentionally
unused; the default is a pure read with no side effect, so direct invocation
(`main()` from the guard) and router invocation (`main(argv)`) behave exactly
as before. `tsconfig.json` does not enable `noUnusedParameters`, so this is
type-clean.

## `review-dispatch.ts` ENOENT status-check fix

`defaultExec` (`src/review-dispatch.ts:76`) checked `result.status !== null`.
Per `docs/bun-migration-spike-testing.md` item #9 finding #1, under Bun a
`spawnSync` spawn error (ENOENT/EACCES) produces `status: undefined`, not
`null`, so the check would take the wrong branch and compute
`exitCode = undefined` instead of 127 for a missing vendor executable. Changed
to loose `if (result.status != null)`, which is falsy for both `null` (Node)
and `undefined` (Bun). Under Node this is behavior-identical: a spawn error
yields `status: null` today, so `!= null` is false exactly where `!== null`
was false; a numeric status (including `0`) still takes the first branch; a
signal death (`status: null`, `signal` set) still falls to the `128 + signo`
branch.

## Top-level import-time side-effect audit

For each of the 11 group-3 files, everything at module top level outside the
`isMain` guard is one of: `import` declarations, `const` declarations of plain
data (`OTEL_DEFAULT_ENDPOINT`, `TERMINAL_EVENTS`,
`DISPATCH_PIDFILE_GRACE_SECONDS`, default-export object literals), type
declarations, function declarations, and the pure `isMain` computation
(`process.argv[1]` / `import.meta.url` comparison — no I/O). **No file in this
group runs any code with side effects at import time.** A router can import
all 11 together safely. Transitive imports (`lib.ts`, `verify.ts`,
`audit-ownership.ts`, etc.) were spot-checked (`lib.ts` has no unconditional
top-level statements either) but a full audit of non-group modules is outside
this task's scope.

## Verification performed (this environment)

Node `v24.16.0` via nvm; the default `/usr/local/bin/node` is v17.4.0 and
cannot run the suite (pre-existing PATH-shadowing issue documented in
`skills/hydra-swarm/references/ts-bash-switch.md:31`).

- **Full suite, baseline (before edits):** `npm run test:concurrent` →
  706 tests, 631 pass, 72 fail, 3 cancelled. The 72 failures + 3 cancellations
  are the sandbox-environment failures recorded in
  `docs/bun-migration-spike-testing.md` (git-init EPERM in worktree fixtures,
  `ps` blocked, `.bash_profile` writes EPERM). Because the concurrent lane
  exits non-zero here, `npm test` never reaches `test:promote`; run standalone
  it gives 27 tests / 2 pass / 25 fail, matching the spike doc's environmental
  signature.
- **Full suite, after edits:** identical counts (706 / 631 / 72 / 3) and an
  identical set of failing test names (diffed with timings stripped). Zero
  regressions.
- **`test/review-dispatch.test.ts` before/after:** 29 tests, 27 pass, 2 fail
  both times. The 2 failures (`records 127 when the vendor executable is
  missing`, `runs the CLI entry point through a login shell`) fail at fixture
  setup with `EPERM` writing `.bash_profile` under the sandboxed worktree —
  before any behavior under test runs — and are identical before and after.
  The unit test that directly covers the line-76 branch,
  `defaultExec > returns 127 when the executable is missing`, **passes** under
  Node before and after the fix (as do `uses the shell 128+signal exit-code
  convention` and the rest of the `defaultExec` suite).
- **Manual CLI invocations (byte-compare pre vs post, same args/env):**
  - `src/measure-divergence.ts` with an empty `HYDRA_STATE_ROOT` → stderr
    `hydra: error: no runs found under .../runs`, exit 1 — identical.
  - `src/measure-divergence.ts 0001` against a fixture ledger → stdout
    scorecard JSON, exit 0, and the written
    `agents/divergence-scorecard.json` — identical (modulo the wall-clock
    `measured_at` timestamp, which differs between any two runs).
  - `src/review-dispatch.ts` with no args → usage error, exit 1 — identical.
  - `src/review-dispatch.ts run1 rev1 claude /nonexistent-prompt.md` →
    `hydra: error: prompt file not found: ...`, exit 1 — identical.
  - `src/otel-env.ts` → the six `export KEY=value` lines, exit 0 — identical.
- **`npm run typecheck` could not be executed here:** no `node_modules` in the
  worktree and the npm registry is unreachable from this sandbox (HTTP 403),
  so `tsc` is unavailable. The edits are type-trivial (an added optional
  parameter with a default; a `!== null` → `!= null` comparison on
  `number | null`; no new imports) and all edited modules are loaded and
  exercised by the test runs above. Run `npm install && npm run typecheck` on
  an unrestricted machine to close this gap.
