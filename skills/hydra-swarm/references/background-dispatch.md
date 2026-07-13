# Background dispatch operational notes

When dispatching with `--background` from a short-lived tool-shell (not a persistent terminal), follow these rules:

- Never pipe `dispatch.sh` output (`| tail`, `| grep`, etc.). The backgrounded worker inherits the pipe's stdout, so the pipe never closes and the caller hangs. Always redirect to a file:

  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/kit/hydra/scripts/dispatch.sh <run> <task> --background >/tmp/x.log 2>&1 & disown
  ```

- If a dispatch call is killed by an external timeout before it finishes acquiring a concurrency slot, the worker may still be running fine while the harness `.slots/<id>` marker never releases. Later dispatches then queue forever behind a "full" pool that is actually empty. Diagnose by comparing `.slots/<id>` entries against `sessions/<id>.exit` sentinels; remove any slot whose matching exit sentinel proves it is stale.
