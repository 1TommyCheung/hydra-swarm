# Vendor dispatch notes

Keep `HYDRA_HERDR_PANES=1` as a recommended operating default. The harness treats pane hosting as strictly opt-in (`HYDRA_HERDR_PANES=1` must be set explicitly; unset does not enable it). Herdr pane hosting is reliable for all four vendors since the OpenCode monitor-pane fix; do not reflexively unset it.

Allow `dispatch.sh` to choose the hosting shape automatically per vendor:

- **Claude / Codex / Kimi** — host directly inside a herdr pane via the `bash -lc "echo $$>pidfile; adapter...; printf rc>sentinel"` wrapper.
  - **Codex** — rely on the live JSONL tail for pane progress.
  - **Kimi** — require srt sandbox confinement; `-p` auto-approves tools, so an OS sandbox is mandatory. Rely on the live NDJSON stdout tail for pane progress, parsed through `kimiEventText()` from the `.cli.jsonl` capture, the same mechanism Codex uses.
  - **Claude** — remember that `-p --output-format json` is not a streaming format; the pane shows only the banner, not a live body.

- **OpenCode / GLM** — never host the vendor CLI directly inside a herdr-spawned process; doing so breaks the CLI call. Run it as a plain background subprocess, and open a separate decoupled monitor pane purely for observability (banner + prompt + live-tailed progress) that never touches the actual process.

For any future pane or cleanup code, write the ledger truth (`record_exit`/`recordExit` or equivalent) before closing any pane or cleaning up. Never let a pane-close failure prevent the ledger write; under `set -e`, an unguarded nonzero from cleanup can abort dispatch before the exit is recorded and leave a successful task running forever in the ledger.
