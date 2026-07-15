# Bun migration — Stage 1, group 2: exported `main()` normalization

Run 0036, task `router-normalize-group2`. Mechanical normalization per
`docs/bun-migration-plan-codex.md` Stage 1 and the spike #2 finding in
`docs/bun-migration-spike-adapters.md` (in a compiled bundle every `isMain`
guard evaluates true, so a future router must import files and call an
exported `main()` — this task only normalizes the guard/main shape; it does
not build the router). Reference shapes: `src/status.ts:489-535` (sync) and
`src/promote.ts:506-528` (async).

Zero behavior change was the acceptance bar. Guard bodies that held inline
CLI logic were extracted into an exported `main(args)`; every guard block is
now the two-line `if (isMain) { process.exitCode = main(); }` form (or the
`await` async equivalent). No flag, argument, error message, or exit-code
mapping was altered. Where the old guard body called `process.exit(1)`
(graphify-repo.ts, index-candidate.ts), the extracted `main()` returns `1`
and the guard assigns `process.exitCode`, per the reference pattern; the
observed exit code is unchanged.

## Per-file results

### Already conformant (verified by reading; left untouched)

| File | Signature | Notes |
|---|---|---|
| `src/freshness-gate.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync; try/catch inside; returns 0/8/1; guard already two-line. |
| `src/graph-impact.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync; returns `GraphImpactError.exitCode` or 0/1; no `process.exit()`. |
| `src/graphify-baseline.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync; returns 0/8/1. |
| `src/graphify-investigate.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync; returns `GraphifyInvestigateError.exitCode` or 0/1. |
| `src/integrate.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` | async; preserves 6/7 exit-code contract; guard uses `process.exitCode = await main()`. |
| `src/ledger-view.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | sync; returns 0/1. |

### Extracted in this task

| File | Final exported signature | Extraction notes |
|---|---|---|
| `src/create-worktree.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | Guard body `createWorktree(argv[2], argv[3], argv[4])` + catch became `main(args)` calling `createWorktree(args[0], args[1], args[2])`; returns 0 on success, 1 with the same stderr message on error. Guard variant without `resolve()` kept as-is. |
| `src/dispatch.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` | Old guard called `dispatch(...).catch(err => { stderr; process.exitCode = 1 })` without awaiting. `main()` now awaits `dispatch(args[0] ?? '', args[1] ?? '', { background: args[2] === '--background' })`, returns 0 on success, and on rejection writes the same stderr line and returns 1. `dispatch()`'s own exported signature and `DispatchHandle` behavior are unchanged; in `--background` mode `dispatch()` still resolves after printing the agent run id without awaiting the worker, exactly as before. |
| `src/graphify-repo.ts` | `export async function main(args: string[] = process.argv.slice(2)): Promise<number>` | Inline `if (process.argv[1] && ...)` guard with `await graphifyRepo(process.argv.slice(2))` and `process.exit(1)` in catch became an async `main(args)` returning 0/1; guard normalized to a named `isMain` const + `process.exitCode = await main()`. |
| `src/herdr-push.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | Guard body (`runId = argv[2] ?? ''`, `notify = argv[3] === '--notify'`, sync call, catch → stderr + `exitCode = 1`) moved into `main(args)` verbatim (`args[0] ?? ''`, `args[1] === '--notify'`); returns 0/1. `herdrPush` is synchronous; signature unchanged. |
| `src/index-candidate.ts` | `export function main(args: string[] = process.argv.slice(2)): number` | Inline `if (import.meta.url === ...)` guard with `process.exit(1)` in catch became `main(args)` with the same destructure, stdout write, and error text; returns 0/1; guard normalized to named `isMain` const + `process.exitCode = main()`. |

## Top-level import-time side effects

All 11 files were scanned for top-level statements that execute at module
import (beyond `import`s, type/interface declarations, pure `const`
declarations, function declarations, and the `isMain` guard evaluation
itself):

- **None found in any of the 11 files.** No top-level calls, IIFEs, loops,
  `process.on` registrations, env mutations, or filesystem access at module
  scope. The only suspicious-looking hits were Python source lines inside
  the `KIMI_ADAPTER` template-string constants in `graphify-repo.ts` and
  `graphify-baseline.ts` — string data, not executed JS.
- The `isMain` const itself is a pure expression (`pathToFileURL`/`resolve`
  comparisons) evaluated at import; it has no side effects. Note (already
  flagged by spike #2, out of scope here): in a compiled bundle every
  `isMain` evaluates true, so each guard body would invoke `main()` — the
  later router task must gate or strip these guard blocks at build time.

## Verification performed

Environment note: this session's sandbox denies writes to any `.git/`
directory under the worktree, so suite fixtures that run `git init` fail
here regardless of code changes (72 pre-existing failures in-worktree).
For a like-for-like signal the suite was also run from plain copies under
`/private/tmp`, where only 5 pre-existing environment-dependent files fail
(`adapter-claude`, `amendTask`, `reviewDispatch`, `runInit`,
`status.sh bash fallback`) identically before and after the change.

- Full suite (`npm test`, node v22.14.0, `kit/hydra-ts`):
  - worktree baseline: 706 tests / 631 pass / 72 fail (environmental `.git`-write sandbox).
  - `/private/tmp` copies, base commit vs post-change: **identical** — 706 tests / 686 pass / 20 fail, same failing files and same failing subtest names/counts (25 `not ok` lines each).
- CLI behavior, pre-change vs post-change sources invoked directly with
  `node --experimental-strip-types` (13/13 identical: stdout, stderr, exit
  code byte-compared):
  - create-worktree.ts: usage (no args / run only), missing task spec, and a full happy path in a `/tmp` git fixture — worktree path on stdout, log line, stamped task spec, `worktree_bootstrapped` ledger event, and `git worktree list` all byte-identical (fixture commit pinned with fixed author/committer dates).
  - dispatch.ts: usage (no args), missing task spec, and the same with `--background`.
  - graphify-repo.ts: dependency-gate error (no args), `status` verb.
  - herdr-push.ts: no args, unknown run with empty state root.
  - index-candidate.ts: usage (no args), missing task spec.
- Import dormancy check: `node --experimental-strip-types -e "await import(...)"`
  on each of the 5 extracted files imports cleanly with the guard dormant
  (no CLI output, exit 0) — the property the future router relies on.
