#!/usr/bin/env bash
# hydra/scripts/record-usage.sh — budget/usage accounting as ledger events.
#
# roadmap Wave 1: "Timeouts, concurrency caps, and budget accounting as ledger
# events." Parses the vendor-specific session capture an adapter left in
# sessions/ and records normalized usage to:
#   - agents/usage.jsonl  (append-only, state-and-worktrees Domain 2)
#   - the run ledger       (agent_usage event)
# Then enforces the run's MANUAL cap (Wave 0 scope kept a manual cap; here we
# make it observable). Over-cap emits a budget_exceeded event — advisory in
# Wave 1 (the lead decides), never a silent hard stop.
#
# Usage: record-usage.sh <run_id> <task_id> <vendor> <agent_run_id>

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
HYDRA_NODE="$(hydra_resolve_node)"
exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/record-usage.ts" "$@"
fi

run_id="${1:?}"; task_id="${2:?}"; vendor="${3:?}"; agent_run_id="${4:?}"
run_dir="$(hydra_run_dir "$run_id")"
sessions="$run_dir/sessions"

cost=0; tokens_in=0; tokens_out=0

case "$vendor" in
  claude)
    cli="$sessions/$agent_run_id.cli.json"
    [ -f "$cli" ] || exit 0
    cost="$(jq -r '(.total_cost_usd // .cost_usd // 0)' "$cli" 2>/dev/null || echo 0)"
    tokens_in="$(jq -r '(.usage.input_tokens // 0)' "$cli" 2>/dev/null || echo 0)"
    tokens_out="$(jq -r '(.usage.output_tokens // 0)' "$cli" 2>/dev/null || echo 0)"
    ;;
  codex)
    cli="$sessions/$agent_run_id.cli.jsonl"
    [ -f "$cli" ] || exit 0
    # Codex token_count events carry cumulative usage; take the last.
    tokens_in="$(jq -rs 'map(.. | .input_tokens? // empty) | last // 0' "$cli" 2>/dev/null || echo 0)"
    tokens_out="$(jq -rs 'map(.. | .output_tokens? // empty) | last // 0' "$cli" 2>/dev/null || echo 0)"
    ;;
  opencode)
    sess="$sessions/$agent_run_id.session.json"
    [ -f "$sess" ] || exit 0
    cost="$(jq -r '(.cost // 0)' "$sess" 2>/dev/null || echo 0)"
    tokens_in="$(jq -r '(.tokens.input // 0)' "$sess" 2>/dev/null || echo 0)"
    tokens_out="$(jq -r '(.tokens.output // 0)' "$sess" 2>/dev/null || echo 0)"
    ;;
esac

# agents/usage.jsonl (append-only, state root level).
usage_log="$(hydra_state_root)/agents/usage.jsonl"
mkdir -p "$(dirname "$usage_log")"
jq -cn --arg time "$(hydra_now)" --arg run "$run_id" --arg task "$task_id" \
  --arg vendor "$vendor" --arg aid "$agent_run_id" \
  --argjson cost "${cost:-0}" --argjson ti "${tokens_in:-0}" --argjson to "${tokens_out:-0}" \
  '{time:$time, event:"dispatch", run_id:$run, task_id:$task, vendor:$vendor,
    agent_run_id:$aid, cost_usd:$cost, tokens_in:$ti, tokens_out:$to}' >>"$usage_log"

hydra_ledger_append "$run_id" agent_usage task_id "$task_id" vendor "$vendor" \
  cost_usd "$cost" tokens_in "$tokens_in" tokens_out "$tokens_out"

# Manual run cap check (advisory).
cap="$(hydra_yaml_scalar "$run_dir/run.yaml" 'manual_cap_usd')"
if [ -n "$cap" ]; then
  spent="$(jq -rs 'map(.cost_usd // 0) | add // 0' "$usage_log" 2>/dev/null || echo 0)"
  over="$(awk -v s="$spent" -v c="$cap" 'BEGIN{print (s>c)?1:0}')"
  if [ "$over" = 1 ]; then
    hydra_ledger_append "$run_id" budget_exceeded spent_usd "$spent" cap_usd "$cap"
    hydra_warn "MANUAL CAP EXCEEDED: spent \$$spent > cap \$$cap (advisory)"
  fi
fi
