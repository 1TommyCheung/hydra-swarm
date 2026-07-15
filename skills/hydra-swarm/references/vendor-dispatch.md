# Vendor dispatch notes

Herdr pane hosting is the default: with `HYDRA_HERDR_PANES` unset (or `1`) and herdr live, every worker/reviewer is hosted in a pane. Set `HYDRA_HERDR_PANES=0` to force headless subprocess hosting (e.g. CI or a machine without herdr attached — though the harness also falls back automatically when herdr is not live). Pane hosting is reliable for all four vendors since the OpenCode monitor-pane fix; do not reflexively disable it.

Allow `dispatch.sh` to choose the hosting shape automatically per vendor:

- **Claude / Codex / Kimi** — host directly inside a herdr pane via the `bash -lc "echo $$>pidfile; adapter...; printf rc>sentinel"` wrapper.
  - **Codex** — rely on the live JSONL tail for pane progress.
  - **Kimi** — require srt sandbox confinement; `-p` auto-approves tools, so an OS sandbox is mandatory. Rely on the live NDJSON stdout tail for pane progress, parsed through `kimiEventText()` from the `.cli.jsonl` capture, the same mechanism Codex uses.
  - **Claude** — remember that `-p --output-format json` is not a streaming format; the pane shows only the banner, not a live body.

- **OpenCode / GLM** — never host the vendor CLI directly inside a herdr-spawned process; doing so breaks the CLI call. Run it as a plain background subprocess, and open a separate decoupled monitor pane purely for observability (banner + prompt + live-tailed progress) that never touches the actual process.

For any future pane or cleanup code, write the ledger truth (`record_exit`/`recordExit` or equivalent) before closing any pane or cleaning up. Never let a pane-close failure prevent the ledger write; under `set -e`, an unguarded nonzero from cleanup can abort dispatch before the exit is recorded and leave a successful task running forever in the ledger.

## Standalone reviews (`review-dispatch.sh`) have the same live-progress panes as worker dispatch

`review-dispatch.sh`/`review-dispatch.ts` — used for one-off cross-vendor reviews, not full task dispatch — used to redirect the entire vendor command's output straight to a file with nothing tailed into the pane, so a genuinely active Codex or Kimi review looked identical to a hung one: banner only, then silence until it finished. This is now fixed: Codex/Kimi review panes live-tail the same way worker panes do, reusing the review's own `.raw` NDJSON capture as the source (no separate capture file needed). Claude/OpenCode reviewer panes are unchanged (banner only, matching their worker-dispatch behavior).

This live-tail wrapper is used ONLY for an actual successful pane launch. The inline/fallback path (herdr disabled, or a pane launch fails) always uses the plain wrapper — nothing polls the progress file when there is no pane to show it in, so giving codex/kimi the live wrapper there would spawn a pointless background `tail` process for no observer.

If a review pane looks empty for its whole run, check `HYDRA_HERDR_PANES` is actually `1` and a pane genuinely launched (`herdr_pane_started` in the ledger) before assuming a hang — `status.sh` doesn't apply to `review-dispatch.sh` calls (no task spec), so tail the raw session file directly instead: `${XDG_STATE_HOME:-$HOME/.local/state}/<repo-id>-hydra/runs/run-<id>/sessions/<review_id>.<vendor>.raw`.

The bash implementation's live-tail wrapper backgrounds `tail` via process substitution (`tail ... > >(jq ...) &`), not a pipe (`tail ... | jq ... &`) — a pipe would make `$!` capture the pipeline's LAST command (`jq`), not `tail`'s, so a cleanup `kill $TPID` would leave `tail -f` running forever, orphaned. Mirror this pattern, not a plain pipe, in any future bash live-tail wrapper.
