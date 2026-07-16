# Runtime selection: `ts` and `bin`

Hydra has exactly **two** runtime values. The Bash implementation lane was
retired in run 0045 (`docs/bash-lane-retirement-plan.md`); `bash` is no longer
an executable implementation choice.

## `ts` — the default (source lane)

Unset `HYDRA_HARNESS`, or set `HYDRA_HARNESS=ts`. Every `kit/hydra/scripts/*.sh`
entry point resolves Node ≥ 22.6 (`hydra_resolve_node()`) and execs
`node --experimental-strip-types kit/hydra-ts/src/cli.ts <subcommand> "$@"`.
This is what every dispatch actually runs.

```bash
bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh 0042 my-task      # TypeScript (default)
HYDRA_HARNESS=ts bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/status.sh 0042 my-task
```

For isolated debugging you can invoke a TypeScript module directly:

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts/src/<name>.ts <same args>
```

At the adapter layer, `dispatch.ts` resolves the same default: the
`adapter-<vendor>.ts` source runs through Node. An explicit
`HYDRA_ADAPTER_RUNTIME=ts` is accepted but normally left unset.

## `bin` — the independent no-Node rollback (pinned compiled binary)

`HYDRA_HARNESS=bin` selects a prebuilt `bun build --compile` single binary that
embeds the kit assets and self-re-execs through `cli.ts`'s `adapter-<vendor>`
routes. It is the **only** runtime that works with no Node.js on `PATH`, so it
is the rollback path when Node resolution fails or a source-lane change is
suspect.

Point `HYDRA_BIN` at an absolute, regular, executable binary. A retained
checksummed known-good artifact is installed as the rollback:

```text
~/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64
```

(build manifest: `manifest-darwin-arm64.json` alongside it —
`source_sha cfdb0415…`, `sha256 ad75f958…`). Run any command through it:

```bash
# Recovery / rollback: run the pinned binary with no Node required on PATH.
HYDRA_HARNESS=bin \
  HYDRA_BIN=~/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64 \
  bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh 0042 my-task
```

The wrapper execs the binary via `env -u BUN_BE_BUN` so a leaked `BUN_BE_BUN=1`
can never hijack it into Bun's own CLI. An explicitly-requested `bin` whose
`HYDRA_BIN` is unusable is a hard error, not a silent fallthrough to `ts`.

To rebuild the binary from source (requires `bun`):

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
as stable launchers for `ts`/`bin` (see `docs/bash-lane-retirement-plan.md`
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
