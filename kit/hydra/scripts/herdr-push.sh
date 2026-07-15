#!/usr/bin/env bash
# hydra/scripts/herdr-push.sh — Layer-1 live monitor feed (Wave 2).
#
# roadmap Wave 2: herdr as a Layer-1 LIVE monitor. NORMATIVE RULES:
#   - The harness PUSHES pane state derived from LEDGER EVENTS.
#   - Worker output / pane text is NEVER read as truth (no output-scraping).
#   - Live state is ADVISORY; Git + the ledger WIN.
#   - A disagreement between the live view and the ledger is itself an ANOMALY
#     EVENT — recorded, not obeyed.
#   - Non-goal: herdr must not own dispatch / worktrees / task lifecycle. It is a
#     terminal workspace (a view), not the orchestrator.
#
# Real herdr API (0.7.x, socket at ~/.config/herdr/herdr.sock):
#   herdr agent list                       -> live agents + agent_status
#   herdr pane rename <pane_id> <label>    -> push a ledger-derived label
#   herdr notification show <title> --body -> push a ledger-derived event
#   herdr api snapshot                     -> full live runtime state
#
# Usage:
#   herdr-push.sh <run_id> [--notify]
#     --notify: also raise a herdr notification for the latest significant event.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" herdr-push "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" herdr-push "$@"
fi

run_id="${1:?usage: herdr-push.sh <run_id> [--notify]}"
notify="${2:-}"
run_dir="$(hydra_run_dir "$run_id")"
ledger="$run_dir/authoritative/ledger/events.jsonl"
[ -f "$ledger" ] || hydra_die "no ledger for run $run_id"

# --- 1. Derive state FROM THE LEDGER (authoritative) ------------------------
panes="$(jq -sc '
  (map(select(.event=="task_started")) | map({(.task_id): .vendor}) | add // {}) as $vend
  | [ group_by(.task_id // "run")[]
      | select(.[0].task_id != null)
      | { task: .[0].task_id,
          vendor: ($vend[.[0].task_id] // "-"),
          last_event: (map(.event) | last),
          promoted: (any(.[]; .event=="result_promoted")),
          rejected: (any(.[]; .event=="result_rejected")),
          running: ((map(select(.event=="task_started")) | length)
                    > (map(select(.event=="agent_exited" or .event=="agent_timed_out"
                                  or .event=="agent_cancelled")) | length)) } ]
' "$ledger")"

n_promoted="$(jq '[.[]|select(.promoted)]|length' <<<"$panes")"
n_running="$(jq '[.[]|select(.running)]|length' <<<"$panes")"
summary="hydra $run_id · ${n_promoted} promoted · ${n_running} running"

if ! command -v herdr >/dev/null 2>&1 || ! herdr status >/dev/null 2>&1; then
  fallback="$run_dir/authoritative/herdr-panes.json"
  printf '%s\n' "$panes" >"$fallback"
  hydra_warn "herdr not running — pane state written to $fallback (advisory only)"
  printf '%s\n' "$panes"; exit 0
fi

# --- 2. Push ledger-derived state into the live view ------------------------
# Label THIS LEAD's pane — the one running the lead agent in the repo — not
# whatever pane happens to be focused (which may belong to another workspace).
repo_root="$(hydra_repo_root)"
lead_pane="$(herdr pane list 2>/dev/null | jq -r --arg root "$repo_root" \
  '.result.panes[] | select(.agent != null and .cwd == $root) | .pane_id' | head -1)"
[ -n "$lead_pane" ] || lead_pane="${HYDRA_HERDR_PANE:-}"
if [ -n "$lead_pane" ]; then
  herdr pane rename "$lead_pane" "$summary" >/dev/null 2>&1 \
    && hydra_log "pushed pane label -> $lead_pane: $summary"
else
  hydra_warn "no lead pane identified; skipping pane label (notification still sent)"
fi

if [ "$notify" = "--notify" ]; then
  last="$(jq -sr 'last | "\(.event) \(.task_id // "")"' "$ledger")"
  sound=done
  jq -e -s 'last | .event=="result_rejected" or .status=="failed"' "$ledger" >/dev/null 2>&1 && sound=request
  herdr notification show "Hydra run $run_id" --body "$last · $summary" --sound "$sound" >/dev/null 2>&1 \
    && hydra_log "pushed notification: $last"
fi

# --- 3. Reconcile live view vs ledger; disagreement = ANOMALY EVENT ---------
# We compare only what herdr can legitimately tell us (agent_status per cwd) with
# what the LEDGER says is running. We never read pane TEXT as evidence.
live="$(herdr agent list 2>/dev/null | jq -c '[.result.agents[] | {cwd, status: .agent_status}]' 2>/dev/null || echo '[]')"
anomalies=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  task="$(jq -r '.task' <<<"$t")"
  ledger_running="$(jq -r '.running' <<<"$t")"
  spec="$run_dir/tasks/$task.yaml"
  wt="$( [ -f "$spec" ] && hydra_yaml_scalar "$spec" 'worktree' || echo '')"
  [ -n "$wt" ] || continue
  live_working="$(jq -r --arg wt "$wt" 'any(.[]; .cwd==$wt and .status=="working")' <<<"$live")"
  if [ "$ledger_running" != "$live_working" ]; then
    hydra_ledger_append "$run_id" observability_anomaly task_id "$task" \
      ledger_running "$ledger_running" live_working "$live_working" \
      note "live view disagrees with ledger; ledger is authoritative"
    hydra_warn "ANOMALY [$task]: ledger running=$ledger_running but herdr working=$live_working (ledger wins)"
    anomalies=$((anomalies + 1))
  fi
done < <(jq -c '.[]' <<<"$panes")

hydra_log "herdr push complete ($summary; $anomalies anomalies)"
printf '%s\n' "$panes"
