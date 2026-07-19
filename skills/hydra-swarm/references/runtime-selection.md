# Runtime selection: `ts` and `bin`

Hydra has exactly **two** runtime values. The Bash implementation lane was
retired in run 0045 (dev note `docs/dev-notes/bash-lane-retirement-plan.md`, machine-local); `bash` is no longer
an executable implementation choice.

## Unset `HYDRA_HARNESS` — the default: prefer `bin`, fall back to `ts`

Leave `HYDRA_HARNESS` unset for normal operation. Every `kit/hydra/scripts/*.sh`
entry point (`hydra_launch()` in `lib.sh`) tries the compiled binary first; if
none is resolvable (no `HYDRA_BIN`, no `npm run build:bin` output yet — e.g. a
fresh checkout) it falls back to the TypeScript/Node source lane **silently**,
with no warning and no error. This is the *only* place a `bin` failure ever
falls back — see the explicit-`bin` section below.

```bash
bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh 0042 my-task   # bin if resolvable, else ts (default)
```

## `ts` — force the TypeScript/Node source lane

Set `HYDRA_HARNESS=ts` explicitly. Resolves Node ≥ 22.6 (`hydra_resolve_node()`)
and execs `node --experimental-strip-types kit/hydra-ts/src/cli.ts <subcommand> "$@"`.

```bash
HYDRA_HARNESS=ts bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/status.sh 0042 my-task
```

For isolated debugging you can invoke a TypeScript module directly:

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts/src/<name>.ts <same args>
```

At the adapter layer, `dispatch.ts` resolves the same default: the
`adapter-<vendor>.ts` source runs through Node. An explicit
`HYDRA_ADAPTER_RUNTIME=ts` is accepted but normally left unset.

## `bin` — the compiled binary (implicit default, and the explicit no-Node rollback)

A prebuilt `bun build --compile` single binary that embeds the kit assets and
self-re-execs through `cli.ts`'s `adapter-<vendor>` routes. It is the **only**
runtime that works with no Node.js on `PATH`, so besides being the implicit
default it's also the explicit rollback when Node resolution fails or a
source-lane change is suspect: `HYDRA_HARNESS=bin`.

**Implicit vs. explicit matters.** When `bin` is chosen implicitly (unset
`HYDRA_HARNESS`) and no usable binary exists, the launcher falls back to `ts`
silently. When `HYDRA_HARNESS=bin` is set **explicitly**, an unusable binary is
a HARD ERROR instead — an operator who deliberately asked for the rollback path
must never be silently downgraded without noticing.

Point `HYDRA_BIN` at an absolute, regular, executable binary. A retained
checksummed known-good artifact is installed as the rollback:

```text
~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64
```

(build manifest: `manifest-darwin-arm64.json` alongside it — see that file for
the current `source_sha`/`sha256`; `v1` is kept as historical, not deleted).
Force any command through the pinned binary explicitly:

```bash
# Explicit rollback: hard errors instead of falling back if this path is broken.
HYDRA_HARNESS=bin \
  HYDRA_BIN=~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64 \
  bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh 0042 my-task
```

The wrapper execs the binary via `env -u BUN_BE_BUN` (in both the implicit and
explicit paths) so a leaked `BUN_BE_BUN=1` can never hijack it into Bun's own
CLI.

To rebuild the binary from source (requires `bun`) — this output is also where
the implicit default looks when `HYDRA_BIN` is unset:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts && npm run build:bin   # -> dist/hydra-cli
```

## Retired: `bash`

`HYDRA_HARNESS=bash` and `HYDRA_ADAPTER_RUNTIME=bash` are **retired**. They fail
loudly with an explicit retirement error and do **not** silently coerce to `ts`:

- At the wrapper launcher, `HYDRA_HARNESS=bash` exits non-zero with a retirement
  message (`HYDRA_HARNESS=bash was retired; use HYDRA_HARNESS=bin with a pinned
  HYDRA_BIN, or use ts`).
- In `dispatch.ts`, `resolveAdapterRuntime()` rejects `bash` (via either the
  `HYDRA_ADAPTER_RUNTIME` override or `HYDRA_HARNESS`) and any other
  unrecognized non-empty adapter-runtime value; accepted override values are
  exactly `ts` and `compiled`.

The six `kit/hydra/adapters/*.sh` shell adapters were deleted; vendor dispatch
is TypeScript (`adapter-<vendor>.ts`) or the compiled binary's
`adapter-<vendor>` route only. The 28 `kit/hydra/scripts/*.sh` filenames remain
as stable launchers for `ts`/`bin` (see the machine-local dev note `docs/dev-notes/bash-lane-retirement-plan.md`
Lane 1).

## Stale-node PATH gotcha

On some machines a stale system `node` (`/usr/local/bin/node`, v17.4.0) shadows
the correct nvm-managed node (v22.14.0) in non-interactive/login-shell contexts
such as herdr's `bash -lc` pane hosting and a dispatched worker's sandboxed
verification shell. `--experimental-strip-types`/`--test` then fail with "bad
option". The harness protects its own entry points via `hydra_resolve_node()`
in `kit/hydra/scripts/lib.sh`: it requires Node ≥ 22.6, checks `PATH`, then
chooses the highest qualifying nvm install or a common Homebrew install, and
emits an actionable error if none qualifies. Use the absolute path it returns
rather than a bare `node`/`npm` when running node manually inside a worker or
pane context. If Node itself is the problem (not just PATH), switch to the
`bin` runtime above — it needs no Node at all.
