# TS/bash runtime switch

Use `HYDRA_HARNESS` to select the implementation. Any value other than exactly `bash` (including unset) selects TypeScript; `HYDRA_HARNESS=bash` selects the original bash body, byte-identical to pre-cutover behavior.

Keep invoking the unchanged bash entry points:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh ...
```

Do not change invocation patterns; the preamble in each script transparently execs into the selected implementation.

For adapter selection one layer down, `dispatch.ts` follows the same rule: `HYDRA_HARNESS=bash` or `HYDRA_ADAPTER_RUNTIME=bash` forces bash vendor adapters; anything else uses the TypeScript adapters at `${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts/src/adapter-<vendor>.ts`. `HYDRA_ADAPTER_RUNTIME` wins when set explicitly.

For isolated testing or debugging, invoke a TypeScript file directly:

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts/src/<name>.ts <same args>
```

For normal driving, use the bash entry point and let the switch handle it.

Run the full test suite with:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts && npm test
```

`npm test` deliberately runs the non-promotion files first and then `promote.test.ts` separately to avoid a known concurrent-load flake in the promotion tests. Use the raw `node --experimental-strip-types --test 'test/**/*.test.ts'` glob only when you need to verify a short count is not a regression.

Beware the stale-node PATH gotcha: on this machine, a stale system `node` (`/usr/local/bin/node`, v17.4.0) can shadow the correct nvm-managed node (v22.14.0) in non-interactive/login-shell contexts, such as herdr's `bash -lc` pane hosting and a dispatched worker's sandboxed verification shell. `--experimental-strip-types`/`--test` then fail with "bad option". The harness protects its own entry points via `hydra_resolve_node()` in `${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/lib.sh`: it requires Node ≥22.6, checks `PATH`, then chooses the highest qualifying nvm install or a common Homebrew install, and emits an actionable error if none qualifies. Use the absolute path it returns rather than a bare `node`/`npm` when running node manually inside a worker or pane context. `hydra_repo_root()`'s "not inside a git repository" error now includes the offending cwd and a fix hint (`cd` into the target repo or one of its worktrees) — a bare version of this error was previously mistaken for a broken worker rather than an operator running from the wrong shell.

Beware a second, unrelated gotcha if you ever create a scratch worktree or fixture under `/tmp` for manual testing on macOS: `/tmp` is a symlink to `/private/tmp`. A bash script's `exec node <path-with-unresolved-.. segments-under-/tmp>` can then silently produce a `process.argv[1]`/`import.meta.url` mismatch for any TypeScript entry point using an `isMain`-style guard (`import.meta.url === pathToFileURL(resolve(process.argv[1])).href`), which evaluates false and skips `main()` entirely — the script exits 0 with zero output, looking exactly like a fresh, undiagnosed regression. This reproduces identically on unmodified `master`, independent of any real code change; it is not a harness bug. Prefer a scratch path under `${TMPDIR}` accessed via its own realpath, or just work inside a real `git worktree` under `${CLAUDE_PLUGIN_ROOT}`'s normal worktree root, to avoid the symlink entirely.
