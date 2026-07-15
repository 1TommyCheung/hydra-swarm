# Bun migration — Stage 1, Phase 2, lane 3: three-state bash preamble + `build:bin` flags

Run 0038, task `bash-preamble-and-build-flags`, branch
`hydra/0038/bash-preamble-and-build-flags` (base
`8dc5854cc5902544f2721341bb7d14c8b29bd439`). Bash-only lane: no file under
`kit/hydra-ts/src` or `kit/hydra-ts/test` was touched (two parallel lanes in
this run own the TypeScript side).

## Part A — `build:bin` retargeted to the real router, hardened flags

`kit/hydra-ts/package.json` now has:

```json
"build:bin": "bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/hydra-cli src/cli.ts"
```

Changes vs the Stage 0 spike command:

1. Entry point `src/cli.ts` (Phase 1b's real router,
   `docs/bun-migration-stage1-cli.md`) instead of the frozen spike artifact
   `src/bin-cli.ts` (left untouched, not deleted).
2. Added `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, the pair
   recommended by `docs/bun-migration-plan-codex.md` ("Compile with runtime
   auto-loading disabled") and empirically confirmed working by
   `docs/bun-migration-spike-testing.md` item #11: without them a stray
   `.env`/`bunfig.toml` in an operator's cwd silently mutates the binary's
   environment, and a malformed `bunfig.toml` kills it at startup.
3. Output renamed `dist/hydra-bin-stage0` → `dist/hydra-cli` (no longer a
   throwaway spike binary; this is also the wrappers' default `bin`-lane path).

`cd kit/hydra-ts && npm run build:bin` (Bun 1.3.14 at `~/.bun/bin/bun`)
succeeds: `bundle 39 modules`, `compile dist/hydra-cli`, 63.7 MB Mach-O
arm64 executable. See "Known gaps at this base" below for what the binary
can and cannot do until the parallel TS lanes land.

## Part B — three-state preamble in all 28 wrappers

### Final template

Every `kit/hydra/scripts/<name>.sh` wrapper (lib.sh excluded — it is sourced,
not a wrapper) previously had a two-state preamble:

```bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
HYDRA_NODE="$(hydra_resolve_node)"
exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/<name>.ts" "$@"
fi
# ...frozen bash implementation follows...
```

It is now three-state, selected by `HYDRA_HARNESS` (shown for `status.sh`):

```bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" status "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" status "$@"
fi
# ...frozen bash implementation follows (untouched)...
```

Semantics:

- `HYDRA_HARNESS=bash` — unchanged: falls through to the frozen bash body.
- `HYDRA_HARNESS=bin` — `hydra_resolve_bin` resolves a binary (see below) and
  the wrapper `exec`s `<binary> <name> "$@"`. If resolution fails it has
  already printed the warning, returns 1, and execution falls through to the
  `ts` line — never a hard failure.
- Anything else (incl. unset, the default) — `ts` lane, now routed through
  Phase 1b's single entry point: `cli.ts <name> "$@"` instead of the
  standalone `<name>.ts`. `cli.ts route()` is a pure passthrough
  (`argv.slice(1)` forwarded to the same module `main`, exit code returned),
  verified byte-identical below.

The replacement is deliberately **exactly 4 lines like the block it
replaces**: the frozen bash body keeps its original line numbers, so even
bash's own `status.sh: line 19: 1: usage: ...` error messages remain
byte-identical to the pre-change output.

### `hydra_resolve_bin()` (lib.sh, next to `hydra_resolve_node()`)

```bash
hydra_resolve_bin() {
  local lib_dir candidate
  if [ -n "${HYDRA_BIN:-}" ]; then
    if [ -x "$HYDRA_BIN" ]; then
      printf '%s\n' "$HYDRA_BIN"
      return 0
    fi
    hydra_warn "HYDRA_HARNESS=bin requested but HYDRA_BIN=$HYDRA_BIN not found, falling back to ts"
    return 1
  fi
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$lib_dir/../../hydra-ts/dist/hydra-cli"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  hydra_warn "HYDRA_HARNESS=bin requested but $candidate not found, falling back to ts"
  return 1
}
```

- `HYDRA_BIN` set (operator/rollback override, pins a specific build) and
  executable → that path wins.
- `HYDRA_BIN` set but missing/not executable → warn, fall back to `ts`.
- `HYDRA_BIN` unset → default `kit/hydra-ts/dist/hydra-cli` (the Part A
  output). Missing/not executable → warn
  `hydra: warn: HYDRA_HARNESS=bin requested but <default path> not found,
  falling back to ts` on stderr and fall back to `ts`. An operator who has
  not run `build:bin` is never left without a working command.
- All 28 wrappers call this one shared helper; the resolution logic exists
  exactly once.

### Transformation method (auditable, not a repo file)

All 28 wrappers were rewritten by one mechanical script (perl in slurp mode,
exact-match on the old 4-line block, `<name>` captured from each file's own
exec line — no hand-editing, no per-file typo risk). Core of the script:

```bash
for f in kit/hydra/scripts/*.sh; do
  name="$(basename "$f" .sh)"; [ "$name" = "lib" ] && continue
  perl -0pi -e '
s{if \[ "\$\{HYDRA_HARNESS:-ts\}" != "bash" \]; then\nHYDRA_NODE="\$\(hydra_resolve_node\)"\nexec "\$HYDRA_NODE" --experimental-strip-types "\$SELF_DIR/\.\./\.\./hydra-ts/src/([a-z0-9-]+)\.ts" "\$@"\nfi}{my $n=$1; qq{if \[ "\${HYDRA_HARNESS:-ts}" != "bash" ]; then\nif \[ "\${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="\$(hydra_resolve_bin)"; then exec "\$HYDRA_BIN_PATH" $n "\$@"; fi\nHYDRA_NODE="\$(hydra_resolve_node)"; exec "\$HYDRA_NODE" --experimental-strip-types "\$SELF_DIR/../../hydra-ts/src/cli.ts" $n "\$@"\nfi}}ge' "$f"
done
```

Per-file post-conditions were asserted by the same script (it aborts loudly
otherwise): exactly one `hydra_resolve_bin` call, exactly one
`src/cli.ts" <name>` route, no leftover direct-`<name>.ts` exec. Result:
`newly transformed: 28`, `bash -n` clean on all 29 files (28 + lib.sh), and a
directory-wide grep re-verified the counts.

`freshness-gate.sh` special case: **no deviation needed** — it already had
the exact standard preamble shape (exec'ing `freshness-gate.ts`), so the same
transform applied unmodified.

## Verification (all run locally; harness re-verifies)

Environment: macOS arm64, Node v24.16.0 via nvm (`/usr/local/bin/node` is
v17.4.0 — pre-existing PATH shadowing; `hydra_resolve_node` finds the nvm
one), Bun 1.3.14, bash 3.2 (system) for the wrappers.

1. **Zero regression, `bash`/`ts`/unset modes (pre vs post change).** A
   capture harness snapshotted stdout/stderr/exit-code for 8 scripts spanning
   sync and async `main()` shapes — `status` (no-args usage error, fixture
   run, fixture `--json`), `review-required` (no-args, `codex high`,
   `codex low security`), `otel-env`, `ledger-view` (no-args, fixture with
   HTML output diffed byte-wise), `freshness-gate`, `verify`, `allocate`,
   `promote` — under `HYDRA_HARNESS=bash`, `=ts`, and unset, before and after
   the edit. **Every capture is byte-identical pre vs post** (39/39
   stdout+stderr+exit-code triples — 13 invocation shapes × 3 modes — plus
   the 3 mode-specific ledger-view HTML outputs). This
   includes the pre-existing quirks remaining *unchanged*: bash-mode usage
   stderr still says `line 19` (preamble kept at 4 lines), `promote` still
   exits 1 in bash vs 2 in ts (pre-existing divergence, not introduced here),
   `review-required`'s bash lane still fails 127 on this machine (macOS bash
   3.2 lacks `mapfile` — pre-existing, unchanged).
2. **`bin` fallback when no binary is present.**
   - `HYDRA_BIN=/nonexistent`: 10 invocation shapes across `status`,
     `otel-env`, `review-required`, `ledger-view`, `freshness-gate`, `verify`,
     `allocate`, `promote` — all print exactly
     `hydra: warn: HYDRA_HARNESS=bin requested but HYDRA_BIN=/nonexistent not found, falling back to ts`
     on stderr, then produce stdout/stderr/exit-code identical to `ts` mode.
   - `HYDRA_BIN` unset with `dist/hydra-cli` temporarily moved away: same
     behavior, warning names the default path. PASS.
   - `HYDRA_BIN` pointing at a non-executable file: same fallback. PASS.
3. **`bin` with a working binary.** Because the real `dist/hydra-cli` at this
   base commit is affected by the known isMain-guard issue (see below), the
   plumbing was proven against a demonstration binary built in /tmp from a
   copy of `src` with the 34 module-level `if (isMain)` guards neutralized
   (only `cli.ts`'s kept) — i.e. a preview of the parallel TS lane's end
   state, nothing committed. `HYDRA_HARNESS=bin HYDRA_BIN=<demo>` vs `ts`:
   **10 of 11 invocation shapes byte-identical** (stdout, stderr, exit code):
   `status 9999 demo`, `status --json`, `status` usage error, `otel-env`,
   `review-required` usage error, `ledger-view` fixture, `freshness-gate`,
   `verify`, `allocate`, `promote`. The one difference — `review-required
   codex high` — is the embedded-assets gap, not the preamble: under
   `bun build --compile` the module URL is `file:///$bunfs/...`, so
   `review-required.ts`'s `../policies/review-policy.yaml` resolves to
   `/hydra/policies/review-policy.yaml` (ENOENT). That is precisely the
   parallel asset-embedding lane's scope (the task spec: "the compiled binary
   will NOT have working embedded assets yet ... expected and fine").
4. **`build:bin` runs; real binary behavior at this base.** `npm run
   build:bin` succeeds (Part A). `HYDRA_HARNESS=bin bash status.sh 9999 demo`
   against the real `dist/hydra-cli` exits 0 like `ts` but with polluted
   output — see Known gaps.
5. **hydra-ts suite unaffected.** Suite counts and the failing-test name set
   are identical before/after (method and numbers in the section below) — the
   bash-only lane perturbs nothing TypeScript-side. Note the spec's "789-test
   baseline" does not reproduce anywhere: `test:concurrent` discovers **787**
   tests at this base (787 = 706 baseline + 81 added by `test/cli.test.ts` in
   run 0037 per `docs/bun-migration-stage1-cli.md`), and because
   `test:concurrent` exits non-zero in this sandbox, `npm test`'s `&&` chain
   never reaches `test:promote` (also pre-existing, same as run 0037).

## kit/hydra-ts test suite — base vs after, controlled comparison

In this sandbox the suite cannot run green inside the worktree: the agent
sandbox denies writes to any `**/.git/**` path under the workspace, so every
test that `git init`s a fixture fails with EPERM (run 0037 documented the
same signature, 72 failures in-worktree). The controlled comparison therefore
runs the suite from full `kit/` copies placed in /tmp (identical Node
v24.16.0, identical invocation `npm test`), which escapes the sandboxed path:

- **Base** (`git archive HEAD` = base commit): **787 tests / 767 pass / 20
  fail**, `npm test` exit 1 (`test:promote` not reached due to `&&`).
- **After** (working tree with this task's changes): **787 tests / 767 pass /
  20 fail**, exit 1 — identical counts.
- Failing-test name sets diffed: **byte-identical** (`diff` empty): 11
  `adapter-claude` (vendor CLI/login-shell sandbox), 4 `run-init`, 3
  `status.sh` (macOS `ps` visibility for dispatch discovery), 1
  `review-dispatch`, 1 `amend-task`.

Remaining failures are the pre-existing environmental signature (macOS `ps`
visibility for the dispatch-discovery tests, missing vendor CLIs/sandboxed
home for adapter tests, bash 3.2 for the `.sh` wrapper tests) — present
identically at base; none caused by this change. The `.sh` wrapper tests
(`status.sh.test.ts`, `cancel-task.sh.test.ts`) resolve the scripts via
`../../hydra/scripts`, so the /tmp `kit/` copies exercise this task's edited
wrappers, including the re-routed `ts` lane through `cli.ts`.

## Known gaps at this base (owned by parallel/later lanes, not this one)

1. **Compiled binary runs every module's guard body.** Under
   `bun build --compile`, Bun collapses every bundled module's
   `import.meta.url` to the same synthetic entry URL (verified with a
   minimal two-module probe: `argv[1]`=`/$bunfs/root/<entry>`,
   `import.meta.main` true only for the entry). All 34 routed modules still
   carry Phase-1a `isMain` URL guards, so every guard fires at import and the
   router's output is interleaved with 34 stray `main()` runs.
   `docs/bun-migration-stage1-cli.md` (lines 129–135) already flagged this:
   "a build-time guard neutralization step remains required before
   `bun build --compile`" — a TypeScript-side change owned by this run's
   parallel TS lanes. Once it lands, this task's `build:bin` command and
   `bin` preamble work unchanged (proven by check 3 above).
2. **Embedded assets unresolved in the binary** (policy YAMLs etc. resolve
   against the `$bunfs` module URL). Parallel asset-embedding lane's scope;
   full black-box compiled testing is Phase 3 per the spec.

## Files changed

- `kit/hydra-ts/package.json` — `build:bin` retarget/flags/outfile.
- `kit/hydra/scripts/lib.sh` — added `hydra_resolve_bin()`.
- `kit/hydra/scripts/*.sh` — all 28 wrappers, three-state preamble (identical
  shape everywhere except the substituted `<name>`).
