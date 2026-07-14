# Background dispatch operational notes

## Recommended pattern: blocking dispatch + caller backgrounding

The preferred pattern for a lead running in an environment with its own background-execution capability (e.g. a tool call that runs a command in the background and notifies on completion) is to call:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh <run> <task>
```

without `--background`, and let the caller's own backgrounding mechanism carry the command. This gives a genuine completion notification for free and avoids hand-rolled watcher scripts entirely.

A documented past failure mode: a watcher script hardcoded a stale session-version suffix and matched a leftover `.exit` file from a prior dispatch round, falsely reporting completion. Relying on the caller's backgrounding removes that class of mistake; sentinels remain a private supervisor/worker handshake, not a lead-facing notification API.

If your environment has no native backgrounding and you must use a persistent shell, a detached equivalent is:

```bash
nohup bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh <run> <task> \
  >"$log" 2>&1 </dev/null & disown
```

## `--background` flag behavior

What `--background` does depends on which harness runtime is selected:

- **TypeScript harness (default).** `dispatch.sh` returns an in-process completion handle without awaiting the worker, but the same CLI process retains the live child process and polling timers until the work finishes. The shell does **not** regain control merely because the exported `dispatch()` promise has resolved; the process stays resident as the supervisor. This is why the recommended caller-backgrounded blocking pattern above is preferred.

- **Bash fallback (`HYDRA_HARNESS=bash`).** `dispatch.sh` backgrounds `run_worker` inside the script and exits immediately, returning control to the shell.

When dispatching with `--background` from a short-lived tool-shell (not a persistent terminal), follow these rules regardless of runtime:

- Never pipe `dispatch.sh` output (`| tail`, `| grep`, etc.). A backgrounded worker may inherit the pipe's stdout, so the pipe never closes and the caller hangs. Always redirect to a file:

  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh <run> <task> --background >/tmp/x.log 2>&1 & disown
  ```

- If a dispatch call is killed by an external timeout before it finishes acquiring a concurrency slot, the worker may still be running fine while the harness `.slots/<id>` marker never releases. Later dispatches then queue forever behind a "full" pool that is actually empty. Diagnose by comparing `.slots/<id>` entries against `sessions/<id>.exit` sentinels; remove any slot whose matching exit sentinel proves it is stale.
