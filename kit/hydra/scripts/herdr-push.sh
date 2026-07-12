#!/usr/bin/env bash
# hydra/scripts/herdr-push.sh — Layer-1 live monitor feed (Wave 2, build-with-note).
#
# roadmap Wave 2: herdr as a Layer-1 LIVE monitor. NORMATIVE: the harness PUSHES
# pane state derived from LEDGER EVENTS — it never treats herdr's output-scraping
# as truth. Live state is ADVISORY; Git + ledger win; a disagreement is itself an
# anomaly event (recorded, not obeyed).
#
# herdr is not installed in this environment, so this script builds the
# authoritative pane-state payload FROM the ledger and, if a herdr socket is
# present, pushes it; otherwise it writes the payload to a fallback file and logs
# that herdr is absent. The mapping (ledger -> pane) is the point; the transport
# is swappable.
#
# Usage: herdr-push.sh <run_id>

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

run_id="${1:?usage: herdr-push.sh <run_id>}"
run_dir="$(hydra_run_dir "$run_id")"
ledger="$run_dir/authoritative/ledger/events.jsonl"
[ -f "$ledger" ] || hydra_die "no ledger for run $run_id"

# Derive per-task pane state FROM THE LEDGER (authoritative), not from panes.
panes="$(jq -sc '
  (map(select(.event=="task_started")) | map({(.task_id): .vendor}) | add // {}) as $vend
  | (group_by(.task_id // "run")
     | map({ task: (.[0].task_id // "run"),
             vendor: ($vend[(.[0].task_id // "")] // "-"),
             state: (map(.event) | last),
             promoted: (any(.event=="result_promoted")),
             rejected: (any(.event=="result_rejected")) }))
' "$ledger")"

if command -v herdr >/dev/null 2>&1 && [ -n "${HERDR_SOCKET:-}" ]; then
  printf '%s' "$panes" | herdr push --socket "$HERDR_SOCKET" --run "$run_id" >/dev/null 2>&1 \
    && hydra_log "pushed pane state to herdr ($HERDR_SOCKET)" \
    || hydra_warn "herdr push failed; live state is advisory, ledger remains authoritative"
else
  fallback="$run_dir/authoritative/herdr-panes.json"
  printf '%s\n' "$panes" >"$fallback"
  hydra_warn "herdr not installed / no HERDR_SOCKET — pane state written to $fallback (advisory only)"
fi
printf '%s\n' "$panes"
