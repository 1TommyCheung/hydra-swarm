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
cd hydra-swarm-plugin/kit/hydra-ts && node --experimental-strip-types --test 'test/**/*.test.ts'
```

Expect occasional flake: under full concurrent load the glob can under-report by exactly `promote.test.ts`'s 26 tests. `npm test` isolates that file to avoid the flake; rerun the raw glob before treating a short count as a regression.

Beware the stale-node PATH gotcha: on this machine, a stale system `node` (`/usr/local/bin/node`, v17.4.0) can shadow the correct nvm-managed node (v22.14.0) in non-interactive/login-shell contexts, such as herdr's `bash -lc` pane hosting and a dispatched worker's sandboxed verification shell. `--experimental-strip-types`/`--test` then fail with "bad option". The harness protects its own entry points via `hydra_resolve_node()` in `${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/lib.sh`: it requires Node ≥22.6, checks `PATH`, then chooses the highest qualifying nvm install or a common Homebrew install, and emits an actionable error if none qualifies. Use the absolute path it returns rather than a bare `node`/`npm` when running node manually inside a worker or pane context.
