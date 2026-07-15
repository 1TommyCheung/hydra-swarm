# Bun migration — Stage 1, Phase 2 follow-up: neutralize the 34 routed modules' `isMain` guards inside compiled binaries

Run 0039, task `neutralize-ismain-guards`, branch
`hydra/0039/neutralize-ismain-guards` (base
`b5991ea5bcbd417e1d863c34c84deb50c8f13394`). TypeScript-only lane: 34 files
under `kit/hydra-ts/src` plus this document. `kit/hydra-ts/src/cli.ts` is
deliberately untouched — see below.

(Count note: the task spec says "33 routed modules"; the actual set of files
with an `isMain` guard other than `cli.ts` — i.e. every module `cli.ts`
routes to — is 34. The spec's operative definition, "every file with an
isMain guard EXCEPT `kit/hydra-ts/src/cli.ts`", was applied; all 34 are
listed below.)

## The bug

`bun build --compile` collapses `import.meta.url` to the SAME synthetic
entry URL (`file:///$bunfs/root/<entry-name>`) for every bundled module
(docs/bun-migration-spike-adapters.md spike #2). Every routed module's
bottom-of-file guard,

```ts
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
```

therefore evaluates TRUE simultaneously for all 34 routed modules inside the
compiled `dist/hydra-cli` produced by `npm run build:bin`
(docs/bun-migration-stage2-bash-preamble.md). Running ANY subcommand through
the binary invoked every module's own `main()` against `cli.ts`'s argv —
confirmed live before this fix (see "Empirical before/after" below): one
`./dist/hydra-cli status` printed 44 lines of output from ~15 modules and
wrote state files (`agents/profiles/`, `agents/divergence-scorecard.json`)
from modules that were never the intended target.

`cli.ts` (Phase 1b) is the ONE module whose guard SHOULD keep firing true
inside the binary — it imports every other module's exported `main()` and
routes via `route(process.argv.slice(2))`. Its guard is left exactly as-is.

## The fix

`kit/hydra-ts/src/kit-assets.ts` (Phase 2) already exports
`isCompiledBinary(): boolean` =
`import.meta.url.startsWith('file:///$bunfs/')` — true for every bundled
module inside a compiled binary, false under plain Node. In each of the 34
routed modules the guard now reads (style preserved per file, see variants):

```ts
const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
```

with `isCompiledBinary` added to the file's import block. Files that already
imported from `./kit-assets.ts` (allocate, create-worktree, integrate,
promote, record-review, review-required) had the symbol merged into that
existing import; all others gained one new import line adjacent to their
existing `./lib.ts`/local imports (otel-env.ts, which had no local imports,
gains it directly after its `node:` imports).

Guard variants found in the tree and preserved — only the
`!isCompiledBinary() &&` condition was added, nothing else changed:

1. Two-line form with `resolve(...)` — 24 files: adapter-claude,
   adapter-opencode, allocate, amend-task, audit-ownership,
   build-worker-prompt, cancel-task, code-intel, freshness-gate,
   graph-impact, graphify-baseline, graphify-investigate, integrate,
   ledger-view, measure-divergence, otel-env, promote, record-review,
   record-usage, review-required, run-init, squash, status, verify.
2. Two-line form WITHOUT `resolve(...)` (`pathToFileURL(process.argv[1])`)
   — 4 files: adapter-kimi, create-worktree, graphify-repo, index-candidate.
3. One-line form — 1 file: dispatch.
4. Three-line `const isMain =\n  ... &&\n  ...` form — 5 files:
   adapter-codex, adapter-stub, aggregate-usage, herdr-push, review-dispatch.

All 34 updated with the exact same pattern: import `isCompiledBinary` from
`./kit-assets.ts`, gate the guard with `!isCompiledBinary() &&`. Verified by
reading the complete `git diff` (68 insertions / 35 deletions, nothing
else).

## Why this is safe (Node-lane no-op)

Under plain Node (`node --experimental-strip-types <file>.ts`, the source
lane AND the lane the frozen bash wrappers exec), `import.meta.url` is a
real file URL (`file:///Users/...`), never `file:///$bunfs/`, so
`isCompiledBinary()` is always false and `!isCompiledBinary()` is always
true — the guard reduces to exactly its pre-fix expression. Zero behavior
change outside the compiled binary. Inside the compiled binary,
`!isCompiledBinary()` is false for the 34 routed modules (they are never
the entry), so their guards can never fire regardless of Bun's URL
collapse; only `cli.ts`'s untouched guard fires, and only `cli.ts`
explicitly calls the routed `main()`.

## Empirical before/after (compiled binary, `status` with no args)

Method: `git archive <base>` into a scratch copy, `npm run build:bin` (Bun
1.3.14) for the BEFORE binary; same build on the fixed tree for the AFTER
binary. Both run from a scratch cwd (`/tmp/hydra-0039-run`) with
`HYDRA_STATE_ROOT` pointed at per-run scratch dirs to contain side effects.
Node-lane reference: `node --experimental-strip-types src/cli.ts status`
from the same scratch cwd.

BEFORE (`/tmp/hydra-0039-before/.../dist/hydra-cli status`, exit 1) —
the cascade, verbatim:

```
hydra: error: claude.sh: unknown verb 'status'
hydra: error: codex.sh: only 'start' is implemented in Wave 0 (got 'status')
hydra: error: usage: adapter-kimi.ts visual|start ...
hydra: error: opencode.sh: unknown verb 'status'
hydra: error: stub.sh: unknown verb 'status'
hydra: measured profiles written for: none -> /tmp/hydra-0039-state-before/agents/profiles
hydra: error: task_type required
ENOENT: no such file or directory, open '/private/tmp/hydra-0039-run/status'
hydra: error: usage: record-usage.sh <run_id> <task_id> <vendor> <agent_run_id>
hydra: error: usage: dispatch <run_id> <task_id> [--background]
hydra: error: usage: amend-task.sh <run_id> <task_id> <reason> [resume|restart]
hydra: error: usage: audit-ownership.sh <worktree> <base> <head> <writable_glob>...
hydra: error: usage: cancel-task <run_id> <task_id> [--wait-seconds N]
hydra: error: usage: code-intel changed [--base <ref>] | impact <symbol> | query "<q>" | drift
hydra: error: usage: create-worktree.ts <run_id> <task_id> [base_commit]
hydra: error: usage: freshness-gate.sh <run_id> <task_id>
hydra: error: usage: graph-impact.sh <run_id> <task_id>
hydra: error: not inside a git repository (cwd: /private/tmp/hydra-0039-run) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run
hydra: error: task_id required
hydra: error: not inside a git repository (cwd: /private/tmp/hydra-0039-run) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run
hydra: error: no ledger for run status
hydra: error: usage: index-candidate.ts <run_id> <task_id> [logical_label]
hydra: error: usage: verify.sh <worktree> <policy.yaml> [out.json]
hydra: error: no tasks to integrate
hydra: error: no ledger for run status
{
  "measured_at": "2026-07-15T15:47:14Z",
  "evidence_class": "measured",
  "per_vendor": {}
}
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_RESOURCE_ATTRIBUTES=service.name=hydra-swarm
hydra: error: usage: promote(run_id, task_id, inbox_result.json)
hydra: error: usage: record-review.sh <run_id> <task_id> <verdict.json>
hydra: error: review_id required
hydra: error: risk required (low|medium|high|critical)
hydra: error: not inside a git repository (cwd: /private/tmp/hydra-0039-run) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run
hydra: error: usage: squash.sh <run_id> <task_id>
hydra: error: usage: status <run_id> <task_id> [--lines N] [--json]
hydra: error: usage: status <run_id> <task_id> [--lines N] [--json]
```

Note the tell-tale last line printed TWICE: once by status.ts's own guard
firing, once by cli.ts's routing. Side effects observed: the BEFORE run
created `$HYDRA_STATE_ROOT/agents/profiles/` and
`$HYDRA_STATE_ROOT/agents/divergence-scorecard.json`.

AFTER (fixed tree's `dist/hydra-cli status`, exit 1) — entire output:

```
hydra: error: usage: status <run_id> <task_id> [--lines N] [--json]
```

Byte-identical to the Node-lane reference (modulo Node's
`ExperimentalWarning` on stderr), exactly one usage error, ZERO state files
created. Same result for `./dist/hydra-cli verify`: single
`usage: verify.sh ...` line, exit 1, no state. The guard cascade is gone;
only cli.ts's routing fires.

## Test suite

`cd kit/hydra-ts && npm test` (Node v22.14.0):

- Baseline (pristine base commit): **810 tests, 807 pass, 3 fail, 0
  cancelled**.
- After this fix: **810 tests, 807 pass, 3 fail, 0 cancelled** — identical,
  zero regressions, as predicted for a Node-lane no-op.

The 3 failures are pre-existing on the base commit and unrelated to this
change: all in `test/status.sh.test.ts` "status.sh bash fallback", which
spawns a dispatcher process and asserts its visibility via `ps` — the
sandboxed environment here does not expose spawned processes through `ps`.

Environment caveat: this harness's sandbox denies file creation inside
`.git/` directories WITHIN the worktree, so running the suite in-place
fails 72 tests at `git init` of fixture repos
(`Operation not permitted` copying template hooks). Both suite runs above
were therefore executed in pristine full-tree copies under `/tmp`
(base commit vs fixed tree, each `git init`'ed locally), where no such
restriction exists; the 3 `ps`-visibility failures occur in both
environments, including in-worktree.

All scratch state (`/tmp/hydra-0039-*`, including every
`HYDRA_STATE_ROOT` used by the binary runs) was removed after verification;
nothing was written to `~/.local/state/*-hydra/` because
`HYDRA_STATE_ROOT` was set for every manual binary invocation.
